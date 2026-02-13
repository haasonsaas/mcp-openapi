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

async function withEnv(overrides: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  try {
    await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
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
  await withEnv({ MCP_OPENAPI_OAUTH2_ACCESS_TOKEN: "test-oauth-token" }, async () => {
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

    assert.equal(result.status, 200);
    assert.equal(authHeader, "Bearer test-oauth-token");
  });
});

test("executeOperation supports apiKey auth in header, query, and cookie", async () => {
  await withEnv({ MCP_OPENAPI_API_KEY: "api-key-123" }, async () => {
    let seenHeader = "";
    let seenQuery = "";
    let seenCookie = "";
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      seenHeader = String(req.headers["x-api-key"] ?? "");
      seenQuery = url.searchParams.get("api_key") ?? "";
      seenCookie = String(req.headers.cookie ?? "");
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    });

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const result = await executeOperation(
      createOperation(baseUrl, {
        authOptions: [
          {
            schemes: [
              { name: "x-api-key", type: "apiKey", in: "header" },
              { name: "api_key", type: "apiKey", in: "query" },
              { name: "api_cookie", type: "apiKey", in: "cookie" }
            ]
          }
        ]
      }),
      { query: {} },
      { timeoutMs: 5000, retries: 0, retryDelayMs: 5 }
    );

    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));

    assert.equal(result.status, 200);
    assert.equal(seenHeader, "api-key-123");
    assert.equal(seenQuery, "api-key-123");
    assert.match(seenCookie, /api_cookie=api-key-123/);
  });
});

test("executeOperation supports bearer and basic auth", async () => {
  await withEnv(
    {
      MCP_OPENAPI_BEARER_TOKEN: "bearer-token-1",
      MCP_OPENAPI_BASIC_USERNAME: "alice",
      MCP_OPENAPI_BASIC_PASSWORD: "secret"
    },
    async () => {
      let authHeader = "";
      const server = createServer((req, res) => {
        authHeader = String(req.headers.authorization ?? "");
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true }));
      });

      await new Promise<void>((resolve) => server.listen(0, resolve));
      const address = server.address();
      assert.ok(address && typeof address === "object");
      const baseUrl = `http://127.0.0.1:${address.port}`;

      const bearer = await executeOperation(
        createOperation(baseUrl, {
          authOptions: [{ schemes: [{ name: "auth", type: "http", scheme: "bearer" }] }]
        }),
        { query: {} },
        { timeoutMs: 5000, retries: 0, retryDelayMs: 5 }
      );
      assert.equal(bearer.status, 200);
      assert.equal(authHeader, "Bearer bearer-token-1");

      const basic = await executeOperation(
        createOperation(baseUrl, {
          authOptions: [{ schemes: [{ name: "auth", type: "http", scheme: "basic" }] }]
        }),
        { query: {} },
        { timeoutMs: 5000, retries: 0, retryDelayMs: 5 }
      );
      assert.equal(basic.status, 200);
      assert.equal(authHeader, `Basic ${Buffer.from("alice:secret").toString("base64")}`);

      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  );
});

test("executeOperation supports oauth2 client credentials flow", async () => {
  await withEnv(
    {
      MCP_OPENAPI_OAUTH2_ACCESS_TOKEN: undefined,
      MCP_OPENAPI_OAUTH2_CLIENT_ID: "client-1",
      MCP_OPENAPI_OAUTH2_CLIENT_SECRET: "client-secret"
    },
    async () => {
      let tokenRequests = 0;
      let authHeader = "";
      const server = createServer(async (req, res) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (req.method === "POST" && url.pathname === "/token") {
          tokenRequests += 1;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ access_token: "oauth-from-token-endpoint", token_type: "bearer", expires_in: 3600 }));
          return;
        }

        authHeader = String(req.headers.authorization ?? "");
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true }));
      });

      await new Promise<void>((resolve) => server.listen(0, resolve));
      const address = server.address();
      assert.ok(address && typeof address === "object");
      const baseUrl = `http://127.0.0.1:${address.port}`;

      const result = await executeOperation(
        createOperation(baseUrl, {
          authOptions: [{ schemes: [{ name: "oauth", type: "oauth2", tokenUrl: `${baseUrl}/token`, scopes: { read: "r" } }] }]
        }),
        { query: {} },
        { timeoutMs: 5000, retries: 0, retryDelayMs: 5 }
      );

      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));

      assert.equal(result.status, 200);
      assert.equal(tokenRequests, 1);
      assert.equal(authHeader, "Bearer oauth-from-token-endpoint");
    }
  );
});

test("executeOperation enforces allowed hosts", async () => {
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true }));
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  await assert.rejects(
    executeOperation(createOperation(baseUrl), { query: {} }, { timeoutMs: 5000, retries: 0, retryDelayMs: 5, allowedHosts: ["example.com"] }),
    /Target host not allowed/
  );

  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
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
