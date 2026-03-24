import { z } from "zod";

// ============================================================
// 共用 — 节点 ID
// ============================================================

export const NodeIdSchema = z.object({
  node_id: z
    .string()
    .describe(
      'Figma 节点 ID，如 "0:118" 或 "0-118"。从 Figma URL 的 node-id 参数提取',
    ),
});

export type NodeIdInput = z.infer<typeof NodeIdSchema>;

// ============================================================
// get_design_context 参数（透传 Figma MCP 原生参数）
// ============================================================

export const DesignContextSchema = z.object({
  node_id: z
    .string()
    .describe('Figma 节点 ID，如 "0:118" 或 "0-118"'),
  force_code: z
    .boolean()
    .optional()
    .describe("是否强制返回代码（节点过大时 Figma MCP 默认只返回 metadata）"),
  artifact_type: z
    .enum([
      "WEB_PAGE_OR_APP_SCREEN",
      "COMPONENT_WITHIN_A_WEB_PAGE_OR_APP_SCREEN",
      "REUSABLE_COMPONENT",
      "DESIGN_SYSTEM",
    ])
    .optional()
    .describe("产物类型，影响 Figma MCP 生成的参考代码风格"),
});

export type DesignContextInput = z.infer<typeof DesignContextSchema>;

// ============================================================
// 资源下载参数
// ============================================================

export const DownloadAssetsSchema = z.object({
  node_id: z
    .string()
    .describe('Figma 节点 ID，先分析该节点获取 assets 列表'),
  out_dir: z
    .string()
    .describe("资源保存目录路径（相对于工作区根目录或绝对路径）"),
});

export type DownloadAssetsInput = z.infer<typeof DownloadAssetsSchema>;
