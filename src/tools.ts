import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { execSync } from "node:child_process";
import { initFigmaMcp, callFigmaTool, type FigmaContent } from "./figma-mcp.js";
import { analyze } from "./analyzer.js";
import {
  NodeIdSchema,
  DownloadAssetsSchema,
  type NodeIdInput,
  type DownloadAssetsInput,
} from "./schemas.js";

// ── 常量 ──

const FIGMA_ENDPOINT = "http://127.0.0.1:3845/mcp";
const FRAMEWORK = "react"; // Figma MCP 需要的参数
const LANG = "typescript,css";
const TIMEOUT_MS = 300_000;

// ── 类型 ──

type McpContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

// ── 连接管理 ──

let _initialized = false;

async function ensureInit() {
  if (!_initialized) {
    await initFigmaMcp(FIGMA_ENDPOINT);
    _initialized = true;
  }
}

// ── Figma 原生工具调用 ──

async function fetchRaw(
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ content: FigmaContent[] }> {
  await ensureInit();
  return callFigmaTool(FIGMA_ENDPOINT, toolName, args, TIMEOUT_MS);
}

// ── 常用数据获取封装 ──

async function fetchMetadata(nodeId: string): Promise<string> {
  const result = await fetchRaw("get_metadata", {
    nodeId,
    clientLanguages: LANG,
    clientFrameworks: FRAMEWORK,
  });
  return result.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

/**
 * 获取 Figma MCP 的 design-context，并裁剪掉 Figma 注入的提示词噪音。
 * Figma MCP 会在文本末尾追加 "\n---\n\nSUPER CRITICAL:" 或类似的 AI 提示段落，
 * 这些内容对结构化语义分析毫无意义，统一截断。
 */
async function fetchDesignContext(
  nodeId: string,
  forceCode?: boolean,
  artifactType?: string,
): Promise<{ texts: string[]; images: FigmaContent[] }> {
  const args: Record<string, unknown> = {
    nodeId,
    clientLanguages: LANG,
    clientFrameworks: FRAMEWORK,
  };
  if (forceCode) args.forceCode = true;
  if (artifactType) args.artifactType = artifactType;

  const result = await fetchRaw("get_design_context", args);

  // 截断 Figma MCP 注入的提示词噪音
  const NOISE_MARKERS = [
    "\n---\n\nSUPER CRITICAL:",
    "\n---\n\nCRITICAL:",
    "\n---\n\nIMPORTANT:",
  ];

  return {
    texts: result.content.filter((c) => c.type === "text").map((c) => {
      let text = c.text!;
      for (const marker of NOISE_MARKERS) {
        const idx = text.indexOf(marker);
        if (idx !== -1) {
          text = text.substring(0, idx);
        }
      }
      return text.trimEnd();
    }),
    images: result.content.filter((c) => c.type === "image"),
  };
}

async function fetchScreenshot(nodeId: string): Promise<FigmaContent[]> {
  const result = await fetchRaw("get_screenshot", {
    nodeId,
    clientLanguages: LANG,
    clientFrameworks: FRAMEWORK,
  });
  return result.content.filter((c) => c.type === "image");
}

async function fetchVariables(nodeId: string): Promise<string> {
  const result = await fetchRaw("get_variable_defs", {
    nodeId,
    clientLanguages: LANG,
    clientFrameworks: FRAMEWORK,
  });
  return result.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

// ── 错误包装 ──

function withErrorHandling<T>(
  fn: (params: T) => Promise<{ content: McpContent[] }>,
) {
  return async (params: T) => {
    try {
      return await fn(params);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: `❌ 错误: ${msg}` }],
      };
    }
  };
}

// ── 只读标注（共用） ──

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

// ══════════════════════════════════════════════════════════════
// 工具注册
// ══════════════════════════════════════════════════════════════

