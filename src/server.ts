#!/usr/bin/env node
import { createRequire } from "node:module";
import { basename, resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { watch } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve, type HttpBindings } from "@hono/node-server";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type LoggingLevel
} from "@modelcontextprotocol/sdk/types.js";
import { executeOperation } from "./http.js";
import { STREAMABLE_TEST_HTML, SSE_TEST_HTML } from "./html.js";
import { paginateWithCursor } from "./pagination.js";
import { observeLatency, observeStatus, renderPrometheus, metrics } from "./metrics.js";
import type { CompileOptions, OperationModel, RuntimeOptions } from "./types.js";
import { zodFromJsonSchema } from "./zod-schema.js";
import { compileWithCache } from "./compile-cache.js";
import { lintOpenApiDocument } from "./lint.js";
import { loadOpenApiDocument } from "./openapi.js";

const require = createRequire(import.meta.url);
const Ajv = require("ajv");

type Validator = ((data: unknown) => boolean) & { errors?: Array<Record<string, unknown>> };

interface CompiledValidators {
  inputsAjv: Map<string, Validator>;
  inputsZod: Map<string, ReturnType<typeof zodFromJsonSchema>>;
  structuredOutputs: Map<string, Validator>;
  responsesByStatus: Map<string, Map<string, Validator>>;
}

interface RuntimeState {
  operations: Map<string, OperationModel>;
  validators: CompiledValidators;
}

interface CliOptions {
  command: "run" | "init" | "generate";
  initDir?: string;
  generateDir?: string;
  specPath: string;
  serverUrl?: string;
  cachePath: string;
  compile: CompileOptions;
  printTools: boolean;
  validateSpec: boolean;
  watchSpec: boolean;
  transport: "stdio" | "streamable-http" | "sse";
  port: number;
  runtime: RuntimeOptions;
}

let inFlightCalls = 0;
let responseTransform: ((ctx: { operation: OperationModel; response: { body: unknown; status: number } }) => unknown | Promise<unknown>) | undefined;

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));

  if (cli.command === "init") {
    await scaffoldProject(cli.initDir ?? process.cwd());
    process.stderr.write(`Scaffold generated in ${resolve(cli.initDir ?? process.cwd())}\n`);
    return;
  }

  if (cli.command === "generate") {
    const specPath = resolve(cli.specPath);
    const state = await loadRuntimeState(specPath, cli.serverUrl, cli.cachePath, cli.compile);
    await generateProjectFromSpec(cli.generateDir ?? resolve(process.cwd(), "generated-mcp-server"), specPath, state.operations, cli);
    process.stderr.write(`Generated project in ${resolve(cli.generateDir ?? resolve(process.cwd(), "generated-mcp-server"))}\n`);
    return;
  }

  const specPath = resolve(cli.specPath);
  const state: RuntimeState = await loadRuntimeState(specPath, cli.serverUrl, cli.cachePath, cli.compile);

  if (cli.runtime.responseTransformModule) {
    responseTransform = await loadResponseTransform(cli.runtime.responseTransformModule);
  }

  if (cli.validateSpec) {
    process.stdout.write(`Spec valid. Compiled ${state.operations.size} tools.\n`);
    return;
  }

  if (cli.printTools) {
    for (const tool of [...state.operations.values()].sort((a, b) => a.operationId.localeCompare(b.operationId))) {
      process.stdout.write(`${tool.operationId}\t${tool.method} ${tool.pathTemplate}\n`);
    }
    return;
  }

  if (cli.transport === "stdio") {
    const mcpServer = createMcpServer(state, cli);

    if (cli.watchSpec) {
      wireSpecWatcher(specPath, cli, state, async () => {
        await mcpServer.sendToolListChanged();
      });
    }

    const transport = new StdioServerTransport();
    await mcpServer.connect(transport);
    return;
  }

  await startWebServer(state, cli, specPath);
}

