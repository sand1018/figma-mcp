/**
 * analyzer.ts — semantic-analyze 核心逻辑
 *
 * 从 semantic-analyze.mjs v3.1 完整移植
 *
 * 输入: metadata.xml(string) + design-context.txt(string)
 * 输出: 结构化 JSON
 *
 * 三件事：
 * 1. 容器聚合 — 基于空间包含关系把子元素归入容器
 * 2. 精确样式 — 每个元素的 CSS 值、文本、资源 URL
 * 3. 重复标记 — 标记结构相同的元素组
 */

// ═══════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════

interface Bounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface XmlNode {
  id: string;
  type: string;
  name: string | null;
  bounds: Bounds;
}

interface MergedNode extends XmlNode {
  text: string | null;
  css: Record<string, string> | null;
  inlineStyle: string | null;
  src: string | null;
}

interface Group {
  containerId: string | null;
  container: MergedNode | null;
  children: MergedNode[];
  bounds: Bounds;
}

interface AssetInfo {
  variable: string;
  url: string;
  type: string;
  semanticId: string;
  usedBy: { nodeId: string; name: string | null }[];
}

// ═══════════════════════════════════════════════════════════
// 工具函数
// ═══════════════════════════════════════════════════════════

const rd = (n: number): number => Math.round(n);

/** a 是否完整包含 b（带容差） */
function contains(a: Bounds, b: Bounds, tol = 4): boolean {
  return (
    b.x >= a.x - tol &&
    b.y >= a.y - tol &&
    b.x + b.w <= a.x + a.w + tol &&
    b.y + b.h <= a.y + a.h + tol
  );
}

function area(b: Bounds): number {
  return b.w * b.h;
}

function getBounds(items: { bounds: Bounds }[]): Bounds {
  const bs = items.map((i) => i.bounds).filter(Boolean);
  if (!bs.length) return { x: 0, y: 0, w: 0, h: 0 };
  const xs = bs.map((b) => b.x);
  const ys = bs.map((b) => b.y);
  const xEnds = bs.map((b) => b.x + b.w);
  const yEnds = bs.map((b) => b.y + b.h);
  return {
    x: Math.min(...xs),
    y: Math.min(...ys),
    w: Math.max(...xEnds) - Math.min(...xs),
    h: Math.max(...yEnds) - Math.min(...ys),
  };
}

// ═══════════════════════════════════════════════════════════
// 步骤 1: 解析 metadata.xml
// ═══════════════════════════════════════════════════════════

function parseXml(xml: string): XmlNode[] {
  const nodes: XmlNode[] = [];

  // 清理尾部非 XML 内容（Figma MCP 有时追加提示文本）
  const lastCloseIdx = xml.lastIndexOf("</");
  if (lastCloseIdx !== -1) {
    const endTagIdx = xml.indexOf(">", lastCloseIdx);
    if (endTagIdx !== -1) xml = xml.substring(0, endTagIdx + 1);
  }

  function parseAttrs(attrStr: string): Record<string, string> {
    const attrs: Record<string, string> = {};
    const re = /([\w-]+)="([^"]*)"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(attrStr)) !== null) attrs[m[1]] = m[2];
    return attrs;
  }

  function makeNode(type: string, attrs: Record<string, string>): XmlNode | null {
    if (!attrs.id) return null;
    return {
      id: attrs.id,
      type,
      name: attrs.name || null,
      bounds: {
        x: rd(parseFloat(attrs.x) || 0),
        y: rd(parseFloat(attrs.y) || 0),
        w: rd(parseFloat(attrs.width) || 0),
        h: rd(parseFloat(attrs.height) || 0),
      },
    };
  }

  for (const line of xml.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("</") || trimmed.startsWith("IMPORTANT"))
      continue;

    // 自闭合 <type ... />
    const selfClose = trimmed.match(/^<([\w-]+)\s+(.*?)\s*\/>$/);
    if (selfClose) {
      const node = makeNode(selfClose[1], parseAttrs(selfClose[2]));
      if (node) nodes.push(node);
      continue;
    }

    // 开始标签 <type ...>
    const openTag = trimmed.match(/^<([\w-]+)\s+(.*?)>$/);
    if (openTag) {
      const node = makeNode(openTag[1], parseAttrs(openTag[2]));
      if (node) nodes.push(node);
    }
  }

  return nodes;
}

