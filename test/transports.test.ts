import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { CallToolResultSchema, ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";

async function getFreePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((resolve) => s.listen(0, resolve));
  const addr = s.address();
  assert.ok(addr && typeof addr === "object");
  await new Promise<void>((resolve, reject) => s.close((err) => (err ? reject(err) : resolve())));
  return addr.port;
}

async function waitForHealth(port: number): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return;
    } catch {}
    await sleep(100);
  }
  throw new Error("Server did not become healthy");
}

function startWebServer(transport: "streamable-http" | "sse", specPath: string, apiBase: string, port: number): ChildProcessWithoutNullStreams {
  const child = spawn(process.execPath, ["dist/server.js", "--spec", specPath, "--server-url", apiBase, "--transport", transport, "--port", String(port)], {
    cwd: process.cwd(),
    stdio: "pipe"
  });
  return child;
}

async function withApiServer(fn: (apiBase: string) => Promise<void>): Promise<void> {
  const apiServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (req.method === "GET" && url.pathname === "/health") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === "POST" && url.pathname === "/echo") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ message: body.message }));
      return;
    }

    res.statusCode = 404;
    res.end("not found");
  });

  await new Promise<void>((resolve) => apiServer.listen(0, resolve));
  const addr = apiServer.address();
  assert.ok(addr && typeof addr === "object");

  try {
    await fn(`http://127.0.0.1:${addr.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => apiServer.close((err) => (err ? reject(err) : resolve())));
  }
}

test("streamable-http transport integration", async () => {
  await withApiServer(async (apiBase) => {
    const port = await getFreePort();
    const child = startWebServer("streamable-http", "test/fixtures/sample-openapi.yaml", apiBase, port);

    try {
      await waitForHealth(port);

      const client = new Client({ name: "transport-streamable-test", version: "0.1.0" }, { capabilities: {} });
      const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
      await client.connect(transport);

      const tools = await client.request({ method: "tools/list", params: {} }, ListToolsResultSchema);
      assert.ok(tools.tools.some((t) => t.name === "getHealth"));

      const result = await client.request(
        { method: "tools/call", params: { name: "postEcho", arguments: { body: { message: "streamable" } } } },
        CallToolResultSchema
      );
      assert.equal(result.isError, false);
      assert.equal((result.structuredContent as Record<string, unknown>).message, "streamable");

      await transport.close();
    } finally {
      child.kill("SIGTERM");
      await sleep(100);
    }
  });
});

test("sse transport integration", async () => {
  await withApiServer(async (apiBase) => {
    const port = await getFreePort();
    const child = startWebServer("sse", "test/fixtures/sample-openapi.yaml", apiBase, port);

    try {
      await waitForHealth(port);

      const client = new Client({ name: "transport-sse-test", version: "0.1.0" }, { capabilities: {} });
      const transport = new SSEClientTransport(new URL(`http://127.0.0.1:${port}/sse`));
      await client.connect(transport);

      const tools = await client.request({ method: "tools/list", params: {} }, ListToolsResultSchema);
      assert.ok(tools.tools.some((t) => t.name === "getHealth"));

      const result = await client.request(
        { method: "tools/call", params: { name: "postEcho", arguments: { body: { message: "sse" } } } },
        CallToolResultSchema
      );
      assert.equal(result.isError, false);
      assert.equal((result.structuredContent as Record<string, unknown>).message, "sse");

      await transport.close();
    } finally {
      child.kill("SIGTERM");
      await sleep(100);
    }
  });
});
