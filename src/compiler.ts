import type { AuthRequirement, JsonSchema, OperationModel, ParameterSpec, SecurityScheme, ToolAnnotations } from "./types.js";

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);

export function compileOperations(doc: Record<string, unknown>, serverOverride?: string): Map<string, OperationModel> {
  const rootServers = getServerUrls(doc, serverOverride);
  const paths = (doc.paths ?? {}) as Record<string, unknown>;
  const globalSecurity = normalizeSecurity(doc.security);
  const securitySchemes = getSecuritySchemes(doc);

  const operations = new Map<string, OperationModel>();

  for (const [pathTemplate, rawPathItem] of Object.entries(paths)) {
    if (!rawPathItem || typeof rawPathItem !== "object") {
      continue;
    }

    const pathItem = rawPathItem as Record<string, unknown>;
    const pathParameters = normalizeParameters(pathItem.parameters);
    const pathSecurity = normalizeSecurity(pathItem.security);

    for (const [method, rawOperation] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(method) || !rawOperation || typeof rawOperation !== "object") {
        continue;
      }

      const operation = rawOperation as Record<string, unknown>;
      const operationId = getOperationId(operation, method, pathTemplate, operations);
      const operationParameters = normalizeParameters(operation.parameters);
      const mergedParameters = mergeParameters(pathParameters, operationParameters);
      const requestBody = normalizeRequestBody(operation.requestBody);
      const response = normalizeSuccessResponse(operation.responses);

      const effectiveSecurity = normalizeSecurity(operation.security) ?? pathSecurity ?? globalSecurity;
      const authOptions = toAuthRequirements(effectiveSecurity, securitySchemes);
      const resolvedServers = resolveServersForOperation(doc, pathItem, operation, rootServers, serverOverride);
      const output = buildOutputSchema(response?.schema);

      const model: OperationModel = {
        operationId,
        title: typeof operation.summary === "string" ? operation.summary : undefined,
        method: method.toUpperCase(),
        pathTemplate,
        description: String(operation.description ?? operation.summary ?? `${method.toUpperCase()} ${pathTemplate}`),
        toolDescription: buildToolDescription(method, pathTemplate, operation, authOptions.length > 0),
        inputSchema: buildInputSchema(mergedParameters, requestBody?.schema),
        outputSchema: output.schema,
        outputWrapKey: output.wrapKey,
        parameters: mergedParameters,
        requestBodyContentType: requestBody?.contentType,
        responseContentType: response?.contentType,
        successResponseSchema: response?.schema,
        servers: resolvedServers,
        authOptions,
        annotations: buildAnnotations(method)
      };

      operations.set(operationId, model);
    }
  }

  if (operations.size === 0) {
    throw new Error("No operations found in OpenAPI document");
  }

  return operations;
}

function resolveServersForOperation(
  doc: Record<string, unknown>,
  pathItem: Record<string, unknown>,
  operation: Record<string, unknown>,
  rootServers: string[],
  override?: string
): string[] {
  if (override) {
    return [override];
  }

  const operationServers = parseServers(operation.servers);
  if (operationServers.length > 0) {
    return operationServers;
  }

  const pathServers = parseServers(pathItem.servers);
  if (pathServers.length > 0) {
    return pathServers;
  }

  const docServers = parseServers(doc.servers);
  return docServers.length > 0 ? docServers : rootServers;
}

function parseServers(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const urls: string[] = [];
  for (const item of value) {
    if (!isObject(item)) {
      continue;
    }

    const rawUrl = (item as Record<string, unknown>).url;
    if (typeof rawUrl !== "string" || !rawUrl.trim()) {
      continue;
    }

    const variables = isObject((item as Record<string, unknown>).variables)
      ? ((item as Record<string, unknown>).variables as Record<string, unknown>)
      : {};

    urls.push(applyServerVariables(rawUrl, variables));
  }

  return urls;
}

function applyServerVariables(urlTemplate: string, variables: Record<string, unknown>): string {
  return urlTemplate.replaceAll(/\{([^}]+)\}/g, (_full, varName: string) => {
    const variable = variables[varName];
    if (!isObject(variable)) {
      return "";
    }

    const variableRecord = variable as Record<string, unknown>;
    if (typeof variableRecord.default === "string") {
      return variableRecord.default;
    }

    if (Array.isArray(variableRecord.enum) && typeof variableRecord.enum[0] === "string") {
      return String(variableRecord.enum[0]);
    }

    return "";
  });
}

