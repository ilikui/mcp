import {
  AuthorizationError,
  OAuthAuthorizationServer,
  type AuthRequest,
} from "@cloudflare/workers-oauth-provider";
import { WorkerEntrypoint } from "cloudflare:workers";

interface Env {
  OAUTH_KV: KVNamespace;
  GITHUB_OAUTH_CLIENT_ID: string;
  GITHUB_OAUTH_CLIENT_SECRET: string;
}

const ISSUER = "https://auth.likui.space";
const RESOURCE = "https://mcp.likui.space/mcp";
const CALLBACK_URL = `${ISSUER}/callback`;
const SCOPES = ["mcp:read", "mcp:write"];

const authorizationServer = new OAuthAuthorizationServer<Env>({
  issuer: ISSUER,
  resources: [RESOURCE],
  scopesSupported: SCOPES,
  clientIdMetadataDocumentEnabled: true,
  clientRegistrationEndpoint: "/oauth/register",
  accessTokenTTL: 3600,
  refreshTokenTTL: 60 * 60 * 24 * 30,
});

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function html(body: string, status = 200, headers = new Headers()): Response {
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  return new Response(body, { status, headers });
}

function errorPage(message: string, status = 400): Response {
  return html(
    `<!doctype html><meta charset="utf-8"><title>Gist MCP 授权</title><h1>授权未完成</h1><p>${escapeHtml(message)}</p><p>请返回 ChatGPT 重新发起连接。</p>`,
    status,
  );
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

async function githubAuthorize(request: Request, env: Env): Promise<Response> {
  const oauth = authorizationServer.getOAuthApi(env);
  let authRequest: AuthRequest;

  try {
    authRequest = await oauth.parseAuthRequest(request);
  } catch (error) {
    if (error instanceof AuthorizationError) {
      if (error.redirectTo) return Response.redirect(error.redirectTo, 302);
      return errorPage(error.description);
    }
    throw error;
  }

  const details = await oauth.describeConsent(authRequest);
  const consent = await oauth.beginConsent(authRequest);
  const scopeRows = details.scope
    .map((scope) => `<label><input type="checkbox" name="scope" value="${escapeHtml(scope)}" checked> ${escapeHtml(scope)}</label><br>`)
    .join("");

  return html(`<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>授权 Gist MCP</title>
<style>
body{font:16px system-ui,sans-serif;max-width:620px;margin:8vh auto;padding:24px;color:#222}
main{border:1px solid #ddd;border-radius:16px;padding:28px}
button{padding:11px 20px;border:0;border-radius:9px;cursor:pointer;margin:12px 8px 0 0}
.allow{background:#171717;color:white}.deny{background:#eee}
small{color:#666}
</style>
<main>
<h1>授权 Gist MCP</h1>
<p><strong>${escapeHtml(details.clientName)}</strong> 请求访问你的 Gist MCP 服务。</p>
<p>授权将返回到：<strong>${escapeHtml(details.redirectHost)}</strong></p>
${details.redirectIsLoopback ? "<p><strong>注意：</strong>请求将返回到你本机运行的应用。</p>" : ""}
<p>将授予以下权限：</p>
<form method="post" action="/authorize">
<input type="hidden" name="handle" value="${escapeHtml(consent.handle)}">
${scopeRows}
<p><small>继续后将跳转 GitHub 完成身份验证。此授权用于识别 GitHub 账户；现有 Gist 操作仍由已配置的服务端 GitHub Token 执行。</small></p>
<button class="allow" name="decision" value="approve">继续并使用 GitHub 登录</button>
<button class="deny" name="decision" value="deny">拒绝</button>
</form></main></html>`, 200, consent.headers);
}

async function authorizePost(request: Request, env: Env): Promise<Response> {
  const oauth = authorizationServer.getOAuthApi(env);
  const form = await request.formData();
  const handle = String(form.get("handle") ?? "");
  if (!handle) return errorPage("授权请求已失效，请重新开始。");

  if (form.get("decision") !== "approve") {
    const denied = await oauth.denyConsent(request, handle);
    return new Response(null, { status: 302, headers: denied.headers });
  }

  const approved = await oauth.approveConsent(request, handle, {
    scope: form.getAll("scope").map(String),
  });
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = await pkceChallenge(verifier);
  const upstream = await oauth.beginUpstream(approved.request, {
    data: { verifier },
    headers: approved.headers,
  });

  const githubUrl = new URL("https://github.com/login/oauth/authorize");
  githubUrl.searchParams.set("client_id", env.GITHUB_OAUTH_CLIENT_ID);
  githubUrl.searchParams.set("redirect_uri", CALLBACK_URL);
  githubUrl.searchParams.set("scope", "read:user");
  githubUrl.searchParams.set("state", upstream.state);
  githubUrl.searchParams.set("code_challenge", challenge);
  githubUrl.searchParams.set("code_challenge_method", "S256");
  upstream.headers.set("Location", githubUrl.toString());
  return new Response(null, { status: 302, headers: upstream.headers });
}

async function githubCallback(request: Request, env: Env): Promise<Response> {
  const oauth = authorizationServer.getOAuthApi(env);
  const url = new URL(request.url);
  const { request: original, data, headers } = await oauth.finishUpstream<{ verifier: string }>(request);

  if (url.searchParams.has("error")) {
    return errorPage("GitHub 登录被取消或未获授权。");
  }

  const code = url.searchParams.get("code");
  if (!code) return errorPage("GitHub 未返回授权码。");

  const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: env.GITHUB_OAUTH_CLIENT_ID,
      client_secret: env.GITHUB_OAUTH_CLIENT_SECRET,
      code,
      redirect_uri: CALLBACK_URL,
      code_verifier: data.verifier,
    }),
  });
  const tokenBody = await tokenResponse.text();
  let tokenData: {
    access_token?: string;
    error?: string;
    error_description?: string;
  };
  try {
    tokenData = JSON.parse(tokenBody) as typeof tokenData;
  } catch {
    console.error("GitHub token endpoint returned invalid JSON", {
      status: tokenResponse.status,
      contentType: tokenResponse.headers.get("content-type"),
      bodyLength: tokenBody.length,
    });
    return errorPage(
      `GitHub Token 交换接口返回了无效响应（HTTP ${tokenResponse.status}）。请稍后重新连接。`,
      502,
    );
  }
  if (!tokenResponse.ok || !tokenData.access_token) {
    console.error("GitHub token exchange was rejected", {
      status: tokenResponse.status,
      error: tokenData.error,
      description: tokenData.error_description,
    });
    return errorPage(tokenData.error_description ?? tokenData.error ?? `GitHub Token 交换失败（HTTP ${tokenResponse.status}）。`, 502);
  }

  const userResponse = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${tokenData.access_token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "ilikui-gist-mcp-oauth",
    },
  });
  if (!userResponse.ok) return errorPage("无法读取 GitHub 用户身份。", 502);
  const user = await userResponse.json() as { id?: number; login?: string };
  if (!user.id || !user.login) return errorPage("GitHub 返回的用户信息不完整。", 502);

  const completed = await oauth.completeAuthorization({
    request: original,
    userId: String(user.id),
    metadata: { githubLogin: user.login },
    scope: original.scope,
    props: { githubLogin: user.login },
  });
  headers.set("Location", completed.redirectTo);
  return new Response(null, { status: 302, headers });
}