// ═══════════════════════════════════════════════════════════
// 步骤 2: 解析 design-context.txt → 样式 Map
// ═══════════════════════════════════════════════════════════

interface StyleInfo {
  classes: string | null;
  css: Record<string, string> | null;
  inlineStyle: string | null;
  src: string | null;
  text: string | null;
}

function parseDesignContext(jsx: string): {
  styleMap: Map<string, StyleInfo>;
  constants: Map<string, string>;
} {
  const code = jsx.split(/\n---\n/)[0];
  const styleMap = new Map<string, StyleInfo>();
  const constants = new Map<string, string>();

  // 资源常量
  const constRe = /const\s+(\w+)\s*=\s*"([^"]+)"/g;
  let cm: RegExpExecArray | null;
  while ((cm = constRe.exec(code)) !== null) constants.set(cm[1], cm[2]);

  // 每个 data-node-id 的信息
  const nodeRe = /data-node-id="([^"]+)"/g;
  let m: RegExpExecArray | null;

  while ((m = nodeRe.exec(code)) !== null) {
    try {
      const id = m[1];

      // 向前找标签开始 '<'
      let start = m.index;
      let safeguard = 0;
      while (start > 0 && code[start] !== "<" && safeguard < 5000) {
        start--;
        safeguard++;
      }

      // 向后找标签结束 '>'
      let end = m.index + m[0].length;
      let depth = 0;
      safeguard = 0;
      while (end < code.length && safeguard < 10000) {
        if (code[end] === "{") depth++;
        else if (code[end] === "}") depth--;
        else if (code[end] === ">" && depth === 0) {
          end++;
          break;
        }
        end++;
        safeguard++;
      }

      if (end >= code.length) continue;

      const tagStr = code.substring(start, end);
      const selfClosing = tagStr.trimEnd().endsWith("/>");

      // className
      const clsM = tagStr.match(/className="([^"]+)"/);

      // style={{ ... }}
      let inlineStyle: string | null = null;
      const si = tagStr.indexOf("style={{");
      if (si !== -1) {
        let p = si + 8,
          d = 1,
          se = p;
        safeguard = 0;
        while (se < tagStr.length && d > 0 && safeguard < 5000) {
          if (tagStr[se] === "{") d++;
          else if (tagStr[se] === "}") d--;
          se++;
          safeguard++;
        }
        if (d === 0) {
          inlineStyle = tagStr
            .substring(p, se - 1)
            .trim()
            .replace(/\}\s*as\s*React\.CSSProperties/, "")
            .trim();
        }
      }

      // src={varName} — 当前标签上
      const srcM = tagStr.match(/src=\{(\w+)\}/);

      // 文本内容
      let text: string | null = null;
      let closePos = -1;
      if (!selfClosing) {
        let scanPos = end,
          nest = 1;
        safeguard = 0;
        while (scanPos < code.length && nest > 0 && safeguard < 50000) {
          if (code[scanPos] === "<") {
            if (code[scanPos + 1] === "/") {
              nest--;
              if (nest === 0) {
                closePos = scanPos;
                break;
              }
              while (scanPos < code.length && code[scanPos] !== ">") scanPos++;
            } else {
              let pe = scanPos + 1,
                pd = 0;
              let innerGuard = 0;
              while (pe < code.length && innerGuard < 10000) {
                if (code[pe] === "{") pd++;
                else if (code[pe] === "}") pd--;
                else if (code[pe] === ">" && pd === 0) {
                  pe++;
                  break;
                }
                pe++;
                innerGuard++;
              }
              if (!code.substring(scanPos, pe).trimEnd().endsWith("/>")) nest++;
              scanPos = pe - 1;
            }
          }
          scanPos++;
          safeguard++;
        }
        if (closePos !== -1) {
          text =
            code
              .substring(end, closePos)
              .replace(/<[^>]*>/g, "")
              .replace(/\{`([^`]*)`\}/g, "$1")
              .replace(/\{[^}]*\}/g, "")
              .replace(/\s+/g, " ")
              .trim() || null;
        }
      }

      // 解析 className 为 CSS
      const css = clsM ? parseTailwind(clsM[1]) : null;

      // 解析 src
      let src = srcM ? constants.get(srcM[1]) || srcM[1] : null;

      // 如果当前标签没有 src，从子内容中找 <img src={...} />
      if (!src && !selfClosing && closePos !== -1) {
        const innerContent = code.substring(end, closePos);
        const innerSrcM = innerContent.match(/src=\{(\w+)\}/);
        if (innerSrcM) {
          src = constants.get(innerSrcM[1]) || innerSrcM[1];
        }
      }

      styleMap.set(id, {
        classes: clsM?.[1] || null,
        css,
        inlineStyle,
        src,
        text,
      });
    } catch {
      // 单个节点解析失败不影响整体
    }
  }

  return { styleMap, constants };
}

// ═══════════════════════════════════════════════════════════
// Tailwind 解析
// ═══════════════════════════════════════════════════════════

type TwRule = [RegExp, (s: Record<string, string>, m: RegExpMatchArray) => void];

const TW_RULES: TwRule[] = [
  [/^bg-white$/, (s) => { s.background = "#fff"; }],
  [/^bg-\[(.+)\]$/, (s, m) => { s.background = m[1]; }],
  [/^text-\[(#[0-9a-fA-F]+)\]$/, (s, m) => { s.color = m[1]; }],
  [/^text-\[(\d.+)\]$/, (s, m) => { s.fontSize = m[1]; }],
  [/^text-white$/, (s) => { s.color = "#fff"; }],
  [/^text-black$/, (s) => { s.color = "#000"; }],
  [/^text-center$/, (s) => { s.textAlign = "center"; }],
  [/^rounded-\[(.+)\]$/, (s, m) => { s.borderRadius = m[1]; }],
  [/^shadow-\[(.+)\]$/, (s, m) => { s.boxShadow = m[1].replace(/_/g, " "); }],
  [/^h-\[(.+)\]$/, (s, m) => { s.height = m[1]; }],
  [/^w-\[(.+)\]$/, (s, m) => { s.width = m[1]; }],
  [/^size-\[(.+)\]$/, (s, m) => { s.width = m[1]; s.height = m[1]; }],
  [/^font-normal$/, (s) => { s.fontWeight = "400"; }],
  [/^font-medium$/, (s) => { s.fontWeight = "500"; }],
  [/^font-semibold$/, (s) => { s.fontWeight = "600"; }],
  [/^font-bold$/, (s) => { s.fontWeight = "700"; }],
  [/^font-\['(.+)'\]$/, (s, m) => { s.fontFamily = m[1]; }],
  [/^leading-\[(.+)\]$/, (s, m) => { s.lineHeight = m[1]; }],
  [/^backdrop-blur-\[(.+)\]$/, (s, m) => { s.backdropFilter = `blur(${m[1]})`; }],
  [/^opacity-(\d+)$/, (s, m) => { s.opacity = String(parseInt(m[1]) / 100); }],
  [/^border-\[(#.+|rgba?.+)\]$/, (s, m) => { s.borderColor = m[1]; }],
  [/^border-(\d.*)$/, (s, m) => { if (!m[1].includes("solid")) s.borderWidth = m[1]; }],
  [/^border-solid$/, (s) => { s.borderStyle = "solid"; }],
  [/^tracking-\[(.+)\]$/, (s, m) => { s.letterSpacing = m[1]; }],
  [/^p-\[(.+)\]$/, (s, m) => { s.padding = m[1]; }],
  [/^px-\[(.+)\]$/, (s, m) => { s.paddingLeft = m[1]; s.paddingRight = m[1]; }],
  [/^py-\[(.+)\]$/, (s, m) => { s.paddingTop = m[1]; s.paddingBottom = m[1]; }],
  [/^gap-\[(.+)\]$/, (s, m) => { s.gap = m[1]; }],
  [/^overflow-hidden$/, (s) => { s.overflow = "hidden"; }],
];

function parseTailwind(cls: string): Record<string, string> | null {
  if (!cls) return null;
  const s: Record<string, string> = {};
  for (const c of cls.split(/\s+/)) {
    if (!c) continue;
    for (const [re, fn] of TW_RULES) {
      const match = c.match(re);
      if (match) {
        fn(s, match);
        break;
      }
    }
  }
  return Object.keys(s).length > 0 ? s : null;
}

// ═══════════════════════════════════════════════════════════
// 步骤 3: 合并 + 过滤
// ═══════════════════════════════════════════════════════════

function mergeNodesWithStyles(
  xmlNodes: XmlNode[],
  styleMap: Map<string, StyleInfo>,
): MergedNode[] {
  return xmlNodes.map((node) => {
    const style = styleMap.get(node.id);
    return {
      ...node,
      text: style?.text || null,
      css: style?.css || null,
      inlineStyle: style?.inlineStyle || null,
      src: style?.src || null,
    };
  });
}

function filterNodes(nodes: MergedNode[]): MergedNode[] {
  if (!nodes.length) return [];
  const rootNode = nodes[0];
  return nodes.filter((n) => {
    if (n === rootNode) return false;
    if (n.name === "蒙版" && !n.css?.background) return false;
    if (n.bounds && n.bounds.w < 3 && n.bounds.h < 3) return false;
    return true;
  });
}

// ═══════════════════════════════════════════════════════════
// 步骤 4: 容器聚合（确定性 — 基于空间包含关系）
// ═══════════════════════════════════════════════════════════

function groupByContainers(nodes: MergedNode[]): {
  groups: Group[];
  remaining: MergedNode[];
} {
  if (!nodes.length) return { groups: [], remaining: [] };

  const containers = nodes.filter((n) => {
    if (n.type !== "rounded-rectangle") return false;
    if (!n.css || !n.bounds) return false;
    return (n.css.background || n.css.boxShadow) && area(n.bounds) > 500;
  });

  containers.sort((a, b) => area(a.bounds) - area(b.bounds));

  const assigned = new Set<string>();
  const groups: Group[] = [];

  for (const container of containers) {
    if (assigned.has(container.id)) continue;
    const children = nodes.filter(
      (n) =>
        n.id !== container.id &&
        !assigned.has(n.id) &&
        n.bounds &&
        contains(container.bounds, n.bounds),
    );
    if (children.length > 0) {
      groups.push({
        containerId: container.id,
        container,
        children,
        bounds: { ...container.bounds },
      });
      assigned.add(container.id);
      children.forEach((c) => assigned.add(c.id));
    }
  }

  const remaining = nodes.filter((n) => !assigned.has(n.id));
  return { groups, remaining };
}

// ═══════════════════════════════════════════════════════════
// 步骤 5: 剩余节点按空间邻近度聚类
// ═══════════════════════════════════════════════════════════

function clusterRemaining(remaining: MergedNode[]): Group[] {
  if (remaining.length === 0) return [];
  const sorted = [...remaining].sort(
    (a, b) => (a.bounds?.y || 0) - (b.bounds?.y || 0),
  );
  const clusters: MergedNode[][] = [];
  let current = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const curr = sorted[i];
    if (!curr.bounds) {
      current.push(curr);
      continue;
    }

    const clusterBounds = getBounds(current);
    const lastBounds = current[current.length - 1].bounds;
    const yOverlap = curr.bounds.y < clusterBounds.y + clusterBounds.h + 25;
    const sameRow =
      lastBounds && Math.abs(curr.bounds.y - lastBounds.y) < 20;

    if (yOverlap || sameRow) {
      current.push(curr);
    } else {
      clusters.push(current);
      current = [curr];
    }
  }
  clusters.push(current);

  return clusters.map((members) => ({
    containerId: null,
    container: null,
    children: members,
    bounds: getBounds(members),
  }));
}

// ═══════════════════════════════════════════════════════════
// 步骤 6: 布局推断（确定性 — 纯坐标计算）
// ═══════════════════════════════════════════════════════════

function inferLayout(
  items: { bounds: Bounds }[],
): Record<string, unknown> | null {
  if (!items || items.length <= 1) return null;
  const bs = items.map((i) => i.bounds).filter(Boolean);
  if (bs.length <= 1) return null;

  const sortedX = [...bs].sort((a, b) => a.x - b.x);
  const sortedY = [...bs].sort((a, b) => a.y - b.y);
  const uniqueXs = [...new Set(sortedX.map((b) => Math.round(b.x / 15) * 15))];
  const uniqueYs = [...new Set(sortedY.map((b) => Math.round(b.y / 15) * 15))];

  // 网格
  if (uniqueXs.length >= 2 && uniqueYs.length >= 2 && items.length >= 4) {
    const colWidths = sortedX
      .filter((_, i) => i < uniqueXs.length)
      .map((b) => b.w);
    if (
      colWidths.length > 0 &&
      colWidths.every((w) => Math.abs(w - colWidths[0]) < 10)
    ) {
      const gap =
        sortedX.length >= 2
          ? rd(sortedX[1].x - sortedX[0].x - sortedX[0].w)
          : 0;
      return {
        type: "grid",
        columns: uniqueXs.length,
        rows: uniqueYs.length,
        gap: Math.max(0, gap),
      };
    }
  }

  // 水平
  const yRange = Math.max(...bs.map((b) => b.y)) - Math.min(...bs.map((b) => b.y));
  if (yRange < 15 && uniqueXs.length > 1) {
    const gaps: number[] = [];
    for (let i = 1; i < sortedX.length; i++) {
      gaps.push(rd(sortedX[i].x - sortedX[i - 1].x - sortedX[i - 1].w));
    }
    const avgGap =
      gaps.length > 0
        ? rd(gaps.reduce((s, g) => s + g, 0) / gaps.length)
        : 0;
    return { type: "horizontal", gap: avgGap };
  }

  // 垂直
  const xRange = Math.max(...bs.map((b) => b.x)) - Math.min(...bs.map((b) => b.x));
  if (xRange < 15 && uniqueYs.length > 1) {
    const gaps: number[] = [];
    for (let i = 1; i < sortedY.length; i++) {
      gaps.push(rd(sortedY[i].y - sortedY[i - 1].y - sortedY[i - 1].h));
    }
    const avgGap =
      gaps.length > 0
        ? rd(gaps.reduce((s, g) => s + g, 0) / gaps.length)
        : 0;
    return { type: "vertical", gap: avgGap };
  }

  return { type: "stack" };
}

// ═══════════════════════════════════════════════════════════
// 步骤 7: 结构签名（用于重复检测）
// ═══════════════════════════════════════════════════════════

function structureSignature(children: MergedNode[]): string {
  if (!children?.length) return "";
  return children
    .map((c) => {
      const b = c.bounds;
      return `${c.type}:${b ? `${b.w}x${b.h}` : "?"}`;
    })
    .sort()
    .join("|");
}

// ═══════════════════════════════════════════════════════════
// 步骤 8: 构建输出
// ═══════════════════════════════════════════════════════════

function buildElement(node: MergedNode): Record<string, unknown> {
  const el: Record<string, unknown> = {
    id: node.id,
    type: node.type,
    name: node.name,
  };
  if (node.bounds) el.bounds = node.bounds;
  if (node.text) el.text = node.text;
  if (node.css) el.style = node.css;
  if (node.inlineStyle) el.inlineStyle = node.inlineStyle;
  if (node.src) el.asset = node.src;
  return el;
}

function buildGroup(
  group: Group,
): Record<string, unknown> {
  const children = group.children.map(buildElement);
  const layout = inferLayout(group.children);
  const sig = structureSignature(group.children);

  const result: Record<string, unknown> = {
    bounds: group.bounds,
    childCount: children.length,
    elements: children,
  };

  // 容器样式
  if (group.container?.css || group.container?.inlineStyle) {
    const cs: Record<string, string> = {};
    const c = group.container!;
    if (c.css?.background) cs.background = c.css.background;
    if (c.css?.borderRadius) cs.borderRadius = c.css.borderRadius;
    if (c.css?.boxShadow) cs.boxShadow = c.css.boxShadow;
    if (c.css?.backdropFilter) cs.backdropFilter = c.css.backdropFilter;
    if (c.css?.borderColor) cs.borderColor = c.css.borderColor;
    if (c.css?.borderWidth) cs.borderWidth = c.css.borderWidth;
    if (c.css?.borderStyle) cs.borderStyle = c.css.borderStyle;
    if (c.inlineStyle) cs.inlineStyle = c.inlineStyle;
    if (Object.keys(cs).length > 0) result.containerStyle = cs;
  }

  if (layout) result.layout = layout;
  result._sig = sig;

  return result;
}

// ═══════════════════════════════════════════════════════════
// 步骤 9: 重复模式检测
// ═══════════════════════════════════════════════════════════

function detectPatterns(groups: Record<string, unknown>[]): void {
  const sigMap = new Map<string, Record<string, unknown>[]>();
  for (const g of groups) {
    const sig = g._sig as string;
    if (!sig) continue;
    if (!sigMap.has(sig)) sigMap.set(sig, []);
    sigMap.get(sig)!.push(g);
  }

  let patternId = 0;
  for (const [, matchingGroups] of sigMap) {
    if (matchingGroups.length >= 2) {
      patternId++;
      for (const g of matchingGroups) {
        g.repeatPattern = {
          id: `pattern-${patternId}`,
          count: matchingGroups.length,
          signature: g._sig,
        };
      }
    }
  }

  // 清理内部字段
  for (const g of groups) delete g._sig;
}

// ═══════════════════════════════════════════════════════════
// 资源汇总
// ═══════════════════════════════════════════════════════════

function buildAssets(
  constants: Map<string, string>,
  merged: MergedNode[],
): AssetInfo[] {
  const usageMap = new Map<
    string,
    { variable: string; usedBy: { nodeId: string; name: string | null }[] }
  >();
  for (const [varName, url] of constants) {
    usageMap.set(url, { variable: varName, usedBy: [] });
  }

  for (const node of merged) {
    if (node.src) {
      const entry = usageMap.get(node.src);
      if (entry) {
        entry.usedBy.push({ nodeId: node.id, name: node.name });
      }
    }
  }

  const assets: AssetInfo[] = [];
  for (const [url, info] of usageMap) {
    const ext =
      url.match(/\.(png|svg|jpg|jpeg|webp|gif)$/i)?.[1]?.toLowerCase() ||
      (url.includes(".svg") ? "svg" : "png");

    const usedNames = info.usedBy.map((u) => u.name).filter(Boolean);
    const baseName =
      usedNames.length > 0
        ? (usedNames[0] as string).replace(/[备份\s\d]+$/g, "").trim() ||
          info.variable
        : info.variable;
    const nodeId = info.usedBy[0]?.nodeId || "";
    const semanticId = nodeId
      ? `${baseName}_${nodeId.replace(":", "-")}`
      : baseName;

    assets.push({
      variable: info.variable,
      url,
      type: ext,
      semanticId,
      usedBy: info.usedBy,
    });
  }

  return assets;
}

// ═══════════════════════════════════════════════════════════
// 主分析入口
// ═══════════════════════════════════════════════════════════

export interface AnalyzeResult {
  page: {
    name: string;
    viewport: { width: number; height: number };
  };
  assets: AssetInfo[];
  groups: Record<string, unknown>[];
  _stats: {
    xmlNodes: number;
    styledNodes: number;
    assetCount: number;
    assetsLinked: number;
    containerGroups: number;
    clusterGroups: number;
    totalGroups: number;
    repeatPatterns: number;
  };
}

export function analyze(xmlContent: string, ctxContent: string): AnalyzeResult {
  // 1. 解析
  const xmlNodes = parseXml(xmlContent);
  const { styleMap, constants } = parseDesignContext(ctxContent);

  // 2. 合并 + 过滤
  const merged = mergeNodesWithStyles(xmlNodes, styleMap);
  const filtered = filterNodes(merged);

  // 3. 容器聚合
  const { groups, remaining } = groupByContainers(filtered);

  // 4. 二次聚类
  const additionalGroups = clusterRemaining(remaining);

  // 5. 构建输出
  const allGroups = [...groups, ...additionalGroups];
  const builtGroups = allGroups.map(buildGroup);
  builtGroups.sort(
    (a, b) => (a.bounds as Bounds).y - (b.bounds as Bounds).y,
  );

  // 6. 重复检测
  detectPatterns(builtGroups);
  const repeatCount = builtGroups.filter((g) => g.repeatPattern).length;

  // 7. 资源汇总
  const allAssets = buildAssets(constants, merged);

  return {
    page: {
      name: xmlNodes[0]?.name || "Unknown",
      viewport: {
        width: xmlNodes[0]?.bounds?.w || 375,
        height: xmlNodes[0]?.bounds?.h || 0,
      },
    },
    assets: allAssets,
    groups: builtGroups,
    _stats: {
      xmlNodes: xmlNodes.length,
      styledNodes: styleMap.size,
      assetCount: allAssets.length,
      assetsLinked: allAssets.filter((a) => a.usedBy.length > 0).length,
      containerGroups: groups.length,
      clusterGroups: additionalGroups.length,
      totalGroups: builtGroups.length,
      repeatPatterns: repeatCount,
    },
  };
}