function buildAnnotations(method: string): ToolAnnotations {
  const upper = method.toUpperCase();
  const readOnly = upper === "GET" || upper === "HEAD" || upper === "OPTIONS";

  if (readOnly) {
    return {
      readOnlyHint: true,
      idempotentHint: true,
      destructiveHint: false,
      openWorldHint: true
    };
  }

  if (upper === "PUT" || upper === "DELETE") {
    return {
      readOnlyHint: false,
      idempotentHint: true,
      destructiveHint: true,
      openWorldHint: true
    };
  }

  return {
    readOnlyHint: false,
    idempotentHint: false,
    destructiveHint: true,
    openWorldHint: true
  };
}

function buildOutputSchema(successResponseSchema?: JsonSchema): { schema?: JsonSchema; wrapKey?: string } {
  if (!successResponseSchema) {
    return {};
  }

  if (isRootObjectSchema(successResponseSchema)) {
    return { schema: successResponseSchema };
  }

  return {
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        result: successResponseSchema
      },
      required: ["result"]
    },
    wrapKey: "result"
  };
}

function isRootObjectSchema(schema: JsonSchema): boolean {
  if (schema.type === "object") {
    return true;
  }

  if (Array.isArray(schema.type) && schema.type.includes("object")) {
    return true;
  }

  if (isObject(schema.properties) || isObject(schema.additionalProperties)) {
    return true;
  }

  return false;
}

function mergeParameters(pathParameters: ParameterSpec[], opParameters: ParameterSpec[]): ParameterSpec[] {
  const merged = new Map<string, ParameterSpec>();
  for (const param of pathParameters) {
    merged.set(`${param.in}:${param.name}`, param);
  }
  for (const param of opParameters) {
    merged.set(`${param.in}:${param.name}`, param);
  }
  return [...merged.values()];
}

function getOperationId(
  operation: Record<string, unknown>,
  method: string,
  pathTemplate: string,
  existing: Map<string, OperationModel>
): string {
  const rawId = typeof operation.operationId === "string" ? operation.operationId : undefined;
  const fallback = `${method}_${pathTemplate}`
    .replace(/[{}]/g, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");

  let id = normalizeToolName(rawId ?? (fallback || "operation"));
  let i = 1;
  while (existing.has(id)) {
    i += 1;
    id = normalizeToolName(`${id}_${i}`);
  }
  return id;
}

function normalizeToolName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return (cleaned || "operation").slice(0, 128);
}

function buildToolDescription(
  method: string,
  pathTemplate: string,
  operation: Record<string, unknown>,
  requiresAuth: boolean
): string {
  const summary = String(operation.summary ?? "").trim();
  const description = String(operation.description ?? "").trim();
  const firstLine = `${method.toUpperCase()} ${pathTemplate}`;
  const authLine = requiresAuth ? "Auth required." : "No auth required.";

  return [firstLine, summary, description, authLine].filter(Boolean).join("\n");
}

function buildInputSchema(parameters: ParameterSpec[], bodySchema?: JsonSchema): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  const hasQuery = parameters.some((p) => p.in === "query");

  const groups: Record<string, ParameterSpec[]> = {
    path: parameters.filter((p) => p.in === "path"),
    query: parameters.filter((p) => p.in === "query"),
    header: parameters.filter((p) => p.in === "header"),
    cookie: parameters.filter((p) => p.in === "cookie")
  };

  for (const [groupName, items] of Object.entries(groups)) {
    if (items.length === 0) {
      continue;
    }

    const groupProperties: Record<string, JsonSchema> = {};
    const groupRequired: string[] = [];
    for (const param of items) {
      groupProperties[param.name] = param.schema ?? { type: "string" };
      if (param.required) {
        groupRequired.push(param.name);
      }
    }

    properties[groupName] = {
      type: "object",
      additionalProperties: false,
      properties: groupProperties,
      ...(groupRequired.length > 0 ? { required: groupRequired } : {})
    };

    if (groupRequired.length > 0) {
      required.push(groupName);
    }
  }

  if (bodySchema) {
    properties.body = bodySchema;
  }

  if (hasQuery) {
    properties.pagination = {
      type: "object",
      additionalProperties: false,
      properties: {
        enabled: { type: "boolean", default: false },
        mode: { type: "string", enum: ["autoCursor", "incrementPage"], default: "autoCursor" },
        maxPages: { type: "integer", minimum: 1, default: 5 },
        cursorParam: { type: "string", default: "cursor" },
        nextCursorPath: { type: "string", default: "next_cursor" },
        pageParam: { type: "string", default: "page" },
        startPage: { type: "integer", minimum: 1, default: 1 }
      }
    };
  }

  return {
    type: "object",
    additionalProperties: false,
    properties,
    ...(required.length > 0 ? { required } : {})
  };
}

