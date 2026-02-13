import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const tsxCli = resolve("node_modules/tsx/dist/cli.mjs");

test("strict mode fails for spec missing operationId", async () => {
  const result = spawnSync(
    process.execPath,
    [tsxCli, "src/server.ts", "--spec", "test/fixtures/missing-operationid-openapi.yaml", "--strict", "--validate-spec"],
    { cwd: process.cwd(), encoding: "utf8" }
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /OPERATION_ID_MISSING/);
});

test("generate command creates project files", async () => {
  const outDir = await mkdtemp(resolve(tmpdir(), "mcp-openapi-generate-"));
  const result = spawnSync(
    process.execPath,
    [tsxCli, "src/server.ts", "generate", "--spec", "test/fixtures/sample-openapi.yaml", "--out-dir", outDir],
    { cwd: process.cwd(), encoding: "utf8" }
  );

  assert.equal(result.status, 0);

  const packageJson = await readFile(resolve(outDir, "package.json"), "utf8");
  const readme = await readFile(resolve(outDir, "README.md"), "utf8");
  const serverTs = await readFile(resolve(outDir, "src/server.ts"), "utf8");

  assert.match(packageJson, /mcp-openapi/);
  assert.match(readme, /Generated MCP Server/);
  assert.match(serverTs, /--spec/);
});
