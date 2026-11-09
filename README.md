# ilikui MCP OAuth

OAuth 2.1 authorization server for the existing `ilikui/gist-mcp` Cloudflare Worker.

## Deployment design

- Authorization server: `https://auth.likui.space` (Cloudflare Worker `gist-mcp-oauth`)
- Protected MCP resource: `https://mcp.likui.space/mcp` (existing Worker `gist-mcp`)
- OAuth storage: dedicated KV namespace bound as `OAUTH_KV`
- Resource validation: private Cloudflare Service Binding from `gist-mcp` to the authorization Worker
- Upstream identity: GitHub OAuth App
- Backward compatibility: the existing `MCP_ACCESS_TOKEN` remains valid while OAuth bearer-token validation is added.

## Important safety boundary

The resource Worker now keeps the existing `MCP_ACCESS_TOKEN` path and adds OAuth validation through a private Service Binding. The four Gist tools remain available. Validate the public OAuth discovery and end-to-end login before considering ChatGPT connection complete. Never commit OAuth client secrets, GitHub tokens, Cloudflare API tokens, or the legacy MCP access token.

## Required Cloudflare secrets

Set these as Worker secrets on `gist-mcp-oauth`:

- `GITHUB_OAUTH_CLIENT_ID`
- `GITHUB_OAUTH_CLIENT_SECRET`

The GitHub OAuth App callback URL must be exactly:

`https://auth.likui.space/callback`

The previous callback `https://mcp.likui.space/callback` is no longer correct for this split-worker design. Update the OAuth App callback URL in GitHub Developer Settings before testing.

The existing `GITHUB_OAUTH_CLIENT_SECRET` on `gist-mcp` is not automatically shared with this Worker.

## Required bindings and configuration

- KV namespace binding: `OAUTH_KV` (dedicated namespace; do not reuse Inkstone or other application storage)
- Resource identifier: `https://mcp.likui.space/mcp`
- Authorization issuer: `https://auth.likui.space`
- Service Binding on the resource Worker: `AUTH_SERVER` -> `gist-mcp-oauth`

## Planned source layout

- `src/index.ts`: OAuth authorization server and `GistMcpOAuth` RPC entry point
- `wrangler.jsonc`: authorization Worker, custom domain, and KV configuration
- `resource-server/src/index.ts`: Gist MCP tools, OAuth resource validation, scope checks, and legacy static-token compatibility
- `resource-server/wrangler.jsonc`: existing `gist-mcp` custom domain and `AUTH_SERVER` Service Binding
- `.github/workflows/deploy.yml`: type-checks and deploys the authorization Worker, then the Gist resource Worker

The OAuth authorize route must validate the MCP client's request, show a consent page, bind upstream GitHub login state to the browser, exchange the GitHub authorization code, and then issue an audience-bound MCP token. Do not replace this flow with a direct GitHub login redirect.

## GitHub Actions secrets required for deployment

Configure these GitHub Actions Environment secrets in the `MCP` environment (the workflow declares `environment: MCP`):

- `CLOUDFLARE_API_TOKEN`: a scoped Cloudflare API token with Workers Scripts edit and required KV/Workers deployment permissions for this account.
- `CLOUDFLARE_ACCOUNT_ID`: `2aac639a7877e949348ae47adca69aa1`.
- `OAUTH_CLIENT_SECRET`: the GitHub OAuth App client secret (never commit it).

The GitHub Actions workflow installs dependencies, type-checks, writes the client secret to the new Worker as a Worker secret, and deploys `gist-mcp-oauth`. The workflow cannot deploy until all three secrets exist and the custom hostname is available in the Cloudflare zone.

## Local validation

```sh
npm ci
npm run check
npm run test
npm run deploy
```

The dual-auth resource Worker has been deployed. Runtime checks of the public metadata endpoints, legacy-token request path, OAuth login, and ChatGPT connection are still required.
