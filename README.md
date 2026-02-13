# mcp-openapi

OpenAPI 3.x to MCP server bridge in TypeScript.

This project takes an OpenAPI spec and exposes every operation as an MCP tool, while proxying calls to the original REST API.

## Feature checklist

- OpenAPI 3.0+ support
  - Loads YAML/JSON, dereferences `$ref`, compiles operations into MCP tools.
- Proxy behavior
  - `tools/call` executes real HTTP requests against your API and returns structured results.
- Authentication support (env-driven)
  - API key, Bearer, Basic, OAuth2/OpenID Connect token injection.
- Zod validation
  - Generates Zod schemas from OpenAPI-derived JSON Schema for runtime input validation.
- Typed server
  - Fully typed TypeScript codebase with strict compile checks.
- Multiple transports
  - `stdio`
  - `streamable-http` (Hono)
  - deprecated `sse` (Hono + SDK SSE transport)
- Project scaffold
  - Includes `tsconfig.json`, `package.json`, scripts, entrypoint, tests.
- Built-in HTML test clients
  - `/test/streamable` and `/test/sse` for browser-based interaction testing.

## Install

```bash
npm install
```

## Run

### 1) stdio transport (default)

```bash
npm run dev -- --spec ./openapi.yaml
```

### 2) StreamableHTTP transport (Hono)

```bash
npm run dev -- --spec ./openapi.yaml --transport streamable-http --port 3000
```

Endpoints:

- `http://localhost:3000/health`
- `http://localhost:3000/mcp`
- `http://localhost:3000/test/streamable`

### 3) SSE transport (deprecated, for compatibility)

```bash
npm run dev -- --spec ./openapi.yaml --transport sse --port 3000
```

Endpoints:

- `http://localhost:3000/health`
- `http://localhost:3000/sse`
- `http://localhost:3000/messages?sessionId=...`
- `http://localhost:3000/test/sse`

## Common options

```bash
--server-url <url>      Override OpenAPI server URL
--timeout-ms <ms>       HTTP timeout per attempt (default: 20000)
--retries <n>           Retries on 408/429/5xx + transient network errors (default: 2)
--retry-delay-ms <ms>   Base retry delay (default: 500)
--watch-spec            Reload tools when spec changes
```

## Authentication env vars

- API key: `MCP_OPENAPI_API_KEY`
- Bearer: `MCP_OPENAPI_BEARER_TOKEN`
- Basic: `MCP_OPENAPI_BASIC_USERNAME`, `MCP_OPENAPI_BASIC_PASSWORD`
- OAuth2/OIDC bearer token: `MCP_OPENAPI_OAUTH2_ACCESS_TOKEN`
- Per-scheme override: `MCP_OPENAPI_<SCHEME_NAME>_TOKEN`

## Validation model

Input validation pipeline for `tools/call`:

1. Zod validation (generated from OpenAPI-derived schema)
2. JSON Schema validation (Ajv)

Success responses can also be validated against OpenAPI response schemas, and tool output is validated against MCP `outputSchema`.

## Generated tool shape

Each OpenAPI operation becomes an MCP tool with:

- `name`
- `description`
- `inputSchema`
- `outputSchema` (when available)
- tool annotations (`readOnlyHint`, `idempotentHint`, etc.)

Input argument groups:

```json
{
  "path": {},
  "query": {},
  "header": {},
  "cookie": {},
  "body": {},
  "pagination": {
    "enabled": false,
    "mode": "autoCursor",
    "maxPages": 5,
    "cursorParam": "cursor",
    "nextCursorPath": "next_cursor",
    "pageParam": "page",
    "startPage": 1
  }
}
```

## Request/response features

- Query/path/header/cookie style-aware serialization
- Request body content types:
  - `application/json`
  - `application/x-www-form-urlencoded`
  - `multipart/form-data`
  - `application/octet-stream`
- Pagination helpers:
  - cursor mode
  - incrementing page mode
- Retry with `Retry-After` support
- Progress notifications via MCP `_meta.progressToken`
- Cancellation support via MCP cancellation

## Build/test/smoke

```bash
npm run check
npm run build
npm test
npm run smoke
```

`npm run smoke` starts a full MCP client/server+HTTP flow and verifies that an OpenAPI spec is transformed into callable MCP tools.

## Browser test clients

After launching a web transport:

- StreamableHTTP client: `http://localhost:<port>/test/streamable`
- SSE client: `http://localhost:<port>/test/sse`

These pages let you initialize, list tools, and call tools directly in-browser.
