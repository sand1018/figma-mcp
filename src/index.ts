#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./tools.js";

const server = new McpServer({
  name: "figma-context-mcp-server",
  version: "1.0.0",
});

async function main() {
  registerTools(server);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("figma-context-mcp-server v1.0.0 已启动 (stdio)");
}

main().catch((error) => {
  console.error("启动失败:", error);
  process.exit(1);
});
