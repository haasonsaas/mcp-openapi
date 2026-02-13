import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema, ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";

async function main(): Promise<void> {
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
  if (!address || typeof address !== "object") {
    throw new Error("Unable to get API server address");
  }

  const apiBase = `http://127.0.0.1:${address.port}`;

  const client = new Client({ name: "mcp-openapi-smoke", version: "0.1.0" }, { capabilities: {} });

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      "dist/server.js",
      "--spec",
      "test/fixtures/sample-openapi.yaml",
      "--server-url",
      apiBase
    ],
    cwd: process.cwd(),
    stderr: "pipe"
  });

  if (transport.stderr) {
    transport.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
    });
  }

  await client.connect(transport);

  const tools = await client.request({ method: "tools/list", params: {} }, ListToolsResultSchema);
  const names = tools.tools.map((tool) => tool.name).sort();

  if (!names.includes("getHealth") || !names.includes("postEcho")) {
    throw new Error(`Unexpected tools list: ${names.join(", ")}`);
  }

  const health = await client.request(
    { method: "tools/call", params: { name: "getHealth", arguments: {} } },
    CallToolResultSchema
  );

  if (health.isError) {
    throw new Error(`Health tool returned error: ${JSON.stringify(health)}`);
  }

  const echo = await client.request(
    { method: "tools/call", params: { name: "postEcho", arguments: { body: { message: "hello" } } } },
    CallToolResultSchema
  );

  if (echo.isError) {
    throw new Error(`Echo tool returned error: ${JSON.stringify(echo)}`);
  }

  const message = (echo.structuredContent as Record<string, unknown>).message;
  if (message !== "hello") {
    throw new Error(`Unexpected echo response: ${JSON.stringify(echo.structuredContent)}`);
  }

  await transport.close();
  await new Promise<void>((resolve, reject) => apiServer.close((err) => (err ? reject(err) : resolve())));

  process.stdout.write("Smoke test passed: OpenAPI spec converted to MCP tools and invoked successfully.\n");
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
