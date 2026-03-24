/**
 * figma-mcp.ts — 与 Figma Desktop MCP Server 通信的客户端
 * 
 * Figma Desktop MCP 在 http://127.0.0.1:3845/mcp (Streamable HTTP)
 */

const DEFAULT_ENDPOINT = "http://127.0.0.1:3845/mcp";
const DEFAULT_TIMEOUT_MS = 300_000; // 5分钟

let _requestId = 0;
let _sessionId: string | null = null;

/** 发送 JSON-RPC 请求 */
async function mcpRequest(
  endpoint: string,
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<unknown> {
  _requestId++;
  const body = { jsonrpc: "2.0", id: _requestId, method, params };
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (_sessionId) headers["mcp-session-id"] = _sessionId;

  const res = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const newSid = res.headers.get("mcp-session-id");
  if (newSid) _sessionId = newSid;

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Figma MCP [${res.status}]: ${text.slice(0, 300)}`);
  }

  const ct = res.headers.get("content-type") || "";
  if (ct.includes("text/event-stream")) return parseSSE(await res.text());
  const json = (await res.json()) as Record<string, unknown>;
  if (json.error) throw new Error(`Figma MCP error: ${JSON.stringify(json.error)}`);
  return json.result;
}

/** SSE 解析 */
function parseSSE(text: string): unknown {
  let lastData: string | null = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("data: ")) lastData = line.slice(6);
  }
  if (!lastData) throw new Error("SSE: no data event");
  const json = JSON.parse(lastData);
  if (json.result !== undefined) return json.result;
  if (Array.isArray(json)) {
    const r = json.find((i: Record<string, unknown>) => i.result !== undefined);
    if (r) return r.result;
  }
  if (json.error) throw new Error(`MCP error: ${JSON.stringify(json.error)}`);
  return json;
}

/** 发送通知 */
async function mcpNotify(endpoint: string, method: string) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (_sessionId) headers["mcp-session-id"] = _sessionId;
  await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", method }),
  }).catch(() => {});
}

export async function initFigmaMcp(endpoint = DEFAULT_ENDPOINT) {
  _sessionId = null;
  _requestId = 0;
  const result = (await mcpRequest(endpoint, "initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "figma-context-mcp", version: "1.0.0" },
  })) as Record<string, unknown>;
  await mcpNotify(endpoint, "notifications/initialized");
  return result;
}

export interface FigmaContent {
  type: "text" | "image";
  text?: string;
  data?: string;     // base64
  mimeType?: string;
}

export async function callFigmaTool(
  endpoint: string,
  toolName: string,
  args: Record<string, unknown>,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<{ content: FigmaContent[] }> {
  const result = await mcpRequest(endpoint, "tools/call", {
    name: toolName,
    arguments: args,
  }, timeoutMs);
  return result as { content: FigmaContent[] };
}
