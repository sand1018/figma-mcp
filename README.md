# figma-context-mcp-server

**Figma 设计数据 → 结构化语义树 + 截图**

代理 Figma Desktop MCP Server，将原始设计数据转换为结构化的语义分析 JSON，供 AI Agent 直接用于设计稿还原。

## 架构

```
Figma Desktop App (port 3845)
       ↓ Streamable HTTP
figma-context-mcp-server (stdio)
       ↓ 增强输出
AI Agent (Gemini / Claude / etc.)
```

## 工具列表

### 增强工具（带语义分析）

| 工具 | 说明 |
|------|------|
| `figma_get_page_context` | **主入口**。截图 + 结构化分析 JSON（容器聚合、CSS、布局、重复检测） |
| `figma_analyze_structure` | 仅结构化分析 JSON（不含截图）。已有截图时使用 |

### 直通代理（Figma MCP 原生能力）

| 工具 | 说明 |
|------|------|
| `figma_get_screenshot` | 获取节点截图 |
| `figma_get_metadata` | 获取节点层级树 (XML) |
| `figma_get_design_context` | 获取原始参考代码 (React JSX + Tailwind) |
| `figma_get_variables` | 获取设计变量 / Token |

### 文件操作工具

| 工具 | 说明 |
|------|------|
| `figma_download_assets` | 分析节点并下载所有图片/SVG 到本地 |
| `figma_fetch_all` | 一次性导出全部数据 (metadata + context + screenshot + analysis) |

## 使用

### 前置条件

1. Figma Desktop App 已打开
2. Figma MCP 服务已启用 (http://127.0.0.1:3845/mcp)
3. Node.js >= 18

### 构建

```bash
npm install
npm run build
```

### MCP 配置

```json
{
  "mcpServers": {
    "figma-context": {
      "command": "node",
      "args": ["path/to/dist/index.cjs"]
    }
  }
}
```

## 源码结构

```
src/
├── index.ts        ← 入口 (McpServer + StdioServerTransport)
├── schemas.ts      ← Zod schema 定义
├── figma-mcp.ts    ← Figma Desktop MCP 通信层
├── analyzer.ts     ← 语义分析核心 (从 semantic-analyze.mjs v3.1 移植)
└── tools.ts        ← 8 个工具注册
```