function createMcpServer(state: RuntimeState, cli: CliOptions): Server {
  const mcpServer = new Server(
    { name: "mcp-openapi", version: "0.1.0" },
    { capabilities: { tools: { listChanged: true }, logging: {} } }
  );

  mcpServer.setRequestHandler(ListToolsRequestSchema, async (request) => {
    const sortedTools = [...state.operations.values()]
      .sort((a, b) => a.operationId.localeCompare(b.operationId))
      .map((op) => ({
        name: op.operationId,
        title: op.title,
        description: op.toolDescription,
        inputSchema: op.inputSchema,
        ...(op.outputSchema ? { outputSchema: op.outputSchema } : {}),
        ...(op.annotations ? { annotations: op.annotations } : {})
      }));

    const { items, nextCursor } = paginateWithCursor(sortedTools, request.params?.cursor, 50);
    return { tools: items, ...(nextCursor ? { nextCursor } : {}) };
  });

  mcpServer.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    if (inFlightCalls >= cli.runtime.maxConcurrency) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: "Too many concurrent tool calls" }, null, 2) }],
        isError: true
      };
    }

    const operation = state.operations.get(request.params.name);
    if (!operation) {
      throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${request.params.name}`);
    }
    if (!isToolAllowed(operation, cli.runtime)) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: `Tool not allowed by policy: ${operation.operationId}` }, null, 2) }],
        isError: true
      };
    }

    const inputZod = state.validators.inputsZod.get(operation.operationId);
    const inputAjv = state.validators.inputsAjv.get(operation.operationId);
    if (!inputZod || !inputAjv) {
      throw new McpError(ErrorCode.InternalError, `Missing input validator for tool: ${operation.operationId}`);
    }

    const args = request.params.arguments ?? {};
    const zodResult = inputZod.safeParse(args);
    if (!zodResult.success) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: "Input validation failed (Zod)", issues: zodResult.error.issues }, null, 2) }],
        isError: true
      };
    }

    const ajvValid = inputAjv(args);
    if (!ajvValid) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: "Input validation failed (JSON Schema)", issues: inputAjv.errors ?? [] }, null, 2) }],
        isError: true
      };
    }

    const progressToken = request.params._meta?.progressToken;
    const start = Date.now();
    metrics.toolCallsTotal += 1;
    metrics.toolCallsInFlight += 1;
    inFlightCalls += 1;

    try {
      await sendLog(mcpServer, "info", { event: "tool_call_start", tool: operation.operationId, requestId: String(extra.requestId) }, extra.sessionId);

      const response = await executeOperation(operation, args, cli.runtime, {
        signal: extra.signal,
        onProgress: async (progress) => {
          if (progressToken === undefined) return;
          await extra.sendNotification({
            method: "notifications/progress",
            params: {
              progressToken,
              progress: progress.progress,
              ...(progress.total !== undefined ? { total: progress.total } : {}),
              ...(progress.message ? { message: progress.message } : {})
            }
          });
        },
        onLog: async (entry) => {
          await sendLog(mcpServer, entry.level, { tool: operation.operationId, ...asObject(entry.data), requestId: String(extra.requestId) }, extra.sessionId);
        }
      });

      const latencyMs = Date.now() - start;
      metrics.toolCallLatencyMsTotal += latencyMs;
      observeLatency(latencyMs);
      observeStatus(response.status);
      if (response.attempts > 1) {
        metrics.retriesTotal += response.attempts - 1;
      }

      if (responseTransform) {
        response.body = await responseTransform({ operation, response: { body: response.body, status: response.status } });
      }

      const structuredContent = toStructuredContent(operation, response.body);
      const outputValidator = state.validators.structuredOutputs.get(operation.operationId);
      let outputValidationIssues: Array<Record<string, unknown>> | undefined;
      if (outputValidator && !outputValidator(structuredContent)) {
        outputValidationIssues = outputValidator.errors;
      }

      const responseValidationIssues = validateResponseByStatus(state, operation, response.status, response.body);

      const payload = {
        ...response,
        responseValidation:
          responseValidationIssues === undefined
            ? { checked: Boolean(operation.responseSchemasByStatus && Object.keys(operation.responseSchemasByStatus).length > 0), valid: true }
            : { checked: true, valid: false, issues: responseValidationIssues },
        outputValidation:
          outputValidationIssues === undefined
            ? { checked: Boolean(outputValidator), valid: true }
            : { checked: true, valid: false, issues: outputValidationIssues }
      };

      const isError = response.status >= 400 || outputValidationIssues !== undefined || responseValidationIssues !== undefined;
      if (isError) {
        metrics.toolCallsFailed += 1;
      }

      await sendLog(
        mcpServer,
        isError ? "warning" : "info",
        { event: "tool_call_complete", tool: operation.operationId, status: response.status, requestId: String(extra.requestId) },
        extra.sessionId
      );

      return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        structuredContent,
        isError
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      metrics.toolCallsFailed += 1;
      if (message.toLowerCase().includes("cancel")) {
        metrics.toolCallsCancelled += 1;
      }

      await sendLog(mcpServer, "error", { event: "tool_call_failed", tool: operation.operationId, detail: message, requestId: String(extra.requestId) }, extra.sessionId);

      return {
        content: [{ type: "text", text: JSON.stringify({ error: message.toLowerCase().includes("cancel") ? "Invocation cancelled" : "Invocation failed", detail: message }, null, 2) }],
        isError: true
      };
    } finally {
      inFlightCalls = Math.max(0, inFlightCalls - 1);
      metrics.toolCallsInFlight = Math.max(0, metrics.toolCallsInFlight - 1);
    }
  });

  return mcpServer;
}

function validateResponseByStatus(
  state: RuntimeState,
  operation: OperationModel,
  status: number,
  body: unknown
): Array<Record<string, unknown>> | undefined {
  const byStatus = state.validators.responsesByStatus.get(operation.operationId);
  if (!byStatus) return undefined;

  const exact = byStatus.get(String(status));
  const generic = byStatus.get(`${String(status)[0]}XX`) ?? byStatus.get("default");
  const validator = exact ?? generic;
  if (!validator) return undefined;

  const ok = validator(body);
  return ok ? undefined : validator.errors;
}

async function startWebServer(state: RuntimeState, cli: CliOptions, specPath: string): Promise<void> {
  if (cli.transport === "sse") {
    await startSseServer(state, cli, specPath);
    return;
  }

  const app = new Hono<{ Bindings: HttpBindings }>();
  app.use(
    "*",
    cors({
      origin: "*",
      allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type", "mcp-session-id", "Last-Event-ID", "mcp-protocol-version"],
      exposeHeaders: ["mcp-session-id", "mcp-protocol-version"]
    })
  );

  app.get("/health", (c) => c.json({ ok: true, transport: cli.transport }));
  app.get("/healthz", (c) => c.json({ ok: true, transport: cli.transport }));
  app.get("/metrics", (c) => c.text(renderPrometheus()));
  app.get("/test/streamable", (c) => c.html(STREAMABLE_TEST_HTML));
  app.get("/test/sse", (c) => c.html(SSE_TEST_HTML));

  app.all("/mcp", async (c) => {
    const transport = new WebStandardStreamableHTTPServerTransport();
    const server = createMcpServer(state, cli);
    await server.connect(transport);
    return transport.handleRequest(c.req.raw);
  });

  if (cli.watchSpec) {
    wireSpecWatcher(specPath, cli, state, async () => {
      // Stateless web transports rebuild handlers per request, no in-session update required.
    });
  }

  const server = serve({ fetch: app.fetch, port: cli.port });
  process.stderr.write(
    `Listening on http://localhost:${cli.port} (${cli.transport})\n` +
      `Health: http://localhost:${cli.port}/health\n` +
      `Metrics: http://localhost:${cli.port}/metrics\n` +
      `Streamable Test: http://localhost:${cli.port}/test/streamable\n` +
      `SSE Test: http://localhost:${cli.port}/test/sse\n`
  );

  wireGracefulShutdown(async () => {
    server.close();
  });

  await new Promise(() => undefined);
}

