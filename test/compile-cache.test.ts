import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileDocumentWithCache } from "../src/compile-cache.js";
import { loadOpenApiDocument } from "../src/openapi.js";

test("compileDocumentWithCache keys cache off spec contents, not mutated in-memory docs", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-openapi-cache-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const specPath = join(dir, "spec.json");
  const cachePath = join(dir, "compile-cache.json");
  const spec = {
    openapi: "3.0.3",
    info: { title: "Cache test", version: "1.0.0" },
    servers: [{ url: "https://api.example.com" }],
    paths: {
      "/widgets": {
        get: {
          operationId: "listWidgets",
          responses: {
            "200": { description: "ok" }
          }
        }
      }
    }
  };

  await writeFile(specPath, JSON.stringify(spec), "utf8");

  const doc = await loadOpenApiDocument(specPath);
  const first = await compileDocumentWithCache(doc, specPath, undefined, cachePath);
  assert.deepEqual([...first.keys()], ["listWidgets"]);

  const mutatedDoc = structuredClone(doc);
  delete ((mutatedDoc.paths as Record<string, unknown>)["/widgets"] as Record<string, unknown>).get;

  const second = await compileDocumentWithCache(mutatedDoc, specPath, undefined, cachePath);
  assert.deepEqual([...second.keys()], ["listWidgets"]);
});

test("compileDocumentWithCache invalidates when spec contents change", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-openapi-cache-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const specPath = join(dir, "spec.json");
  const cachePath = join(dir, "compile-cache.json");
  const initialSpec = {
    openapi: "3.0.3",
    info: { title: "Cache test", version: "1.0.0" },
    servers: [{ url: "https://api.example.com" }],
    paths: {
      "/widgets": {
        get: {
          operationId: "listWidgets",
          responses: {
            "200": { description: "ok" }
          }
        }
      }
    }
  };

  await writeFile(specPath, JSON.stringify(initialSpec), "utf8");

  const firstDoc = await loadOpenApiDocument(specPath);
  const first = await compileDocumentWithCache(firstDoc, specPath, undefined, cachePath);
  assert.deepEqual([...first.keys()], ["listWidgets"]);

  const updatedSpec = {
    ...initialSpec,
    paths: {
      "/gadgets": {
        post: {
          operationId: "createGadget",
          responses: {
            "201": { description: "created" }
          }
        }
      }
    }
  };
  await writeFile(specPath, JSON.stringify(updatedSpec), "utf8");

  const secondDoc = await loadOpenApiDocument(specPath);
  const second = await compileDocumentWithCache(secondDoc, specPath, undefined, cachePath);
  assert.deepEqual([...second.keys()], ["createGadget"]);
});
