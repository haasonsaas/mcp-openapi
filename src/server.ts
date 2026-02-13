#!/usr/bin/env node
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { watch } from "node:fs";
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
import { compileOperations } from "./compiler.js";
import { executeOperation } from "./http.js";
import { STREAMABLE_TEST_HTML, SSE_TEST_HTML } from "./html.js";
import { loadOpenApiDocument } from "./openapi.js";
import { paginateWithCursor } from "./pagination.js";
import type { OperationModel, RuntimeOptions } from "./types.js";
import { zodFromJsonSchema } from "./zod-schema.js";

const require = createRequire(import.meta.url);
const Ajv = require("ajv");

type Validator = ((data: unknown) => boolean) & { errors?: Array<Record<string, unknown>> };

interface CompiledValidators {
  inputsAjv: Map<string, Validator>;
  successResponses: Map<string, Validator>;
  structuredOutputs: Map<string, Validator>;
  inputsZod: Map<string, ReturnType<typeof zodFromJsonSchema>>;
}

interface RuntimeState {
  operations: Map<string, OperationModel>;
  validators: CompiledValidators;
}

interface CliOptions {
  specPath: string;
  serverUrl?: string;
  watchSpec: boolean;
  transport: "stdio" | "streamable-http" | "sse";
  port: number;
  runtime: RuntimeOptions;
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));
  const specPath = resolve(cli.specPath);

  const state: RuntimeState = await loadRuntimeState(specPath, cli.serverUrl);

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
    {
      name: "mcp-openapi",
      version: "0.1.0"
    },
    {
      capabilities: {
        tools: { listChanged: true },
        logging: {}
      }
    }
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

    return {
      tools: items,
      ...(nextCursor ? { nextCursor } : {})
    };
  });

  mcpServer.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const operation = state.operations.get(request.params.name);
    if (!operation) {
      throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${request.params.name}`);
    }

    const inputZod = state.validators.inputsZod.get(operation.operationId);
    if (!inputZod) {
      throw new McpError(ErrorCode.InternalError, `No Zod validator for tool: ${operation.operationId}`);
    }

    const inputAjv = state.validators.inputsAjv.get(operation.operationId);
    if (!inputAjv) {
      throw new McpError(ErrorCode.InternalError, `No Ajv validator for tool: ${operation.operationId}`);
    }

    const args = request.params.arguments ?? {};
    const zodResult = inputZod.safeParse(args);
    if (!zodResult.success) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                error: "Input validation failed (Zod)",
                issues: zodResult.error.issues
              },
              null,
              2
            )
          }
        ],
        isError: true
      };
    }

    const ajvValid = inputAjv(args);
    if (!ajvValid) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                error: "Input validation failed (JSON Schema)",
                issues: inputAjv.errors ?? []
              },
              null,
              2
            )
          }
        ],
        isError: true
      };
    }

    const progressToken = request.params._meta?.progressToken;

    try {
      await sendLog(mcpServer, "info", { event: "tool_call_start", tool: operation.operationId }, extra.sessionId);

      const response = await executeOperation(operation, args, cli.runtime, {
        signal: extra.signal,
        onProgress: async (progress) => {
          if (progressToken === undefined) {
            return;
          }

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
          await sendLog(mcpServer, entry.level, { tool: operation.operationId, ...asObject(entry.data) }, extra.sessionId);
        }
      });

      const successResponseValidator = state.validators.successResponses.get(operation.operationId);
      let responseValidationIssues: Array<Record<string, unknown>> | undefined;

      if (response.status >= 200 && response.status < 300 && successResponseValidator) {
        const bodiesToValidate = Array.isArray(response.pageBodies) ? response.pageBodies : [response.body];
        for (const body of bodiesToValidate) {
          const validResponseBody = successResponseValidator(body);
          if (!validResponseBody) {
            responseValidationIssues = successResponseValidator.errors;
            break;
          }
        }
      }

      const structuredContent = toStructuredContent(operation, response.body);
      const outputValidator = state.validators.structuredOutputs.get(operation.operationId);
      let outputValidationIssues: Array<Record<string, unknown>> | undefined;
      if (outputValidator) {
        const outputValid = outputValidator(structuredContent);
        if (!outputValid) {
          outputValidationIssues = outputValidator.errors;
        }
      }

      const payload = {
        ...response,
        responseValidation:
          responseValidationIssues === undefined
            ? { checked: Boolean(successResponseValidator), valid: true }
            : { checked: true, valid: false, issues: responseValidationIssues },
        outputValidation:
          outputValidationIssues === undefined
            ? { checked: Boolean(outputValidator), valid: true }
            : { checked: true, valid: false, issues: outputValidationIssues }
      };

      await sendLog(
        mcpServer,
        response.status >= 400 ? "warning" : "info",
        { event: "tool_call_complete", tool: operation.operationId, status: response.status },
        extra.sessionId
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(payload, null, 2)
          }
        ],
        structuredContent,
        isError: response.status >= 400 || outputValidationIssues !== undefined
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      await sendLog(mcpServer, "error", { event: "tool_call_failed", tool: operation.operationId, detail: message }, extra.sessionId);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                error: message.toLowerCase().includes("cancel") ? "Invocation cancelled" : "Invocation failed",
                detail: message
              },
              null,
              2
            )
          }
        ],
        isError: true
      };
    }
  });

  return mcpServer;
}

async function startWebServer(state: RuntimeState, cli: CliOptions, specPath: string): Promise<void> {
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
  app.get("/test/streamable", (c) => c.html(STREAMABLE_TEST_HTML));
  app.get("/test/sse", (c) => c.html(SSE_TEST_HTML));

  if (cli.transport === "streamable-http") {
    app.all("/mcp", async (c) => {
      const transport = new WebStandardStreamableHTTPServerTransport();
      const server = createMcpServer(state, cli);
      await server.connect(transport);
      return transport.handleRequest(c.req.raw);
    });
  } else {
    const transports = new Map<string, SSEServerTransport>();

    app.get("/sse", async (c) => {
      const transport = new SSEServerTransport("/messages", c.env.outgoing as ServerResponse);
      transports.set(transport.sessionId, transport);
      transport.onclose = () => {
        transports.delete(transport.sessionId);
      };

      const server = createMcpServer(state, cli);
      await server.connect(transport);
      return c.newResponse(null);
    });

    app.post("/messages", async (c) => {
      const sessionId = c.req.query("sessionId");
      if (!sessionId) {
        return c.json({ error: "Missing sessionId" }, 400);
      }

      const transport = transports.get(sessionId);
      if (!transport) {
        return c.json({ error: "Session not found" }, 404);
      }

      const body = await c.req.json().catch(() => undefined);
      await transport.handlePostMessage(c.env.incoming as IncomingMessage, c.env.outgoing as ServerResponse, body);
      return c.newResponse(null);
    });
  }

  if (cli.watchSpec) {
    wireSpecWatcher(specPath, cli, state, async () => {
      // stateless web mode refreshes server instance per request, nothing else required
    });
  }

  serve({ fetch: app.fetch, port: cli.port });
  process.stderr.write(
    `Listening on http://localhost:${cli.port} (${cli.transport})\n` +
      `Health: http://localhost:${cli.port}/health\n` +
      `Streamable Test: http://localhost:${cli.port}/test/streamable\n` +
      `SSE Test: http://localhost:${cli.port}/test/sse\n`
  );

  await new Promise(() => undefined);
}

