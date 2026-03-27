import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileOperations } from "../src/compiler.js";
import { loadOpenApiDocument } from "../src/openapi.js";

test("loadOpenApiDocument tolerates missing internal refs while preserving valid ones", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-openapi-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const specPath = join(dir, "broken-internal-ref.json");
  const spec = {
    openapi: "3.0.3",
    info: {
      title: "Broken internal ref",
      version: "1.0.0"
    },
    servers: [{ url: "https://api.example.com" }],
    paths: {
      "/widgets": {
        get: {
          operationId: "listWidgets",
          parameters: [
            { $ref: "#/components/parameters/pageSize" },
            { $ref: "#/components/parameters/MissingParam" }
          ],
          responses: {
            "200": {
              description: "ok",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/WidgetList" }
                }
              }
            }
          }
        }
      }
    },
    components: {
      parameters: {
        pageSize: {
          name: "pageSize",
          in: "query",
          schema: { type: "integer" }
        }
      },
      schemas: {
        WidgetList: {
          type: "object",
          properties: {
            items: {
              type: "array",
              items: { $ref: "#/components/schemas/Widget" }
            }
          }
        },
        Widget: {
          allOf: [
            { $ref: "#/components/schemas/MissingBase" },
            {
              type: "object",
              properties: {
                id: { type: "string" }
              }
            }
          ]
        }
      }
    }
  };

  await writeFile(specPath, JSON.stringify(spec), "utf8");

  const doc = await loadOpenApiDocument(specPath);

  const paths = (doc.paths ?? {}) as Record<string, unknown>;
  const widgetsPath = (paths["/widgets"] ?? {}) as Record<string, unknown>;
  const getOperation = (widgetsPath.get ?? {}) as Record<string, unknown>;
  const parameters = (getOperation.parameters ?? []) as unknown[];
  assert.equal(parameters.length, 2);
  assert.equal((parameters[0] as Record<string, unknown>).name, "pageSize");
  assert.deepEqual(parameters[1], {});

  const components = (doc.components ?? {}) as Record<string, unknown>;
  const schemas = (components.schemas ?? {}) as Record<string, unknown>;
  const widget = (schemas.Widget ?? {}) as Record<string, unknown>;
  const widgetAllOf = (widget.allOf ?? []) as unknown[];
  assert.equal(widgetAllOf.length, 2);
  assert.deepEqual(widgetAllOf[0], {});
  assert.equal(
    (((widgetAllOf[1] as Record<string, unknown>).properties as Record<string, unknown>).id as Record<string, unknown>).type,
    "string"
  );

  const operations = compileOperations(doc);
  const op = operations.get("listWidgets");
  assert.ok(op);
  assert.deepEqual(
    op.parameters.map((param) => param.name),
    ["pageSize"]
  );
  assert.ok(op.successResponseSchema);
});

test("loadOpenApiDocument still fails on missing external refs", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-openapi-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const specPath = join(dir, "missing-external-ref.json");
  const spec = {
    openapi: "3.0.3",
    info: {
      title: "Missing external ref",
      version: "1.0.0"
    },
    servers: [{ url: "https://api.example.com" }],
    paths: {
      "/widgets": {
        get: {
          operationId: "listWidgets",
          responses: {
            "200": {
              description: "ok",
              content: {
                "application/json": {
                  schema: { $ref: "./schemas.json#/WidgetList" }
                }
              }
            }
          }
        }
      }
    }
  };

  await writeFile(specPath, JSON.stringify(spec), "utf8");

  await assert.rejects(() => loadOpenApiDocument(specPath));
});