export class GistMcpOAuth extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/health") {
        return Response.json({
          ok: true,
          service: "gist-mcp-oauth",
          issuer: ISSUER,
          resource: RESOURCE,
        });
      }
      if (url.pathname === "/authorize" && request.method === "GET") {
        return await githubAuthorize(request, this.env);
      }
      if (url.pathname === "/authorize" && request.method === "POST") {
        return await authorizePost(request, this.env);
      }
      if (url.pathname === "/callback" && request.method === "GET") {
        return await githubCallback(request, this.env);
      }
      return await authorizationServer.fetch(request, this.env, this.ctx);
    } catch (error) {
      if (error instanceof AuthorizationError) {
        const cookieNames = (request.headers.get("cookie") ?? "")
          .split(";")
          .map((part) => part.trim().split("=")[0])
          .filter(Boolean);
        console.warn("OAuth authorization transaction rejected", {
          path: url.pathname,
          rayId: request.headers.get("cf-ray"),
          message: error.message,
          description: error.description,
          hasState: url.searchParams.has("state"),
          hasCode: url.searchParams.has("code"),
          cookieNames,
        });
        return errorPage(error.description || "授权会话已失效，请返回 ChatGPT 重新发起连接。", 400);
      }
      console.error("Unhandled OAuth Worker error", {
        path: url.pathname,
        method: request.method,
        rayId: request.headers.get("cf-ray"),
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      return errorPage("授权服务暂时发生错误，请返回 ChatGPT 重新发起连接。", 500);
    }
  }

  validateToken(resource: string, token: string) {
    return authorizationServer.validateToken(resource, token, this.env);
  }
}

export default GistMcpOAuth;
