import type { CompileOptions, LintDiagnostic } from "./types.js";

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);
const SUPPORTED_REQUEST_MEDIA_TYPES = new Set([
  "application/json",
  "application/*+json",
  "multipart/form-data",
  "application/x-www-form-urlencoded",
  "application/octet-stream",
  "text/plain"
]);

export function lintOpenApiDocument(doc: Record<string, unknown>, options: CompileOptions = {}): LintDiagnostic[] {
  const diagnostics: LintDiagnostic[] = [];
  const strict = Boolean(options.strict);

  const version = String(doc.openapi ?? "");
  if (!/^3\./.test(version)) {
    diagnostics.push({
      level: strict ? "error" : "warning",
      code: "OPENAPI_VERSION",
      message: `Expected OpenAPI 3.x, got: ${version || "<missing>"}`,
      location: "openapi"
    });
  }

  const servers = Array.isArray(doc.servers) ? doc.servers : [];
  if (servers.length === 0) {
    diagnostics.push({
      level: strict ? "error" : "warning",
      code: "SERVERS_MISSING",
      message: "Document has no servers[]; use --server-url override.",
      location: "servers"
    });
  } else {
    for (let i = 0; i < servers.length; i += 1) {
      const server = servers[i] as Record<string, unknown>;
      if (!isObject(server) || typeof server["url"] !== "string" || !String(server["url"]).trim()) {
        diagnostics.push({
          level: strict ? "error" : "warning",
          code: "SERVER_URL_INVALID",
          message: "Server entry is missing a valid url.",
          location: `servers[${i}]`
        });
      }
    }
  }

  if (isObject(doc.webhooks) && Object.keys(doc.webhooks).length > 0) {
    diagnostics.push({
      level: "warning",
      code: "WEBHOOKS_PRESENT",
      message: "webhooks are present; they are not auto-exposed as tools by default.",
      location: "webhooks"
    });
  }

  const seenOperationIds = new Set<string>();
  const paths = isObject(doc.paths) ? (doc.paths as Record<string, unknown>) : {};
  for (const [path, rawPathItem] of Object.entries(paths)) {
    if (!isObject(rawPathItem)) continue;
    const pathItem = rawPathItem as Record<string, unknown>;

    if (isObject(pathItem.callbacks) && Object.keys(pathItem.callbacks).length > 0) {
      diagnostics.push({
        level: "warning",
        code: "CALLBACKS_PRESENT",
        message: "Path callbacks are present; callback operations are not auto-exposed as tools.",
        location: `paths.${path}.callbacks`
      });
    }

    for (const [method, rawOperation] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(method) || !isObject(rawOperation)) continue;
      const operation = rawOperation as Record<string, unknown>;
      const opLocation = `paths.${path}.${method}`;

      if (typeof operation.operationId !== "string" || !operation.operationId.trim()) {
        diagnostics.push({
          level: strict ? "error" : "warning",
          code: "OPERATION_ID_MISSING",
          message: `Missing operationId for ${method.toUpperCase()} ${path}.`,
          location: opLocation
        });
      } else {
        const id = operation.operationId.trim();
        if (seenOperationIds.has(id)) {
          diagnostics.push({
            level: strict ? "error" : "warning",
            code: "OPERATION_ID_DUPLICATE",
            message: `Duplicate operationId: ${id}`,
            location: `${opLocation}.operationId`
          });
        }
        seenOperationIds.add(id);
      }

      const requestBody = operation.requestBody;
      if (isObject(requestBody) && isObject((requestBody as Record<string, unknown>)["content"])) {
        const content = (requestBody as Record<string, unknown>)["content"] as Record<string, unknown>;
        const mediaTypes = Object.keys(content);
        if (mediaTypes.length > 0 && !mediaTypes.some((x) => SUPPORTED_REQUEST_MEDIA_TYPES.has(x))) {
          diagnostics.push({
            level: strict ? "error" : "warning",
            code: "REQUEST_MEDIA_TYPE_UNSUPPORTED",
            message: `No supported request media type for ${method.toUpperCase()} ${path}.`,
            location: `${opLocation}.requestBody.content`
          });
        }
      }

      const responses = isObject(operation.responses) ? (operation.responses as Record<string, unknown>) : {};
      for (const [status, response] of Object.entries(responses)) {
        if (isObject(response) && isObject((response as Record<string, unknown>)["links"])) {
          diagnostics.push({
            level: "warning",
            code: "LINKS_PRESENT",
            message: "Response links are present; link relations are not translated into MCP tool semantics.",
            location: `${opLocation}.responses.${status}.links`
          });
        }
      }

      const bodySchema = extractRequestSchema(operation);
      if (isObject(bodySchema) && Array.isArray((bodySchema as Record<string, unknown>)["oneOf"])) {
        const discriminator = (bodySchema as Record<string, unknown>)["discriminator"];
        if (!isObject(discriminator)) {
          diagnostics.push({
            level: "warning",
            code: "ONEOF_NO_DISCRIMINATOR",
            message: "oneOf schema without discriminator can be ambiguous for runtime validation.",
            location: `${opLocation}.requestBody`
          });
        }
      }
    }
  }

  return diagnostics;
}

function isObject(value: unknown): value is object {
  return value !== null && typeof value === "object";
}

function extractRequestSchema(operation: Record<string, unknown>): unknown {
  const requestBody = operation["requestBody"];
  if (!isObject(requestBody)) return undefined;
  const content = (requestBody as Record<string, unknown>)["content"];
  if (!isObject(content)) return undefined;
  const first = Object.values(content as Record<string, unknown>)[0];
  if (!isObject(first)) return undefined;
  return (first as Record<string, unknown>)["schema"];
}