export function registerTools(server: McpServer): void {
  // ────────────────────────────────────────
  // 工具 1: 获取设计上下文（结构化分析 + 截图）▶ 主入口
  // ────────────────────────────────────────
  server.registerTool(
    "figma_get_page_context",
    {
      title: "获取 Figma 页面完整上下文",
      description: `获取指定 Figma 节点的完整设计上下文，包括：
1. 截图（image 类型，直接可视）
2. 结构化语义分析 JSON（容器聚合、精确样式、重复模式检测）
3. 资源列表（所有图片 URL）

这是还原 Figma 设计稿的主入口。输出完整的结构化数据，包含精确的 CSS 值、文本内容、
图片资源 URL、容器层级关系、布局方向和重复模式标记。

Args:
  - node_id (string, 必填): Figma 节点 ID，如 "0:118" 或 "0-118"

Returns:
  截图 + 结构化分析 JSON，可直接用于组件还原。`,
      inputSchema: NodeIdSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    withErrorHandling(async (params: NodeIdInput) => {
      const nodeId = params.node_id.replace(/-/g, ":");
      const content: McpContent[] = [];

      // 并行获取：截图 + metadata + design-context
      const [screenshots, metadataXml, designCtx] = await Promise.all([
        fetchScreenshot(nodeId).catch(() => []),
        fetchMetadata(nodeId),
        fetchDesignContext(nodeId),
      ]);

      // 1. 截图
      for (const img of screenshots) {
        if (img.data && img.mimeType) {
          content.push({
            type: "image",
            data: img.data,
            mimeType: img.mimeType,
          });
        }
      }

      // 2. 语义分析
      const designContextText = designCtx.texts.join("\n\n---\n\n");
      const result = analyze(metadataXml, designContextText);
      content.push({
        type: "text",
        text: JSON.stringify(result),
      });

      return { content };
    }),
  );

  // ────────────────────────────────────────
  // 工具 2: 获取截图
  // ────────────────────────────────────────
  server.registerTool(
    "figma_get_screenshot",
    {
      title: "获取 Figma 节点截图",
      description: `获取指定 Figma 节点的截图 (image/png)。

Args:
  - node_id (string, 必填): Figma 节点 ID

Returns:
  截图 image。`,
      inputSchema: NodeIdSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    withErrorHandling(async (params: NodeIdInput) => {
      const nodeId = params.node_id.replace(/-/g, ":");
      const screenshots = await fetchScreenshot(nodeId);
      const content: McpContent[] = [];
      for (const img of screenshots) {
        if (img.data && img.mimeType) {
          content.push({
            type: "image",
            data: img.data,
            mimeType: img.mimeType,
          });
        }
      }
      if (!content.length)
        content.push({ type: "text", text: "未获取到截图" });
      return { content };
    }),
  );

  // ────────────────────────────────────────
  // 工具 3: 语义结构分析（不含截图）
  // ────────────────────────────────────────
  server.registerTool(
    "figma_analyze_structure",
    {
      title: "分析 Figma 节点结构",
      description: `仅获取结构化分析 JSON（不含截图）。适合在已有截图的情况下补充获取结构数据。

输出包含：容器聚合、精确 CSS 样式、布局方向推断、重复模式检测、资源 URL 列表。

Args:
  - node_id (string, 必填): Figma 节点 ID

Returns:
  结构化语义分析 JSON。`,
      inputSchema: NodeIdSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    withErrorHandling(async (params: NodeIdInput) => {
      const nodeId = params.node_id.replace(/-/g, ":");
      const [metadataXml, designCtx] = await Promise.all([
        fetchMetadata(nodeId),
        fetchDesignContext(nodeId),
      ]);
      const designContextText = designCtx.texts.join("\n\n---\n\n");
      const result = analyze(metadataXml, designContextText);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    }),
  );

  // ────────────────────────────────────────
  // 工具 4: 获取设计变量 / Token
  // ────────────────────────────────────────
  server.registerTool(
    "figma_get_variables",
    {
      title: "获取 Figma 设计变量 (Design Tokens)",
      description: `获取节点关联的设计变量定义，如颜色、间距、字体等复用值。

输出示例：
  {'icon/default/secondary': #949494, 'spacing/md': 16px}

适合提取设计系统 token。

Args:
  - node_id (string, 必填): Figma 节点 ID

Returns:
  变量定义列表。`,
      inputSchema: NodeIdSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    withErrorHandling(async (params: NodeIdInput) => {
      const nodeId = params.node_id.replace(/-/g, ":");
      const vars = await fetchVariables(nodeId);
      return {
        content: [
          {
            type: "text",
            text: vars || "该节点未关联任何设计变量",
          },
        ],
      };
    }),
  );

  // ────────────────────────────────────────
  // 工具 5: 下载设计资源到本地
  // ────────────────────────────────────────
  server.registerTool(
    "figma_download_assets",
    {
      title: "下载 Figma 设计资源到本地",
      description: `分析指定节点并将所有图片/SVG 资源下载到本地目录。

流程：
1. 获取 metadata + design-context
2. 运行语义分析，提取 assets 列表
3. 通过 localhost URL 下载每个资源文件
4. 返回下载结果摘要

Args:
  - node_id (string, 必填): Figma 节点 ID
  - out_dir (string, 必填): 资源保存目录

Returns:
  下载摘要（成功/失败数量，文件列表）。`,
      inputSchema: DownloadAssetsSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (params: DownloadAssetsInput) => {
      const nodeId = params.node_id.replace(/-/g, ":");
      const outDir = resolve(params.out_dir);

      // 1. 获取数据并分析
      const [metadataXml, designCtx, screenshots] = await Promise.all([
        fetchMetadata(nodeId),
        fetchDesignContext(nodeId),
        fetchScreenshot(nodeId).catch(() => []),
      ]);
      const designContextText = designCtx.texts.join("\n\n---\n\n");
      const result = analyze(metadataXml, designContextText);

      if (!result.assets.length) {
        return {
          content: [{ type: "text", text: "该节点未包含任何可下载的资源" }],
        };
      }

      // 2. 确保输出目录
      if (!existsSync(outDir)) {
        mkdirSync(outDir, { recursive: true });
      }

      // 3. 下载每个资源
      let downloaded = 0;
      let failed = 0;
      const files: string[] = [];

      for (const asset of result.assets) {
        if (!asset.url) continue;

        // 生成文件名
        const ext = asset.type || "png";
        const safeName = asset.semanticId
          .replace(/[^\w\u4e00-\u9fff-]/g, "_")
          .replace(/_+/g, "_")
          .substring(0, 60);
        const fileName = `${safeName}.${ext}`;
        const targetPath = join(outDir, fileName);

        try {
          mkdirSync(dirname(targetPath), { recursive: true });
          execSync(`curl -sS -o "${targetPath}" "${asset.url}"`, {
            timeout: 15000,
          });

          if (existsSync(targetPath)) {
            downloaded++;
            files.push(fileName);
          } else {
            failed++;
          }
        } catch {
          failed++;
        }
      }

      // 4. 保存整体设计稿截图
      let screenshotFile = null;
      if (screenshots.length > 0 && screenshots[0].data) {
        screenshotFile = "design-screenshot.png";
        const imgPath = join(outDir, screenshotFile);
        const imgData = Buffer.from(screenshots[0].data, "base64");
        writeFileSync(imgPath, imgData);
        files.push(screenshotFile);
      }

      // 5. 保存 semantic-tree.json 到同一目录
      const treePath = join(outDir, "semantic-tree.json");
      writeFileSync(treePath, JSON.stringify(result, null, 2), "utf-8");

      const summary = [
        `# 资源下载完成`,
        ``,
        `- 目标目录: ${outDir}`,
        `- 总资源数: ${result.assets.length}`,
        `- 下载成功: ${downloaded}`,
        `- 下载失败: ${failed}`,
        `- 分析数据: ${treePath}`,
        ``,
        `## 文件列表`,
        ...files.map((f) => `- ${f}`),
      ].join("\n");

      return { content: [{ type: "text", text: summary }] };
    }),
  );
}