async function startSseServer(state: RuntimeState, cli: CliOptions, specPath: string): Promise<void> {
  const transports = new Map<string, { transport: SSEServerTransport; createdAt: number }>();

  const server = createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${cli.port}`);

    if (req.method === "GET" && url.pathname === "/health") {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, transport: "sse" }));
      return;
    }

    if (req.method === "GET" && url.pathname === "/metrics") {
      res.statusCode = 200;
      res.setHeader("content-type", "text/plain; version=0.0.4");
      res.end(renderPrometheus());
      return;
    }

    if (req.method === "GET" && url.pathname === "/test/streamable") {
      res.statusCode = 200;
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(STREAMABLE_TEST_HTML);
      return;
    }

    if (req.method === "GET" && url.pathname === "/test/sse") {
      res.statusCode = 200;
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(SSE_TEST_HTML);
      return;
    }

    if (req.method === "GET" && url.pathname === "/sse") {
      if (transports.size >= cli.runtime.sseMaxSessions) {
        res.statusCode = 503;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: "Too many active SSE sessions" }));
        return;
      }

      const transport = new SSEServerTransport("/messages", res);
      transports.set(transport.sessionId, { transport, createdAt: Date.now() });
      transport.onclose = () => transports.delete(transport.sessionId);
      const mcp = createMcpServer(state, cli);
      await mcp.connect(transport);
      return;
    }

    if (req.method === "POST" && url.pathname === "/messages") {
      const sessionId = url.searchParams.get("sessionId");
      if (!sessionId) {
        res.statusCode = 400;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: "Missing sessionId" }));
        return;
      }

      evictExpiredSseSessions(transports, cli.runtime.sseSessionTtlMs);

      const stored = transports.get(sessionId) ?? (transports.size === 1 ? [...transports.values()][0] : undefined);
      if (!stored) {
        res.statusCode = 404;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: "Session not found" }));
        return;
      }

      let parsedBody: unknown = undefined;
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.from(chunk));
      }
      if (chunks.length > 0) {
        parsedBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      }
      await stored.transport.handlePostMessage(req as IncomingMessage, res as ServerResponse, parsedBody);
      return;
    }

    res.statusCode = 404;
    res.end("not found");
  });

  if (cli.watchSpec) {
    wireSpecWatcher(specPath, cli, state, async () => {});
  }

  server.listen(cli.port);
  wireGracefulShutdown(async () => {
    for (const entry of transports.values()) {
      await entry.transport.close();
    }
    server.close();
  });
  process.stderr.write(
    `Listening on http://localhost:${cli.port} (sse)\\n` +
      `Health: http://localhost:${cli.port}/health\\n` +
      `Metrics: http://localhost:${cli.port}/metrics\\n` +
      `SSE Test: http://localhost:${cli.port}/test/sse\\n`
  );

  await new Promise(() => undefined);
}

