import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema, ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";

async function withApiServer(fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const apiServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (req.method === "GET" && url.pathname === "/health") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === "POST" && url.pathname === "/echo") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.from(chunk));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ message: body.message }));
      return;
    }

    res.statusCode = 404;
    res.end("not found");
  });

  await new Promise<void>((resolve) => apiServer.listen(0, resolve));
  const address = apiServer.address();
  assert.ok(address && typeof address === "object");

  try {
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => apiServer.close((err) => (err ? reject(err) : resolve())));
  }
}

test("OpenAPI spec becomes MCP tools and can be invoked", async () => {
  await withApiServer(async (apiBase) => {
    const client = new Client({ name: "mcp-openapi-e2e", version: "0.1.0" }, { capabilities: {} });

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["dist/server.js", "--spec", "test/fixtures/sample-openapi.yaml", "--server-url", apiBase],
      cwd: process.cwd(),
      stderr: "pipe"
    });

    await client.connect(transport);

    const listPage1 = await client.request({ method: "tools/list", params: {} }, ListToolsResultSchema);
    assert.ok(listPage1.tools.length >= 2);

    const toolsByName = new Map(listPage1.tools.map((tool) => [tool.name, tool]));
    const healthTool = toolsByName.get("getHealth");
    const echoTool = toolsByName.get("postEcho");

    assert.ok(healthTool);
    assert.ok(echoTool);
    assert.ok(healthTool.outputSchema);
    assert.ok(echoTool.outputSchema);

    const health = await client.request(
      { method: "tools/call", params: { name: "getHealth", arguments: {} } },
      CallToolResultSchema
    );

    assert.equal(health.isError, false);
    assert.equal((health.structuredContent as Record<string, unknown>).ok, true);

    const echo = await client.request(
      { method: "tools/call", params: { name: "postEcho", arguments: { body: { message: "hello" } } } },
      CallToolResultSchema
    );

    assert.equal(echo.isError, false);
    assert.equal((echo.structuredContent as Record<string, unknown>).message, "hello");

    const invalid = await client.request(
      { method: "tools/call", params: { name: "postEcho", arguments: { body: { message: 123 } } } },
      CallToolResultSchema
    );

    assert.equal(invalid.isError, true);
    assert.match(JSON.stringify(invalid.content), /Input validation failed \(Zod\)/);

    await transport.close();
  });
});
