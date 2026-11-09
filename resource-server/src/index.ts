import { OAuthResourceServer } from "@cloudflare/workers-oauth-provider";

interface Env {
  GITHUB_TOKEN: string;
  MCP_ACCESS_TOKEN: string;
  AUTH_SERVER: {
    validateToken(resource: string, token: string): Promise<{
      props: Record<string, unknown>;
      audience: string;
      expiresAt?: number;
      scope?: string[];
      userId?: string;
      clientId?: string;
    } | null>;
  };
}

const GIST_ID = "ef6b39d2648e666f47b129b54d3f09f7";
const API = "https://api.github.com";
const INFO = { name: "ilikui-gist-mcp", version: "1.1.0" };
const RESOURCE = "https://mcp.likui.space/mcp";
const ISSUER = "https://auth.likui.space";

const reply = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
const rpc = (id: unknown, result: unknown) => reply({ jsonrpc: "2.0", id, result });
const fail = (id: unknown, message: string) =>
  rpc(id, { content: [{ type: "text", text: message }], isError: true });

async function gh(env: Env, method = "GET", body?: unknown) {
  if (!env.GITHUB_TOKEN) throw Error("GITHUB_TOKEN secret is not configured.");
  const headers: Record<string, string> = {
    authorization: "Bearer " + env.GITHUB_TOKEN,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "ilikui-gist-mcp",
  };
  const init: RequestInit = { method, headers };
  if (body) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const r = await fetch(API + "/gists/" + GIST_ID, init);
  const d = await r.json().catch(() => ({})) as any;
  if (!r.ok) throw Error("GitHub API " + r.status + ": " + (d.message || "request failed"));
  return d;
}

