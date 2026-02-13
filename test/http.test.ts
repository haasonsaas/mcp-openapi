import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { executeOperation } from "../src/http.js";
import type { OperationModel, ParameterSpec } from "../src/types.js";

function createOperation(url: string, overrides?: Partial<OperationModel>): OperationModel {
  return {
    operationId: "listItems",
    method: "GET",
    pathTemplate: "/items",
    description: "list",
    toolDescription: "list",
    inputSchema: { type: "object" },
    parameters: [],
    servers: [url],
    authOptions: [],
    ...overrides
  };
}

test("executeOperation paginates cursor-based responses", async () => {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const cursor = url.searchParams.get("cursor");

    res.setHeader("content-type", "application/json");

    if (!cursor) {
      res.end(JSON.stringify({ items: [1, 2], next_cursor: "c2" }));
      return;
    }

    if (cursor === "c2") {
      res.end(JSON.stringify({ items: [3], next_cursor: "c3" }));
      return;
    }

    res.end(JSON.stringify({ items: [4] }));
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const result = await executeOperation(
    createOperation(baseUrl),
    {
      query: {},
      pagination: { enabled: true, mode: "autoCursor", maxPages: 10, cursorParam: "cursor", nextCursorPath: "next_cursor" }
    },
    { timeoutMs: 5000, retries: 1, retryDelayMs: 5 }
  );

  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));

  assert.equal(result.status, 200);
  assert.ok(result.pagination?.enabled);
  assert.equal(result.pagination?.pagesFetched, 3);
  const body = result.body as Record<string, unknown>;
  assert.deepEqual(body.items, [1, 2, 3, 4]);
});

test("executeOperation retries transient failures", async () => {
  let calls = 0;
  const server = createServer((_req, res) => {
    calls += 1;
    if (calls < 2) {
      res.statusCode = 503;
      res.setHeader("retry-after", "0");
      res.end("busy");
      return;
    }

    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true }));
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const result = await executeOperation(
    createOperation(baseUrl),
    { query: {} },
    { timeoutMs: 5000, retries: 2, retryDelayMs: 5 }
  );

  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));

  assert.equal(result.status, 200);
  assert.equal(result.attempts, 2);
  assert.equal(calls, 2);
});

test("executeOperation serializes deepObject query and form-url-encoded body", async () => {
  let receivedPath = "";
  let receivedBody = "";
  let receivedContentType = "";

  const server = createServer(async (req, res) => {
    receivedPath = req.url ?? "";
    receivedContentType = req.headers["content-type"] ?? "";
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.from(chunk));
    }
    receivedBody = Buffer.concat(chunks).toString("utf8");

    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true }));
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const parameters: ParameterSpec[] = [{ name: "filter", in: "query", required: false, style: "deepObject", explode: true }];

  const result = await executeOperation(
    createOperation(baseUrl, {
      method: "POST",
      parameters,
      requestBodyContentType: "application/x-www-form-urlencoded"
    }),
    {
      query: { filter: { status: "active", role: "admin" } },
      body: { sort: "desc", limit: 10 }
    },
    { timeoutMs: 5000, retries: 0, retryDelayMs: 5 }
  );

  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));

  assert.equal(result.status, 200);
  assert.match(receivedPath, /filter%5Bstatus%5D=active/);
  assert.match(receivedPath, /filter%5Brole%5D=admin/);
  assert.match(receivedContentType, /application\/x-www-form-urlencoded/);
  assert.match(receivedBody, /sort=desc/);
  assert.match(receivedBody, /limit=10/);
});

test("executeOperation supports oauth2 bearer token from env", async () => {
  const previous = process.env.MCP_OPENAPI_OAUTH2_ACCESS_TOKEN;
  process.env.MCP_OPENAPI_OAUTH2_ACCESS_TOKEN = "test-oauth-token";

  let authHeader = "";
  const server = createServer((_req, res) => {
    authHeader = String(_req.headers.authorization ?? "");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true }));
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const result = await executeOperation(
    createOperation(baseUrl, {
      authOptions: [{ schemes: [{ name: "oauth", type: "oauth2" }] }]
    }),
    { query: {} },
    { timeoutMs: 5000, retries: 0, retryDelayMs: 5 }
  );

  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  process.env.MCP_OPENAPI_OAUTH2_ACCESS_TOKEN = previous;

  assert.equal(result.status, 200);
  assert.equal(authHeader, "Bearer test-oauth-token");
});

test("executeOperation respects cancellation signal", async () => {
  const server = createServer((_req, res) => {
    setTimeout(() => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    }, 100);
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    executeOperation(
      createOperation(baseUrl),
      { query: {} },
      { timeoutMs: 5000, retries: 0, retryDelayMs: 5 },
      { signal: controller.signal }
    ),
    /cancelled/i
  );

  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});