function normalizeParameters(value: unknown): ParameterSpec[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const out: ParameterSpec[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const param = item as Record<string, unknown>;
    const name = typeof param.name === "string" ? param.name : undefined;
    const location = param.in;
    if (!name || !isValidLocation(location)) {
      continue;
    }

    out.push({
      name,
      in: location,
      required: Boolean(param.required),
      style: typeof param.style === "string" ? param.style : undefined,
      explode: typeof param.explode === "boolean" ? param.explode : undefined,
      allowReserved: typeof param.allowReserved === "boolean" ? param.allowReserved : undefined,
      schema: isObject(param.schema) ? normalizeJsonSchema(param.schema as JsonSchema) : undefined
    });
  }

  return out;
}

function normalizeRequestBody(value: unknown): { contentType: string; schema?: JsonSchema } | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const body = value as Record<string, unknown>;
  const content = body.content;
  if (!content || typeof content !== "object") {
    return undefined;
  }

  return pickContentWithSchema(content as Record<string, unknown>);
}

function normalizeSuccessResponse(value: unknown): { contentType?: string; schema?: JsonSchema } | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const responses = value as Record<string, unknown>;
  const preferred = ["200", "201", "202", "203", "204", "2XX", "default"];

  for (const status of preferred) {
    const candidate = responses[status];
    const normalized = normalizeResponseContent(candidate);
    if (normalized) {
      return normalized;
    }
  }

  for (const [status, response] of Object.entries(responses)) {
    if (!status.startsWith("2")) {
      continue;
    }

    const normalized = normalizeResponseContent(response);
    if (normalized) {
      return normalized;
    }
  }

  return undefined;
}

function normalizeResponseContent(value: unknown): { contentType?: string; schema?: JsonSchema } | undefined {
  if (!isObject(value)) {
    return undefined;
  }

  const content = (value as Record<string, unknown>).content;
  if (!isObject(content)) {
    return undefined;
  }

  const picked = pickContentWithSchema(content as Record<string, unknown>);
  if (!picked) {
    return undefined;
  }

  return {
    contentType: picked.contentType,
    schema: picked.schema
  };
}

function pickContentWithSchema(content: Record<string, unknown>): { contentType: string; schema?: JsonSchema } | undefined {
  const candidates = [
    "application/json",
    "application/*+json",
    "multipart/form-data",
    "application/x-www-form-urlencoded",
    "application/octet-stream",
    "text/plain"
  ];
  for (const key of candidates) {
    if (key in content) {
      const mediaType = content[key] as Record<string, unknown>;
      return {
        contentType: key,
        schema: isObject(mediaType?.schema) ? normalizeJsonSchema(mediaType.schema as JsonSchema) : undefined
      };
    }
  }

  const first = Object.entries(content)[0];
  if (!first) {
    return undefined;
  }

  const mediaType = first[1] as Record<string, unknown>;
  return {
    contentType: first[0],
    schema: isObject(mediaType?.schema) ? normalizeJsonSchema(mediaType.schema as JsonSchema) : undefined
  };
}

function normalizeJsonSchema(schema: JsonSchema): JsonSchema {
  return normalizeNode(schema, new WeakMap<object, unknown>()) as JsonSchema;
}