const tools = [
  { name: "gist_list_files", description: "List files in the single configured Gist; read-only.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "gist_read", description: "Read one existing file from the configured Gist. Does not modify content.", inputSchema: { type: "object", properties: { file_name: { type: "string", description: "Exact existing filename" } }, required: ["file_name"], additionalProperties: false } },
  { name: "gist_update", description: "Replace the contents of one existing file in the configured Gist. Cannot create/delete files. Must supply updated_at from the latest read/list result; stale updates are rejected.", inputSchema: { type: "object", properties: { file_name: { type: "string" }, content: { type: "string" }, expected_updated_at: { type: "string" } }, required: ["file_name", "content", "expected_updated_at"], additionalProperties: false } },
  { name: "gist_create_file", description: "Create a new file in the configured Gist. Refuses to overwrite an existing filename.", inputSchema: { type: "object", properties: { file_name: { type: "string", description: "New filename" }, content: { type: "string", description: "Markdown or text content" } }, required: ["file_name", "content"], additionalProperties: false } },
];

async function invoke(name: string, a: any, e: Env) {
  if (name === "gist_list_files") {
    const g = await gh(e);
    return { gist_id: GIST_ID, updated_at: g.updated_at, html_url: g.html_url, files: Object.entries(g.files || {}).map(([file_name, f]: [string, any]) => ({ file_name, language: f.language, size: f.size, truncated: !!f.truncated })) };
  }
  if (name === "gist_read") {
    const n = String(a.file_name || "");
    const g = await gh(e);
    const f = g.files?.[n];
    if (!f) throw Error("File not found. Creating files is disabled.");
    let content = f.content;
    if (f.truncated && f.raw_url) {
      const r = await fetch(f.raw_url);
      if (!r.ok) throw Error("Could not fetch complete raw file.");
      content = await r.text();
    }
    return { gist_id: GIST_ID, file_name: n, updated_at: g.updated_at, content };
  }
  if (name === "gist_create_file") {
    const n = String(a.file_name || ""), c = a.content;
    if (!n || n.trim() !== n || n.length > 255 || /[\\/\x00-\x1f]/.test(n) || typeof c !== "string") throw Error("A valid file_name and string content are required.");
    if (c.length > 900000) throw Error("Content exceeds 900 KB limit.");
    const g = await gh(e);
    if (g.files?.[n]) throw Error("File already exists. Refusing to overwrite an existing file.");
    const u = await gh(e, "PATCH", { files: { [n]: { content: c } } });
    if (!u.files?.[n]) throw Error("GitHub did not confirm creation of the requested file.");
    return { success: true, created: true, gist_id: GIST_ID, file_name: n, updated_at: u.updated_at, html_url: u.html_url, message: "New Gist file created; existing files were not intentionally modified." };
  }
  if (name === "gist_update") {
    const n = String(a.file_name || ""), c = a.content, expected = String(a.expected_updated_at || "");
    if (!n || typeof c !== "string" || !expected) throw Error("file_name, content, expected_updated_at are required.");
    if (c.length > 900000) throw Error("Content exceeds 900 KB limit.");
    const g = await gh(e);
    if (!g.files?.[n]) throw Error("File not found. Creating files is disabled.");
    if (g.updated_at !== expected) throw Error("Conflict: Gist changed since last read. Read latest content before updating.");
    const u = await gh(e, "PATCH", { files: { [n]: { content: c } } });
    return { success: true, gist_id: GIST_ID, file_name: n, updated_at: u.updated_at, html_url: u.html_url, message: "Existing Gist file updated." };
  }
  throw Error("Unknown tool.");
}

async function handleMcp(req: Request, env: Env): Promise<Response> {
  const u = new URL(req.url);
  if (u.pathname === "/health" && req.method === "GET") {
    return reply({ service: INFO.name, version: INFO.version, status: "deployed", github_secret_configured: !!env.GITHUB_TOKEN, access_secret_configured: !!env.MCP_ACCESS_TOKEN, oauth: true });
  }
  if (u.pathname !== "/mcp") return reply({ error: "Not found" }, 404);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type, authorization, mcp-session-id, mcp-protocol-version" } });
  if (req.method !== "POST") return reply({ error: "Use POST /mcp" }, 405, { allow: "POST, OPTIONS" });
  if (!env.GITHUB_TOKEN) return reply({ error: "GITHUB_TOKEN secret not configured" }, 503);
  let b: any;
  try { b = await req.json(); } catch { return reply({ error: "Expected JSON-RPC" }, 400); }
  if (!b || b.jsonrpc !== "2.0" || typeof b.method !== "string") return reply({ error: "Invalid JSON-RPC" }, 400);
  if (b.method.startsWith("notifications/")) return new Response(null, { status: 202 });
  if (b.method === "initialize") return rpc(b.id ?? null, { protocolVersion: b.params?.protocolVersion || "2025-03-26", capabilities: { tools: { listChanged: false } }, serverInfo: INFO, instructions: "Restricted to one configured Gist. Read existing files, create new files without overwriting, or replace existing file contents only with updated_at concurrency protection. No delete." });
  if (b.method === "ping") return rpc(b.id ?? null, {});
  if (b.method === "tools/list") return rpc(b.id ?? null, { tools });
  if (b.method === "tools/call") {
    try { const result = await invoke(b.params?.name, b.params?.arguments || {}, env); return rpc(b.id ?? null, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] }); }
    catch (e) { return fail(b.id ?? null, e instanceof Error ? e.message : "Unknown error"); }
  }
  return reply({ jsonrpc: "2.0", id: b.id ?? null, error: { code: -32601, message: "Method not found" } });
}

const oauthResource = new OAuthResourceServer<Env, Record<string, unknown>>({
  resourceMetadata: { resource: RESOURCE, authorization_servers: [ISSUER] },
  requiredScopes: ["mcp:read"],
  validateToken: (env) => env.AUTH_SERVER.validateToken,
  handler: {
    async fetch(request, env, ctx) {
      if (!ctx.auth.scope.includes("mcp:read")) {
        return new Response(JSON.stringify({ error: "insufficient_scope" }), { status: 403, headers: { "content-type": "application/json", "www-authenticate": 'Bearer error="insufficient_scope", scope="mcp:read", resource_metadata="https://mcp.likui.space/.well-known/oauth-protected-resource/mcp"' } });
      }
      return handleMcp(request, env);
    },
  },
});

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") return handleMcp(request, env);
    // Backward-compatible static token path. It bypasses OAuth introspection.
    if (env.MCP_ACCESS_TOKEN && request.headers.get("authorization") === "Bearer " + env.MCP_ACCESS_TOKEN) {
      return handleMcp(request, env);
    }
    return oauthResource.fetch(request, env, ctx);
  },
};
