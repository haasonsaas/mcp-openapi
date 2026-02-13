import test from "node:test";
import assert from "node:assert/strict";
import { lintOpenApiDocument } from "../src/lint.js";

test("lintOpenApiDocument reports strict errors for missing operationId", () => {
  const doc = {
    openapi: "3.0.3",
    servers: [{ url: "https://api.example.com" }],
    paths: {
      "/users": {
        get: {
          responses: {
            "200": { description: "ok" }
          }
        }
      }
    }
  } as Record<string, unknown>;

  const diagnostics = lintOpenApiDocument(doc, { strict: true });
  assert.ok(diagnostics.some((d) => d.code === "OPERATION_ID_MISSING" && d.level === "error"));
});

test("lintOpenApiDocument warns on unsupported request media type", () => {
  const doc = {
    openapi: "3.0.3",
    servers: [{ url: "https://api.example.com" }],
    paths: {
      "/upload": {
        post: {
          operationId: "upload",
          requestBody: {
            content: {
              "application/xml": {
                schema: { type: "string" }
              }
            }
          },
          responses: {
            "200": { description: "ok" }
          }
        }
      }
    }
  } as Record<string, unknown>;

  const diagnostics = lintOpenApiDocument(doc, { strict: false });
  assert.ok(diagnostics.some((d) => d.code === "REQUEST_MEDIA_TYPE_UNSUPPORTED"));
});