function wireSpecWatcher(specPath: string, cli: CliOptions, state: RuntimeState, onReload: () => Promise<void>): void {
  let debounce: ReturnType<typeof setTimeout> | undefined;
  watch(specPath, () => {
    if (debounce) {
      clearTimeout(debounce);
    }

    debounce = setTimeout(async () => {
      try {
        const next = await loadRuntimeState(specPath, cli.serverUrl);
        state.operations = next.operations;
        state.validators = next.validators;
        await onReload();
      } catch (error) {
        process.stderr.write(`Spec reload failed: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }, 200);
  });
}

async function loadRuntimeState(specPath: string, serverUrl?: string): Promise<RuntimeState> {
  const doc = await loadOpenApiDocument(specPath);
  const operations = compileOperations(doc, serverUrl);
  const validators = buildValidators(operations);
  return { operations, validators };
}

function buildValidators(operations: Map<string, OperationModel>): CompiledValidators {
  const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
  const inputsAjv = new Map<string, Validator>();
  const successResponses = new Map<string, Validator>();
  const structuredOutputs = new Map<string, Validator>();
  const inputsZod = new Map<string, ReturnType<typeof zodFromJsonSchema>>();

  for (const operation of operations.values()) {
    inputsAjv.set(operation.operationId, ajv.compile(operation.inputSchema));
    inputsZod.set(operation.operationId, zodFromJsonSchema(operation.inputSchema));

    if (operation.successResponseSchema) {
      successResponses.set(operation.operationId, ajv.compile(operation.successResponseSchema));
    }

    if (operation.outputSchema) {
      structuredOutputs.set(operation.operationId, ajv.compile(operation.outputSchema));
    }
  }

  return { inputsAjv, successResponses, structuredOutputs, inputsZod };
}

function toStructuredContent(operation: OperationModel, body: unknown): Record<string, unknown> {
  if (operation.outputWrapKey) {
    return { [operation.outputWrapKey]: body };
  }

  if (isObject(body)) {
    return body as Record<string, unknown>;
  }

  return { result: body };
}

async function sendLog(server: Server, level: LoggingLevel, data: unknown, sessionId?: string): Promise<void> {
  await server.sendLoggingMessage({ level, logger: "mcp-openapi", data }, sessionId);
}

function asObject(value: unknown): Record<string, unknown> {
  return isObject(value) ? (value as Record<string, unknown>) : { value };
}

function parseArgs(argv: string[]): CliOptions {
  let specPath: string | undefined;
  let serverUrl: string | undefined;
  let timeoutMs = 20_000;
  let retries = 2;
  let retryDelayMs = 500;
  let watchSpec = false;
  let transport: CliOptions["transport"] = "stdio";
  let port = 3000;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--spec") {
      specPath = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg === "--server-url") {
      serverUrl = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg === "--timeout-ms") {
      timeoutMs = parsePositiveInt(argv[i + 1], "--timeout-ms");
      i += 1;
      continue;
    }

    if (arg === "--retries") {
      retries = parseNonNegativeInt(argv[i + 1], "--retries");
      i += 1;
      continue;
    }

    if (arg === "--retry-delay-ms") {
      retryDelayMs = parsePositiveInt(argv[i + 1], "--retry-delay-ms");
      i += 1;
      continue;
    }

    if (arg === "--transport") {
      const value = argv[i + 1] as CliOptions["transport"] | undefined;
      if (value !== "stdio" && value !== "streamable-http" && value !== "sse") {
        throw new Error("Invalid --transport value; use stdio|streamable-http|sse");
      }
      transport = value;
      i += 1;
      continue;
    }

    if (arg === "--port") {
      port = parsePositiveInt(argv[i + 1], "--port");
      i += 1;
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
    specPath,
    serverUrl,
    watchSpec,
    transport,
    port,
    runtime: {
      timeoutMs,
      retries,
      retryDelayMs
    }
  };
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
      "Usage: mcp-openapi --spec <openapi-file> [--server-url <url>] [--transport stdio|streamable-http|sse] [--port <n>] [--timeout-ms <ms>] [--retries <n>] [--retry-delay-ms <ms>] [--watch-spec]",
      "",
      "Required:",
      "  --spec            Path to OpenAPI JSON or YAML file",
      "",
      "Optional:",
      "  --server-url      Override OpenAPI server URL",
      "  --transport       stdio (default), streamable-http, sse",
      "  --port            Web transport listen port (default: 3000)",
      "  --timeout-ms      HTTP timeout per attempt (default: 20000)",
      "  --retries         Number of retries for transient errors (default: 2)",
      "  --retry-delay-ms  Base retry delay in ms (default: 500)",
      "  --watch-spec      Reload tools when spec file changes",
      "",
      "Auth env vars:",
      "  MCP_OPENAPI_API_KEY",
      "  MCP_OPENAPI_BEARER_TOKEN",
      "  MCP_OPENAPI_BASIC_USERNAME",
      "  MCP_OPENAPI_BASIC_PASSWORD",
      "  MCP_OPENAPI_OAUTH2_ACCESS_TOKEN",
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