function normalizeNode<T>(node: T, seen: WeakMap<object, unknown>): T {
  if (!isObject(node)) {
    return node;
  }

  if (seen.has(node)) {
    return seen.get(node) as T;
  }

  if (Array.isArray(node)) {
    const arr: unknown[] = [];
    seen.set(node, arr);
    for (const item of node) {
      arr.push(normalizeNode(item, seen));
    }
    return arr as T;
  }

  const source = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  seen.set(node, out);

  for (const [key, value] of Object.entries(source)) {
    if (key === "nullable") {
      continue;
    }
    out[key] = normalizeNode(value, seen);
  }

  if (source.nullable === true) {
    applyNullable(out);
  }

  return out as T;
}

function applyNullable(schema: Record<string, unknown>): void {
  const type = schema.type;
  if (typeof type === "string") {
    schema.type = type === "null" ? "null" : [type, "null"];
    return;
  }

  if (Array.isArray(type)) {
    if (!type.includes("null")) {
      schema.type = [...type, "null"];
    }
    return;
  }

  if (Array.isArray(schema.anyOf)) {
    schema.anyOf = appendNullVariant(schema.anyOf);
    return;
  }

  if (Array.isArray(schema.oneOf)) {
    schema.oneOf = appendNullVariant(schema.oneOf);
    return;
  }

  if (Array.isArray(schema.allOf)) {
    schema.anyOf = [{ allOf: schema.allOf }, { type: "null" }];
    delete schema.allOf;
    return;
  }

  schema.anyOf = [schemaWithoutCombiner(schema), { type: "null" }];
  clearSchemaForCombiner(schema);
}

function appendNullVariant(variants: unknown[]): unknown[] {
  const hasNull = variants.some((variant) => isObject(variant) && (variant as Record<string, unknown>).type === "null");
  if (hasNull) {
    return variants;
  }
  return [...variants, { type: "null" }];
}

function schemaWithoutCombiner(schema: Record<string, unknown>): Record<string, unknown> {
  const out = { ...schema };
  clearSchemaForCombiner(out);
  return out;
}

function clearSchemaForCombiner(schema: Record<string, unknown>): void {
  delete schema.anyOf;
  delete schema.oneOf;
  delete schema.allOf;
}

function getServerUrls(doc: Record<string, unknown>, override?: string): string[] {
  if (override) {
    return [override];
  }

  const urls = parseServers(doc.servers);
  if (urls.length === 0) {
    throw new Error("No valid server URLs found in OpenAPI servers[] and no --server-url override provided");
  }

  return urls;
}

function normalizeSecurity(value: unknown): Array<Record<string, string[]>> | null {
  if (value === undefined) {
    return null;
  }

  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is Record<string, string[]> => isObject(entry));
}

function getSecuritySchemes(doc: Record<string, unknown>): Record<string, SecurityScheme> {
  const components = isObject(doc.components) ? (doc.components as Record<string, unknown>) : {};
  const securitySchemes = isObject(components.securitySchemes)
    ? (components.securitySchemes as Record<string, unknown>)
    : {};

  const out: Record<string, SecurityScheme> = {};
  for (const [name, raw] of Object.entries(securitySchemes)) {
    if (!isObject(raw)) {
      continue;
    }

    const scheme = raw as Record<string, unknown>;
    if (typeof scheme.type !== "string") {
      continue;
    }
    out[name] = {
      name,
      type: String(scheme.type),
      in: isValidIn(scheme.in) ? scheme.in : undefined,
      scheme: typeof scheme.scheme === "string" ? scheme.scheme : undefined
    };
  }

  return out;
}

function toAuthRequirements(
  security: Array<Record<string, string[]>> | null,
  schemes: Record<string, SecurityScheme>
): AuthRequirement[] {
  if (security === null) {
    return [];
  }

  return security
    .map((requirement) => {
      const resolved = Object.keys(requirement)
        .map((name) => schemes[name])
        .filter((x): x is SecurityScheme => Boolean(x));
      return { schemes: resolved };
    })
    .filter((req) => req.schemes.length > 0);
}

function isObject(value: unknown): value is object {
  return value !== null && typeof value === "object";
}

function isValidLocation(value: unknown): value is ParameterSpec["in"] {
  return value === "query" || value === "header" || value === "path" || value === "cookie";
}

function isValidIn(value: unknown): value is "query" | "header" | "cookie" {
  return value === "query" || value === "header" || value === "cookie";
}
