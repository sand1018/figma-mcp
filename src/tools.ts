import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { execSync } from "node:child_process";
import { initFigmaMcp, callFigmaTool, type FigmaContent } from "./figma-mcp.js";
import { analyze } from "./analyzer.js";
import {
  NodeIdSchema,
  DesignContextSchema,
  DownloadAssetsSchema,
  type NodeIdInput,
  type DesignContextInput,
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
  return {
    texts: result.content.filter((c) => c.type === "text").map((c) => c.text!),
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
// 实现指导提示生成
// ══════════════════════════════════════════════════════════════

import type { AnalyzeResult } from "./analyzer.js";

function buildImplementationGuide(result: AnalyzeResult): string {
  return `
# 💡 Agent 实现指南

这是一份由 Figma Context MCP 自动生成的结构化语义树。
**重要提示**：本工具除了下方的 JSON 语义树外，**已经随同返回了该页面的完整设计稿截图**。

请务必将「设计稿视觉截图」与「底层 JSON 结构」结合比对，进行完美的像素级代码还原。

## 1. 结构与层级
- \`groups\` 数组按照在页面中的从上到下顺序（Y坐标）排列。
- 每一个 \`group\` 代表一个**独立的 UI 区块或组件**。
- \`containerStyle\` 提供了该区块的外层容器样式（背景、倒角、阴影等）。
- \`layout\` 提供该区块内部元素的排列方式（\`horizontal\`, \`vertical\`, \`stack\`, \`grid\`）。

## 2. 样式与文本
- 元素包含精确的 Tailwind-like 或 CSS 样式对象。请直接提取 \`width/height\`, \`color\`, \`font-size\`, \`font-weight\`, \`border-radius\` 等值，**不要凭空捏造或估计像素值**。
- 元素的 \`text\` 字段是准确的文案内容，请直接使用。

## 3. 重复模式与列表
- 如果一个或多个区块带有 \`repeatPattern\` 字段，说明它们是**结构相同、仅内容不同的列表项（如卡片列表、选项卡等）**。
- **关键**：请在实现时，将这类模式提取为组件并在当前文件中通过数组和 v-for (Vue) 或 map (React) 来循环渲染，避免写死相同的 DOM 结构。

## 4. 图片与资源
- \`assets\` 数组包含本页面所有的图片/SVG 资源信息。
- 如果你需要图片资源，可以使用当前返回的截图（如果提供），或者使用 \`figma_download_assets\` 工具将它们一次性全部下载到本地代码目录中。
- 大部分资源是 \`localhost:3845\` 地址，不能直接给最终用户访问，必须作为项目文件处理。

**执行建议步骤：**
1. **结合截图理解上下文**：请先仔细观察本工具随同回传的「设计稿大图」，把它和 \`groups\` JSON 树交叉验证，在脑海中建立组件结构模型。
2. **下载所有切图资源**：然后调用 \`figma_download_assets\` 工具，将该节点的全部图片资源自动下载到项目的缓存目录 **\`.figma-cache/{node_id}\`** 中。
3. **分析整体骨架**：分析 \`groups\` 数据，确认页面的整体层级（Header, Banner, List, Footer 等）。
4. **识别还原模式**：对带有 \`repeatPattern\` 的块提取组件映射，并设计循环渲染逻辑（如 v-for 或 map）。
5. **精细样式还原**：严格参考 \`style\` 属性值（颜色、间距、字体等）还原代码。
6. **引入并整理资源**：将 \`.figma-cache/{node_id}\` 中你实际所需的图片资源，按需复制到真正的项目静态资源目录（如 \`src/assets/images\`）并正确引用。
`;
}

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

      // 3. 实现指导提示
      content.push({
        type: "text",
        text: buildImplementationGuide(result),
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
  // 工具 4: 获取原始元数据 (XML)
  // ────────────────────────────────────────
  server.registerTool(
    "figma_get_metadata",
    {
      title: "获取 Figma 节点元数据 (XML)",
      description: `获取节点的原始元数据 XML。包含节点 ID、类型、名称、位置 (x/y/width/height)、
父子层级关系。不含样式或文本。

适合快速了解页面结构层级，或定位子节点 ID。

Args:
  - node_id (string, 必填): Figma 节点 ID，也可以是 page ID (如 "0:1")

Returns:
  XML 格式的节点层级树。`,
      inputSchema: NodeIdSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    withErrorHandling(async (params: NodeIdInput) => {
      const nodeId = params.node_id.replace(/-/g, ":");
      const xml = await fetchMetadata(nodeId);
      return {
        content: [{ type: "text", text: xml }],
      };
    }),
  );

  // ────────────────────────────────────────
  // 工具 5: 获取原始设计上下文 (ref-code)
  // ────────────────────────────────────────
  server.registerTool(
    "figma_get_design_context",
    {
      title: "获取 Figma 原始设计上下文 (ref-code)",
      description: `获取 Figma MCP 生成的原始参考代码（React JSX + Tailwind），不做语义分析。

输出包含：
- 参考代码（含 data-node-id 标记、Tailwind 类名、内联样式）
- 截图（如果 Figma MCP 返回了的话）
- 图片资源 URL（作为 const 常量）

适合需要原始代码进行自定义解析的场景。

Args:
  - node_id (string, 必填): Figma 节点 ID
  - force_code (boolean, 可选): 节点过大时强制返回代码
  - artifact_type (enum, 可选): WEB_PAGE_OR_APP_SCREEN | COMPONENT_WITHIN_A_WEB_PAGE_OR_APP_SCREEN | REUSABLE_COMPONENT | DESIGN_SYSTEM

Returns:
  原始参考代码 + 截图。`,
      inputSchema: DesignContextSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    withErrorHandling(async (params: DesignContextInput) => {
      const nodeId = params.node_id.replace(/-/g, ":");
      const { texts, images } = await fetchDesignContext(
        nodeId,
        params.force_code,
        params.artifact_type,
      );

      const content: McpContent[] = [];

      // 截图
      for (const img of images) {
        if (img.data && img.mimeType) {
          content.push({
            type: "image",
            data: img.data,
            mimeType: img.mimeType,
          });
        }
      }

      // 参考代码
      if (texts.length > 0) {
        content.push({
          type: "text",
          text: texts.join("\n\n---\n\n"),
        });
      }

      if (!content.length) {
        content.push({ type: "text", text: "未获取到设计上下文" });
      }

      return { content };
    }),
  );

  // ────────────────────────────────────────
  // 工具 6: 获取设计变量 / Token
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
  // 工具 7: 下载设计资源到本地
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
          // 通过 curl 下载 localhost URL
          mkdirSync(dirname(targetPath), { recursive: true });
          execSync(`curl -sS -o "${targetPath}" "${asset.url}"`, {
            timeout: 15000,
          });

          // 验证
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

  // ────────────────────────────────────────
  // 工具 8: 获取完整数据并保存到本地（all-in-one fetch）
  // ────────────────────────────────────────
  server.registerTool(
    "figma_fetch_all",
    {
      title: "获取 Figma 全部数据并保存到本地",
      description: `一次性获取指定节点的所有数据并保存到本地目录，包括：
- metadata.xml（节点层级结构）
- design-context.txt（参考代码）
- screenshot-0.png（截图）
- semantic-tree.json（语义分析结果）

这是批量导出的入口，适合离线工作或需要长期缓存设计数据。

Args:
  - node_id (string, 必填): Figma 节点 ID
  - out_dir (string, 必填): 保存目录

Returns:
  输出文件列表和摘要。`,
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

      if (!existsSync(outDir)) {
        mkdirSync(outDir, { recursive: true });
      }

      const savedFiles: string[] = [];

      // 并行获取
      const [screenshots, metadataXml, designCtx, variables] =
        await Promise.all([
          fetchScreenshot(nodeId).catch(() => []),
          fetchMetadata(nodeId),
          fetchDesignContext(nodeId, true),
          fetchVariables(nodeId).catch(() => ""),
        ]);

      // 1. metadata.xml
      const metaPath = join(outDir, "metadata.xml");
      writeFileSync(metaPath, metadataXml, "utf-8");
      savedFiles.push(
        `metadata.xml (${(Buffer.byteLength(metadataXml) / 1024).toFixed(1)}KB)`,
      );

      // 2. design-context.txt
      const designContextText = designCtx.texts.join("\n\n---\n\n");
      const ctxPath = join(outDir, "design-context.txt");
      writeFileSync(ctxPath, designContextText, "utf-8");
      savedFiles.push(
        `design-context.txt (${(Buffer.byteLength(designContextText) / 1024).toFixed(1)}KB)`,
      );

      // 3. 截图
      let imgIdx = 0;
      for (const img of screenshots) {
        if (img.data && img.mimeType) {
          const imgPath = join(outDir, `screenshot-${imgIdx}.png`);
          const imgData = Buffer.from(img.data, "base64");
          writeFileSync(imgPath, imgData);
          savedFiles.push(
            `screenshot-${imgIdx}.png (${(imgData.length / 1024).toFixed(1)}KB)`,
          );
          imgIdx++;
        }
      }

      // 4. design-context 中附带的截图
      for (const img of designCtx.images) {
        if (img.data && img.mimeType) {
          const imgPath = join(outDir, `context-image-${imgIdx}.png`);
          const imgData = Buffer.from(img.data, "base64");
          writeFileSync(imgPath, imgData);
          savedFiles.push(
            `context-image-${imgIdx}.png (${(imgData.length / 1024).toFixed(1)}KB)`,
          );
          imgIdx++;
        }
      }

      // 5. 变量
      if (variables) {
        const varPath = join(outDir, "variables.txt");
        writeFileSync(varPath, variables, "utf-8");
        savedFiles.push(
          `variables.txt (${(Buffer.byteLength(variables) / 1024).toFixed(1)}KB)`,
        );
      }

      // 6. 语义分析
      const result = analyze(metadataXml, designContextText);
      const treePath = join(outDir, "semantic-tree.json");
      writeFileSync(treePath, JSON.stringify(result, null, 2), "utf-8");
      savedFiles.push(`semantic-tree.json`);

      // 7. 摘要
      const summary = {
        nodeId,
        timestamp: new Date().toISOString(),
        files: savedFiles,
        stats: result._stats,
      };
      const summaryPath = join(outDir, "fetch-summary.json");
      writeFileSync(summaryPath, JSON.stringify(summary, null, 2), "utf-8");
      savedFiles.push(`fetch-summary.json`);

      const content: McpContent[] = [];

      // 返回截图
      if (screenshots.length > 0 && screenshots[0].data && screenshots[0].mimeType) {
        content.push({
          type: "image",
          data: screenshots[0].data,
          mimeType: screenshots[0].mimeType,
        });
      }

      // 返回摘要文本
      content.push({
        type: "text",
        text: [
          `# Figma 数据导出完成`,
          ``,
          `- 节点: ${nodeId}`,
          `- 目录: ${outDir}`,
          `- 页面: ${result.page.name}`,
          `- 视口: ${result.page.viewport.width}×${result.page.viewport.height}`,
          ``,
          `## 统计`,
          `- XML 节点: ${result._stats.xmlNodes}`,
          `- 样式条目: ${result._stats.styledNodes}`,
          `- 资源数量: ${result._stats.assetCount}`,
          `- 容器组: ${result._stats.containerGroups}`,
          `- 聚类组: ${result._stats.clusterGroups}`,
          `- 重复模式: ${result._stats.repeatPatterns}`,
          ``,
          `## 输出文件`,
          ...savedFiles.map((f) => `- ${f}`),
        ].join("\n"),
      });

      return { content };
    }),
  );
}
