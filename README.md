# mcp-openapi

OpenAPI 3.x to MCP server bridge in TypeScript.

`mcp-openapi` takes an OpenAPI spec and turns it into an MCP server where each OpenAPI operation is an MCP tool. Tool calls are proxied to the original REST API with runtime validation and auth handling.

## Capabilities

- OpenAPI 3.0+ support (YAML/JSON, `$ref` dereference, operation compilation)
- Proxy behavior to upstream REST API
- Authentication via env vars:
  - API keys (`in: header|query|cookie`)
  - HTTP Bearer
  - HTTP Basic
  - OAuth2 / OpenID Connect (static token or client credentials token fetch)
- Runtime validation:
  - Zod validation generated from OpenAPI-derived JSON Schema
  - AJV JSON Schema validation
  - Response schema validation by HTTP status
- Typed TypeScript implementation
- Multiple transports:
  - `stdio`
  - `streamable-http` (Hono)
  - `sse` (legacy compatibility transport)
- Built-in browser test clients:
  - `/test/streamable`
  - `/test/sse`
- Project scaffold (`init`) that generates:
  - `package.json`
  - `tsconfig.json`
  - `src/server.ts`
  - `.env.example`
  - `README.md`
  - `Dockerfile`

## Install

```bash
npm install
```

## Run

### stdio

```bash
npm run dev -- --spec ./openapi.yaml
```

### StreamableHTTP

```bash
npm run dev -- --spec ./openapi.yaml --transport streamable-http --port 3000
```

Endpoints:

- `http://localhost:3000/health`
- `http://localhost:3000/metrics`
- `http://localhost:3000/mcp`
- `http://localhost:3000/test/streamable`

### SSE (legacy)

```bash
npm run dev -- --spec ./openapi.yaml --transport sse --port 3000
```

Endpoints:

- `http://localhost:3000/health`
- `http://localhost:3000/metrics`
- `http://localhost:3000/sse`
- `http://localhost:3000/messages?sessionId=...`
- `http://localhost:3000/test/sse`

## CLI

```bash
mcp-openapi --spec <openapi-file> [options]
mcp-openapi init [dir]
```

Options:

- `--server-url <url>`
- `--cache-path <file>`
- `--print-tools`
- `--validate-spec`
- `--transport stdio|streamable-http|sse`
- `--port <n>`
- `--watch-spec`
- `--timeout-ms <ms>`
- `--retries <n>`
- `--retry-delay-ms <ms>`
- `--max-response-bytes <n>`
- `--max-concurrency <n>`
- `--allow-hosts host1,host2`

## Auth env vars

- `MCP_OPENAPI_API_KEY`
- `MCP_OPENAPI_BEARER_TOKEN`
- `MCP_OPENAPI_BASIC_USERNAME`
- `MCP_OPENAPI_BASIC_PASSWORD`
- `MCP_OPENAPI_OAUTH2_ACCESS_TOKEN`
- `MCP_OPENAPI_OAUTH2_CLIENT_ID`
- `MCP_OPENAPI_OAUTH2_CLIENT_SECRET`
- `MCP_OPENAPI_<SCHEME_NAME>_TOKEN`
- `MCP_OPENAPI_<SCHEME_NAME>_CLIENT_ID`
- `MCP_OPENAPI_<SCHEME_NAME>_CLIENT_SECRET`

## Build and verify

```bash
npm run check
npm run build
npm test
npm run smoke
```
