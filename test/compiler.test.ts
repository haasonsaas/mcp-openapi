import test from "node:test";
import assert from "node:assert/strict";
import { compileOperations } from "../src/compiler.js";

test("compileOperations normalizes nullable and combiners", () => {
  const doc = {
    openapi: "3.0.3",
    servers: [{ url: "http://example.test" }],
    paths: {
      "/users": {
        post: {
          operationId: "createUser",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    nickname: { type: "string", nullable: true },
                    profile: {
                      oneOf: [{ type: "string" }, { type: "number" }],
                      nullable: true
                    },
                    tags: {
                      type: "array",
                      items: {
                        allOf: [{ type: "string" }],
                        nullable: true
                      }
                    }
                  }
                }
              }
            }
          },
          responses: {
            "200": {
              description: "ok",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      id: { type: "string" }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  } as Record<string, unknown>;

  const operations = compileOperations(doc);
  const op = operations.get("createUser");
  assert.ok(op);

  const schema = op.inputSchema as Record<string, unknown>;
  const body = ((schema.properties as Record<string, unknown>).body ?? {}) as Record<string, unknown>;
  const properties = (body.properties ?? {}) as Record<string, unknown>;

  const nickname = properties.nickname as Record<string, unknown>;
  assert.deepEqual(nickname.type, ["string", "null"]);

  const profile = properties.profile as Record<string, unknown>;
  assert.ok(Array.isArray(profile.oneOf));
  assert.equal((profile.oneOf as unknown[]).length, 3);

  const tags = properties.tags as Record<string, unknown>;
  const items = tags.items as Record<string, unknown>;
  assert.ok(Array.isArray(items.anyOf));
  assert.equal((items.anyOf as unknown[]).length, 2);

  assert.equal(op.responseContentType, "application/json");
  assert.ok(op.successResponseSchema);
  assert.ok(op.outputSchema);
});

test("compileOperations builds object outputSchema for non-object responses and resolves server variables", () => {
  const doc = {
    openapi: "3.0.3",
    servers: [{ url: "https://{region}.example.com", variables: { region: { default: "us" } } }],
    paths: {
      "/items": {
        get: {
          operationId: "list.items!",
          responses: {
            "200": {
              description: "ok",
              content: {
                "application/json": {
                  schema: {
                    type: "array",
                    items: { type: "string" }
                  }
                }
              }
            }
          }
        }
      }
    }
  } as Record<string, unknown>;

  const operations = compileOperations(doc);
  const op = operations.get("list_items");
  assert.ok(op);

  assert.equal(op.servers[0], "https://us.example.com");
  assert.equal(op.outputWrapKey, "result");

  const output = op.outputSchema as Record<string, unknown>;
  assert.equal(output.type, "object");
  const resultSchema = ((output.properties as Record<string, unknown>).result ?? {}) as Record<string, unknown>;
  assert.equal(resultSchema.type, "array");
});