function wireSpecWatcher(specPath: string, cli: CliOptions, state: RuntimeState, onReload: () => Promise<void>): void {
  let debounce: ReturnType<typeof setTimeout> | undefined;
  watch(specPath, () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(async () => {
      try {
        const next = await loadRuntimeState(specPath, cli.serverUrl, cli.cachePath, cli.compile);
        state.operations = next.operations;
        state.validators = next.validators;
        await onReload();
      } catch (error) {
        process.stderr.write(`Spec reload failed: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }, 200);
  });
}

async function loadRuntimeState(specPath: string, serverUrl: string | undefined, cachePath: string, compile: CompileOptions): Promise<RuntimeState> {
  const doc = await loadOpenApiDocument(specPath);
  const diagnostics = lintOpenApiDocument(doc, compile);
  const errors = diagnostics.filter((d) => d.level === "error");
  if (errors.length > 0) {
    throw new Error(`OpenAPI lint failed:\n${errors.map((d) => `- [${d.code}] ${d.message}${d.location ? ` (${d.location})` : ""}`).join("\n")}`);
  }
  const warnings = diagnostics.filter((d) => d.level === "warning");
  if (warnings.length > 0) {
    process.stderr.write(`${warnings.map((d) => `Warning [${d.code}] ${d.message}${d.location ? ` (${d.location})` : ""}`).join("\n")}\n`);
  }

  const operations = await compileWithCache(specPath, serverUrl, cachePath, compile);
  const validators = buildValidators(operations);
  return { operations, validators };
}

function buildValidators(operations: Map<string, OperationModel>): CompiledValidators {
  const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
  const inputsAjv = new Map<string, Validator>();
  const inputsZod = new Map<string, ReturnType<typeof zodFromJsonSchema>>();
  const structuredOutputs = new Map<string, Validator>();
  const responsesByStatus = new Map<string, Map<string, Validator>>();

  for (const operation of operations.values()) {
    inputsAjv.set(operation.operationId, ajv.compile(operation.inputSchema));
    inputsZod.set(operation.operationId, zodFromJsonSchema(operation.inputSchema));

    if (operation.outputSchema) {
      structuredOutputs.set(operation.operationId, ajv.compile(operation.outputSchema));
    }

    const perStatus = new Map<string, Validator>();
    for (const [status, schema] of Object.entries(operation.responseSchemasByStatus ?? {})) {
      perStatus.set(status, ajv.compile(schema));
    }
    if (perStatus.size > 0) {
      responsesByStatus.set(operation.operationId, perStatus);
    }
  }

  return { inputsAjv, inputsZod, structuredOutputs, responsesByStatus };
}

function toStructuredContent(operation: OperationModel, body: unknown): Record<string, unknown> {
  if (operation.outputWrapKey) return { [operation.outputWrapKey]: body };
  if (isObject(body)) return body as Record<string, unknown>;
  return { result: body };
}

async function sendLog(server: Server, level: LoggingLevel, data: unknown, sessionId?: string): Promise<void> {
  await server.sendLoggingMessage({ level, logger: "mcp-openapi", data: redactSecrets(data) }, sessionId);
}

function redactSecrets(data: unknown): unknown {
  if (!isObject(data)) return data;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    const lower = key.toLowerCase();
    if (lower.includes("authorization") || lower.includes("token") || lower.includes("password") || lower.includes("secret")) {
      out[key] = "[REDACTED]";
    } else {
      out[key] = isObject(value) ? redactSecrets(value) : value;
    }
  }
  return out;
}

async function scaffoldProject(targetDir: string): Promise<void> {
  const dir = resolve(targetDir);
  const srcDir = resolve(dir, "src");
  await mkdir(srcDir, { recursive: true });

  const packageName = basename(dir).replaceAll(/[^a-zA-Z0-9-_]/g, "-").toLowerCase() || "mcp-openapi-server";

  const packageJson = {
    name: packageName,
    private: true,
    version: "0.1.0",
    type: "module",
    scripts: {
      build: "tsc -p tsconfig.json",
      dev: "tsx src/server.ts",
      start: "node dist/server.js",
      check: "tsc -p tsconfig.json --noEmit"
    },
    dependencies: {
      "mcp-openapi": "latest"
    },
    devDependencies: {
      "@types/node": "^22.13.4",
      tsx: "^4.20.3",
      typescript: "^5.7.3"
    }
  };

  const tsconfig = {
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      outDir: "dist",
      rootDir: "src",
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true
    },
    include: ["src/**/*.ts"]
  };

  const entrypoint = [
    "import { spawn } from \"node:child_process\";",
    "",
    "const specPath = process.env.OPENAPI_SPEC ?? \"./openapi.yaml\";",
    "const transport = process.env.MCP_TRANSPORT ?? \"stdio\";",
    "const port = process.env.PORT ?? \"3000\";",
    "",
    "const args = [\"--spec\", specPath, \"--transport\", transport];",
    "if (transport !== \"stdio\") args.push(\"--port\", port);",
    "",
    "const child = spawn(\"mcp-openapi\", args, { stdio: \"inherit\", shell: true, env: process.env });",
    "child.on(\"exit\", (code) => process.exit(code ?? 1));"
  ].join("\n");

  const envExample = [
    "# Required",
    "OPENAPI_SPEC=./openapi.yaml",
    "",
    "# Optional runtime",
    "MCP_TRANSPORT=stdio",
    "PORT=3000",
    "",
    "# Optional auth",
    "MCP_OPENAPI_API_KEY=",
    "MCP_OPENAPI_BEARER_TOKEN=",
    "MCP_OPENAPI_BASIC_USERNAME=",
    "MCP_OPENAPI_BASIC_PASSWORD=",
    "MCP_OPENAPI_OAUTH2_ACCESS_TOKEN=",
    "MCP_OPENAPI_OAUTH2_CLIENT_ID=",
    "MCP_OPENAPI_OAUTH2_CLIENT_SECRET=",
    "MCP_OPENAPI_<SCHEME_NAME>_TOKEN="
  ].join("\n");

  const readme = [
    "# MCP OpenAPI Server",
    "",
    "Generated starter project.",
    "",
    "## Setup",
    "",
    "1. Install dependencies:",
    "   npm install",
    "2. Add your OpenAPI file as `openapi.yaml` (or set `OPENAPI_SPEC`).",
    "3. Start:",
    "   npm run dev",
    "",
    "For web transports:",
    "- StreamableHTTP: `MCP_TRANSPORT=streamable-http npm run dev`",
    "- SSE: `MCP_TRANSPORT=sse npm run dev`",
    "",
    "Health endpoint (web): `http://localhost:3000/health`"
  ].join("\n");

  await writeFile(resolve(dir, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
  await writeFile(resolve(dir, "tsconfig.json"), `${JSON.stringify(tsconfig, null, 2)}\n`, "utf8");
  await writeFile(resolve(srcDir, "server.ts"), `${entrypoint}\n`, "utf8");
  await writeFile(resolve(dir, "README.md"), `${readme}\n`, "utf8");

  await writeFile(resolve(dir, ".env.example"), envExample, "utf8");
  await writeFile(
    resolve(dir, "Dockerfile"),
    [
      "FROM node:20-alpine",
      "WORKDIR /app",
      "COPY . .",
      "RUN npm ci && npm run build",
      "CMD [\"node\", \"dist/server.js\", \"--spec\", \"openapi.yaml\"]"
    ].join("\n"),
    "utf8"
  );
}

function asObject(value: unknown): Record<string, unknown> {
  return isObject(value) ? (value as Record<string, unknown>) : { value };
}

function isToolAllowed(operation: OperationModel, runtime: RuntimeOptions): boolean {
  if (runtime.allowedMethods.length > 0 && !runtime.allowedMethods.includes(operation.method.toUpperCase())) {
    return false;
  }

  if (runtime.allowedPathPrefixes.length > 0 && !runtime.allowedPathPrefixes.some((prefix) => operation.pathTemplate.startsWith(prefix))) {
    return false;
  }

  if (runtime.allowToolPatterns.length > 0 && !runtime.allowToolPatterns.some((pattern) => minimatch(operation.operationId, pattern))) {
    return false;
  }

  if (runtime.denyToolPatterns.some((pattern) => minimatch(operation.operationId, pattern))) {
    return false;
  }

  return true;
}

function minimatch(value: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
  const re = new RegExp(`^${escaped}$`);
  return re.test(value);
}

async function loadResponseTransform(modulePath: string): Promise<(ctx: { operation: OperationModel; response: { body: unknown; status: number } }) => unknown | Promise<unknown>> {
  const loaded = (await import(resolve(modulePath))) as Record<string, unknown>;
  const fn = (typeof loaded.default === "function" ? loaded.default : loaded.transform) as unknown;
  if (typeof fn !== "function") {
    throw new Error(`Response transform module must export default function or named export "transform": ${modulePath}`);
  }
  return fn as (ctx: { operation: OperationModel; response: { body: unknown; status: number } }) => unknown | Promise<unknown>;
}

function evictExpiredSseSessions(transports: Map<string, { transport: SSEServerTransport; createdAt: number }>, ttlMs: number): void {
  const now = Date.now();
  for (const [sessionId, entry] of transports.entries()) {
    if (now - entry.createdAt > ttlMs) {
      void entry.transport.close();
      transports.delete(sessionId);
    }
  }
}

function wireGracefulShutdown(cleanup: () => Promise<void> | void): void {
  const handler = async () => {
    await cleanup();
    process.exit(0);
  };
  process.once("SIGINT", handler);
  process.once("SIGTERM", handler);
}

async function generateProjectFromSpec(targetDir: string, specPath: string, operations: Map<string, OperationModel>, cli: CliOptions): Promise<void> {
  const dir = resolve(targetDir);
  const srcDir = resolve(dir, "src");
  await mkdir(srcDir, { recursive: true });

  const generated = [
    "import { spawn } from \"node:child_process\";",
    "",
    "const transport = process.env.MCP_TRANSPORT ?? \"stdio\";",
    "const port = process.env.PORT ?? \"3000\";",
    "const args = [",
    `  "--spec", ${JSON.stringify(specPath)},`,
    cli.serverUrl ? `  "--server-url", ${JSON.stringify(cli.serverUrl)},` : "",
    `  "--tool-name-template", ${JSON.stringify(cli.compile.toolNameTemplate ?? "{operationId}")},`,
    cli.compile.strict ? "  \"--strict\"," : "",
    "  \"--transport\", transport",
    "].filter(Boolean) as string[];",
    "if (transport !== \"stdio\") args.push(\"--port\", port);",
    "const child = spawn(\"mcp-openapi\", args, { stdio: \"inherit\", shell: true, env: process.env });",
    "child.on(\"exit\", (code) => process.exit(code ?? 1));"
  ]
    .filter(Boolean)
    .join("\n");

  await writeFile(resolve(srcDir, "server.ts"), `${generated}\n`, "utf8");
  await writeFile(
    resolve(dir, "package.json"),
    `${JSON.stringify(
      {
        name: `${basename(dir).replaceAll(/[^a-zA-Z0-9-_]/g, "-").toLowerCase()}-generated`,
        private: true,
        version: "0.1.0",
        type: "module",
        scripts: {
          dev: "tsx src/server.ts",
          build: "tsc -p tsconfig.json",
          start: "node dist/server.js"
        },
        dependencies: { "mcp-openapi": "latest" },
        devDependencies: { typescript: "^5.7.3", tsx: "^4.20.3", "@types/node": "^22.13.4" }
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  await writeFile(
    resolve(dir, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          outDir: "dist",
          rootDir: "src",
          strict: true,
          skipLibCheck: true
        },
        include: ["src/**/*.ts"]
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  await writeFile(
    resolve(dir, "README.md"),
    `# Generated MCP Server\n\nGenerated from \`${specPath}\`.\n\n## Tools\n\n${[...operations.values()]
      .map((x) => `- \`${x.operationId}\` (${x.method} ${x.pathTemplate})`)
      .join("\n")}\n`,
    "utf8"
  );
}

function parseArgs(argv: string[]): CliOptions {
  let command: CliOptions["command"] = "run";
  let initDir: string | undefined;
  let generateDir: string | undefined;
  let specPath = "";
  let serverUrl: string | undefined;
  let cachePath = ".cache/mcp-openapi-cache.json";
  let strict = false;
  let toolNameTemplate = "{operationId}";
  let printTools = false;
  let validateSpec = false;
  let watchSpec = false;
  let transport: CliOptions["transport"] = "stdio";
  let port = 3000;
  let timeoutMs = 20_000;
  let retries = 2;
  let retryDelayMs = 500;
  let maxResponseBytes = 2_000_000;
  let maxConcurrency = 8;
  let allowedHosts: string[] = [];
  let allowToolPatterns: string[] = [];
  let denyToolPatterns: string[] = [];
  let allowedMethods: string[] = [];
  let allowedPathPrefixes: string[] = [];
  let responseTransformModule: string | undefined;
  let sseMaxSessions = 100;
  let sseSessionTtlMs = 300_000;

  if (argv[0] === "init") {
    command = "init";
    initDir = argv[1] || process.cwd();
    return {
      command,
      initDir,
      specPath,
      serverUrl,
      cachePath,
      compile: { strict, toolNameTemplate },
      printTools,
      validateSpec,
      watchSpec,
      transport,
      port,
      runtime: {
        timeoutMs,
        retries,
        retryDelayMs,
        maxResponseBytes,
        allowedHosts,
        maxConcurrency,
        allowToolPatterns,
        denyToolPatterns,
        allowedMethods,
        allowedPathPrefixes,
        responseTransformModule,
        sseMaxSessions,
        sseSessionTtlMs
      }
    };
  }
  if (argv[0] === "generate") {
    command = "generate";
    argv = argv.slice(1);
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--spec") {
      specPath = argv[++i] ?? "";
      continue;
    }
    if (arg === "--server-url") {
      serverUrl = argv[++i];
      continue;
    }
    if (arg === "--cache-path") {
      cachePath = argv[++i] ?? cachePath;
      continue;
    }
    if (arg === "--out-dir") {
      generateDir = argv[++i] ?? "generated-mcp-server";
      continue;
    }
    if (arg === "--strict") {
      strict = true;
      continue;
    }
    if (arg === "--tool-name-template") {
      toolNameTemplate = argv[++i] ?? toolNameTemplate;
      continue;
    }
    if (arg === "--print-tools") {
      printTools = true;
      continue;
    }
    if (arg === "--validate-spec") {
      validateSpec = true;
      continue;
    }
    if (arg === "--timeout-ms") {
      timeoutMs = parsePositiveInt(argv[++i], "--timeout-ms");
      continue;
    }
    if (arg === "--retries") {
      retries = parseNonNegativeInt(argv[++i], "--retries");
      continue;
    }
    if (arg === "--retry-delay-ms") {
      retryDelayMs = parsePositiveInt(argv[++i], "--retry-delay-ms");
      continue;
    }
    if (arg === "--max-response-bytes") {
      maxResponseBytes = parsePositiveInt(argv[++i], "--max-response-bytes");
      continue;
    }
    if (arg === "--max-concurrency") {
      maxConcurrency = parsePositiveInt(argv[++i], "--max-concurrency");
      continue;
    }
    if (arg === "--allow-hosts") {
      allowedHosts = parseCsv(argv[++i]);
      continue;
    }
    if (arg === "--allow-tools") {
      allowToolPatterns = parseCsv(argv[++i]);
      continue;
    }
    if (arg === "--deny-tools") {
      denyToolPatterns = parseCsv(argv[++i]);
      continue;
    }
    if (arg === "--allow-methods") {
      allowedMethods = parseCsv(argv[++i]).map((x) => x.toUpperCase());
      continue;
    }
    if (arg === "--allow-path-prefixes") {
      allowedPathPrefixes = parseCsv(argv[++i]);
      continue;
    }
    if (arg === "--response-transform") {
      responseTransformModule = argv[++i];
      continue;
    }
    if (arg === "--sse-max-sessions") {
      sseMaxSessions = parsePositiveInt(argv[++i], "--sse-max-sessions");
      continue;
    }
    if (arg === "--sse-session-ttl-ms") {
      sseSessionTtlMs = parsePositiveInt(argv[++i], "--sse-session-ttl-ms");
      continue;
    }
    if (arg === "--transport") {
      const value = argv[++i] as CliOptions["transport"] | undefined;
      if (value !== "stdio" && value !== "streamable-http" && value !== "sse") {
        throw new Error("Invalid --transport value; use stdio|streamable-http|sse");
      }
      transport = value;
      continue;
    }
    if (arg === "--port") {
      port = parsePositiveInt(argv[++i], "--port");
      continue;
    }
    if (arg === "--watch-spec") {
      watchSpec = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }

  if (!specPath) {
    printHelp();
    throw new Error("Missing required argument: --spec <path-to-openapi-file>");
  }

  return {
    command,
    initDir,
    generateDir,
    specPath,
    serverUrl,
    cachePath,
    compile: { strict, toolNameTemplate },
    printTools,
    validateSpec,
    watchSpec,
    transport,
    port,
    runtime: {
      timeoutMs,
      retries,
      retryDelayMs,
      maxResponseBytes,
      allowedHosts,
      maxConcurrency,
      allowToolPatterns,
      denyToolPatterns,
      allowedMethods,
      allowedPathPrefixes,
      responseTransformModule,
      sseMaxSessions,
      sseSessionTtlMs
    }
  };
}

function parseCsv(value: string | undefined): string[] {
  return String(value ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function parsePositiveInt(value: string | undefined, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid value for ${flag}: expected positive integer`);
  }
  return parsed;
}

function parseNonNegativeInt(value: string | undefined, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid value for ${flag}: expected non-negative integer`);
  }
  return parsed;
}

function printHelp(): void {
  process.stderr.write(
    [
      "Usage:",
      "  mcp-openapi init [dir]",
      "  mcp-openapi generate --spec <openapi-file> [--out-dir ./generated]",
      "  mcp-openapi --spec <openapi-file> [options]",
      "",
      "Options:",
      "  --server-url <url>",
      "  --cache-path <file>",
      "  --out-dir <dir>",
      "  --strict",
      "  --tool-name-template <template>",
      "  --print-tools",
      "  --validate-spec",
      "  --transport stdio|streamable-http|sse",
      "  --port <n>",
      "  --watch-spec",
      "  --timeout-ms <ms>",
      "  --retries <n>",
      "  --retry-delay-ms <ms>",
      "  --max-response-bytes <n>",
      "  --max-concurrency <n>",
      "  --allow-hosts host1,host2",
      "  --allow-tools pattern1,pattern2",
      "  --deny-tools pattern1,pattern2",
      "  --allow-methods GET,POST",
      "  --allow-path-prefixes /v1,/public",
      "  --response-transform <module-path>",
      "  --sse-max-sessions <n>",
      "  --sse-session-ttl-ms <ms>",
      "",
      "Auth env vars:",
      "  MCP_OPENAPI_API_KEY",
      "  MCP_OPENAPI_BEARER_TOKEN",
      "  MCP_OPENAPI_BASIC_USERNAME",
      "  MCP_OPENAPI_BASIC_PASSWORD",
      "  MCP_OPENAPI_OAUTH2_ACCESS_TOKEN",
      "  MCP_OPENAPI_OAUTH2_CLIENT_ID",
      "  MCP_OPENAPI_OAUTH2_CLIENT_SECRET",
      "  MCP_OPENAPI_<SCHEME_NAME>_TOKEN"
    ].join("\n") + "\n"
  );
}

function isObject(value: unknown): value is object {
  return value !== null && typeof value === "object";
}

main().catch((error) => {
  process.stderr.write(`Fatal: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
