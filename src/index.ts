import { loadOpenApiDocument } from "./openapi.js";
import { compileOperations } from "./compiler.js";
import type { OperationModel, ParameterSpec, AuthRequirement } from "./types.js";

export type JsonSchema = Record<string, unknown>;

export interface NormalizedSpec {
  info: {
    title: string;
    version: string;
    description?: string;
  };
  servers: Array<{ url: string }>;
  endpoints: NormalizedEndpoint[];
  securitySchemes: Record<string, NormalizedSecurityScheme>;
}

export interface NormalizedEndpoint {
  method: "get" | "post" | "put" | "patch" | "delete" | "head" | "options";
  path: string;
  operationId: string;
  summary?: string;
  description?: string;
  parameters: NormalizedParameter[];
  requestBody?: NormalizedRequestBody;
  responses: Record<string, NormalizedResponse>;
  security?: SecurityRequirement[];
  tags?: string[];
  deprecated?: boolean;
}

export interface NormalizedParameter {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  required: boolean;
  description?: string;
  schema: JsonSchema;
}

export interface NormalizedRequestBody {
  required: boolean;
  description?: string;
  contentType: string;
  schema: JsonSchema;
}

export interface NormalizedResponse {
  description?: string;
  contentType?: string;
  schema?: JsonSchema;
}

export type NormalizedSecurityScheme =
  | { type: "apiKey"; name: string; in: "header" | "query" | "cookie" }
  | { type: "http"; scheme: string; bearerFormat?: string }
  | { type: "oauth2"; flows: Record<string, { tokenUrl?: string; scopes: Record<string, string> }> };

export type SecurityRequirement = Record<string, string[]>;

export interface ParameterMapping {
  toolParamName: string;
  source: "path" | "query" | "header" | "body";
  originalName: string;
  required: boolean;
}

export interface GeneratedTool {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  endpointRef: {
    method: string;
    path: string;
    baseUrl: string;
    contentType: string;
    parameterMap: ParameterMapping[];
  };
}

export interface GenerateOptions {
  baseUrl?: string;
  prefix?: string;
  include?: string[];
  exclude?: string[];
}

export interface GenerateResult {
  tools: GeneratedTool[];
  tagMap: Map<string, string[]>;
}

const MAX_TOOL_NAME_LENGTH = 64;

export async function parseSpec(specInput: string): Promise<NormalizedSpec> {
  const doc = await loadOpenApiDocument(specInput);
  const operations = compileOperations(doc);

  // Extract info
  const rawInfo = isRecord(doc.info) ? doc.info : {};
  const info = {
    title: typeof rawInfo.title === "string" ? rawInfo.title : "Unknown API",
    version: typeof rawInfo.version === "string" ? rawInfo.version : "1.0.0",
    ...(typeof rawInfo.description === "string" ? { description: rawInfo.description } : {})
  };

  // Extract servers
  const servers = normalizeServersFromDoc(doc);

  // Convert OperationModels to NormalizedEndpoints
  const endpoints: NormalizedEndpoint[] = [...operations.values()].map((op) => operationToEndpoint(op));

  // Extract security schemes
  const securitySchemes = extractSecuritySchemes(doc);

  return { info, servers, endpoints, securitySchemes };
}

export function generateTools(spec: NormalizedSpec, options: GenerateOptions = {}): GeneratedTool[] {
  return generateToolsWithTags(spec, options).tools;
}

export function generateToolsWithTags(spec: NormalizedSpec, options: GenerateOptions = {}): GenerateResult {
  const baseUrl = options.baseUrl ?? spec.servers[0]?.url ?? "http://localhost";
  let endpoints = spec.endpoints;

  if (options.include?.length) {
    endpoints = endpoints.filter((endpoint) =>
      options.include?.some((pattern) => matchPattern(endpoint.operationId, pattern))
      || options.include?.some((pattern) => matchPattern(endpoint.path, pattern))
    );
  }

  if (options.exclude?.length) {
    endpoints = endpoints.filter((endpoint) =>
      !options.exclude?.some((pattern) => matchPattern(endpoint.operationId, pattern))
      && !options.exclude?.some((pattern) => matchPattern(endpoint.path, pattern))
    );
  }

  const rawNames = endpoints.map((endpoint) =>
    generateToolName(endpoint.operationId, endpoint.method, endpoint.path, options.prefix)
  );
  const resolvedNames = resolveCollisions(rawNames);
  const tagMap = new Map<string, string[]>();

  const tools = endpoints.map((endpoint, index) => {
    const { inputSchema, parameterMap } = buildParams(endpoint);
    const name = resolvedNames[index] as string;
    tagMap.set(name, endpoint.tags ?? []);
    return {
      name,
      description: buildDescription(endpoint),
      inputSchema,
      endpointRef: {
        method: endpoint.method.toUpperCase(),
        path: endpoint.path,
        baseUrl: baseUrl.replace(/\/$/, ""),
        contentType: endpoint.requestBody?.contentType ?? "application/json",
        parameterMap
      }
    } satisfies GeneratedTool;
  });

  return { tools, tagMap };
}

// --- Adapters from OperationModel to library types ---

function operationToEndpoint(op: OperationModel): NormalizedEndpoint {
  const parameters: NormalizedParameter[] = op.parameters.map((p) => ({
    name: p.name,
    in: p.in,
    required: p.required,
    ...(p.schema && typeof (p.schema as Record<string, unknown>).description === "string"
      ? { description: (p.schema as Record<string, unknown>).description as string }
      : {}),
    schema: p.schema ?? { type: "string" }
  }));

  let requestBody: NormalizedRequestBody | undefined;
  if (op.requestBodyContentType) {
    const bodySchema = extractBodySchema(op.inputSchema);
    if (bodySchema) {
      requestBody = {
        required: isBodyRequired(op.inputSchema),
        contentType: op.requestBodyContentType,
        schema: bodySchema
      };
    }
  }

  const responses: Record<string, NormalizedResponse> = {};
  if (op.responseSchemasByStatus) {
    for (const [status, schema] of Object.entries(op.responseSchemasByStatus)) {
      responses[status] = { schema };
    }
  }

  // Reverse map authOptions to SecurityRequirement[]
  const security: SecurityRequirement[] | undefined = op.authOptions.length > 0
    ? op.authOptions.map((req) => {
        const entry: SecurityRequirement = {};
        for (const scheme of req.schemes) {
          entry[scheme.name] = [];
        }
        return entry;
      })
    : undefined;

  return {
    method: op.method.toLowerCase() as NormalizedEndpoint["method"],
    path: op.pathTemplate,
    operationId: op.operationId,
    ...(op.title ? { summary: op.title } : {}),
    ...(op.description && op.description !== `${op.method.toUpperCase()} ${op.pathTemplate}` ? { description: op.description } : {}),
    parameters,
    ...(requestBody ? { requestBody } : {}),
    responses,
    ...(security ? { security } : {}),
    ...(op.tags ? { tags: op.tags } : {})
  };
}

function extractBodySchema(inputSchema: JsonSchema): JsonSchema | undefined {
  const properties = inputSchema.properties as Record<string, unknown> | undefined;
  if (!properties) return undefined;
  const body = properties.body;
  if (!body || typeof body !== "object") return undefined;
  return body as JsonSchema;
}

function isBodyRequired(inputSchema: JsonSchema): boolean {
  const required = inputSchema.required;
  if (!Array.isArray(required)) return false;
  return required.includes("body");
}

function normalizeServersFromDoc(doc: Record<string, unknown>): Array<{ url: string }> {
  const rawServers = doc.servers;
  if (!Array.isArray(rawServers)) {
    return [{ url: "http://localhost" }];
  }

  const servers: Array<{ url: string }> = [];
  for (const entry of rawServers) {
    if (!isRecord(entry) || typeof entry.url !== "string" || !entry.url.trim()) {
      continue;
    }
    const variables = isRecord(entry.variables) ? entry.variables : {};
    servers.push({ url: applyServerVariables(entry.url, variables) });
  }

  return servers.length > 0 ? servers : [{ url: "http://localhost" }];
}

function applyServerVariables(urlTemplate: string, variables: Record<string, unknown>): string {
  return urlTemplate.replaceAll(/\{([^}]+)\}/g, (_full, variableName: string) => {
    const variable = variables[variableName];
    if (!isRecord(variable)) {
      return "";
    }

    if (typeof variable.default === "string") {
      return variable.default;
    }

    if (Array.isArray(variable.enum) && typeof variable.enum[0] === "string") {
      return String(variable.enum[0]);
    }

    return "";
  });
}

function extractSecuritySchemes(doc: Record<string, unknown>): Record<string, NormalizedSecurityScheme> {
  const components = isRecord(doc.components) ? doc.components : {};
  const securitySchemes = isRecord(components.securitySchemes) ? components.securitySchemes : {};
  const normalized: Record<string, NormalizedSecurityScheme> = {};

  for (const [name, rawScheme] of Object.entries(securitySchemes)) {
    if (!isRecord(rawScheme) || typeof rawScheme.type !== "string") {
      continue;
    }

    if (rawScheme.type === "apiKey" && isSecuritySchemeLocation(rawScheme.in) && typeof rawScheme.name === "string") {
      normalized[name] = {
        type: "apiKey",
        in: rawScheme.in,
        name: rawScheme.name
      };
      continue;
    }

    if (rawScheme.type === "http" && typeof rawScheme.scheme === "string") {
      normalized[name] = {
        type: "http",
        scheme: rawScheme.scheme,
        ...(typeof rawScheme.bearerFormat === "string" ? { bearerFormat: rawScheme.bearerFormat } : {})
      };
      continue;
    }

    if (rawScheme.type === "oauth2" && isRecord(rawScheme.flows)) {
      const flows: Record<string, { tokenUrl?: string; scopes: Record<string, string> }> = {};
      for (const [flowName, rawFlow] of Object.entries(rawScheme.flows)) {
        if (!isRecord(rawFlow)) {
          continue;
        }
        flows[flowName] = {
          ...(typeof rawFlow.tokenUrl === "string" ? { tokenUrl: rawFlow.tokenUrl } : {}),
          scopes: isRecord(rawFlow.scopes) ? coerceStringRecord(rawFlow.scopes) : {}
        };
      }
      normalized[name] = { type: "oauth2", flows };
    }
  }

  return normalized;
}

// --- Tool generation helpers (kept from original) ---

function buildParams(endpoint: NormalizedEndpoint): { inputSchema: JsonSchema; parameterMap: ParameterMapping[] } {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  const parameterMap: ParameterMapping[] = [];
  const usedNames = new Set<string>();

  for (const parameter of endpoint.parameters.filter((entry) => entry.in === "path")) {
    const name = ensureUnique(parameter.name, usedNames);
    properties[name] = {
      ...parameter.schema,
      ...(parameter.description ? { description: parameter.description } : {})
    };
    required.push(name);
    parameterMap.push({
      toolParamName: name,
      source: "path",
      originalName: parameter.name,
      required: true
    });
  }

  for (const parameter of endpoint.parameters.filter((entry) => entry.in === "query")) {
    const name = ensureUnique(parameter.name, usedNames, "query");
    properties[name] = {
      ...parameter.schema,
      ...(parameter.description ? { description: parameter.description } : {})
    };
    if (parameter.required) {
      required.push(name);
    }
    parameterMap.push({
      toolParamName: name,
      source: "query",
      originalName: parameter.name,
      required: parameter.required
    });
  }

  const skippedHeaders = new Set(["content-type", "accept", "authorization"]);
  for (const parameter of endpoint.parameters.filter((entry) => entry.in === "header" && !skippedHeaders.has(entry.name.toLowerCase()))) {
    const name = ensureUnique(parameter.name, usedNames, "header");
    properties[name] = {
      ...parameter.schema,
      ...(parameter.description ? { description: parameter.description } : {})
    };
    if (parameter.required) {
      required.push(name);
    }
    parameterMap.push({
      toolParamName: name,
      source: "header",
      originalName: parameter.name,
      required: parameter.required
    });
  }

  if (endpoint.requestBody?.schema) {
    const bodySchema = endpoint.requestBody.schema;
    const bodyProperties = isRecord(bodySchema.properties) ? bodySchema.properties : {};
    if (Object.keys(bodyProperties).length > 0 && Object.keys(bodyProperties).length <= 15) {
      for (const [propertyName, propertySchema] of Object.entries(bodyProperties)) {
        const name = ensureUnique(propertyName, usedNames, "body");
        properties[name] = isRecord(propertySchema) ? propertySchema : { type: "string" };
        const isRequired = Array.isArray(bodySchema.required) && bodySchema.required.includes(propertyName);
        parameterMap.push({
          toolParamName: name,
          source: "body",
          originalName: propertyName,
          required: isRequired
        });
        if (endpoint.requestBody.required && isRequired) {
          required.push(name);
        }
      }
    } else {
      const name = ensureUnique("body", usedNames);
      properties[name] = {
        ...bodySchema,
        ...(endpoint.requestBody.description ? { description: endpoint.requestBody.description } : {})
      };
      if (endpoint.requestBody.required) {
        required.push(name);
      }
      parameterMap.push({
        toolParamName: name,
        source: "body",
        originalName: "body",
        required: endpoint.requestBody.required
      });
    }
  }

  return {
    inputSchema: {
      type: "object",
      properties,
      ...(required.length > 0 ? { required } : {})
    },
    parameterMap
  };
}

function buildDescription(endpoint: NormalizedEndpoint): string {
  const parts: string[] = [];
  if (endpoint.summary) {
    parts.push(endpoint.summary);
  } else if (endpoint.description) {
    const firstSentence = endpoint.description.split(/\.\s/)[0] ?? endpoint.description;
    parts.push(firstSentence.length <= 200 ? firstSentence : firstSentence.slice(0, 200));
  }
  parts.push(`[${endpoint.method.toUpperCase()} ${endpoint.path}]`);
  if (endpoint.deprecated) {
    parts.push("(DEPRECATED)");
  }
  return parts.join(" ");
}

function generateToolName(operationId: string, _method: string, _path: string, prefix?: string): string {
  let name = sanitizeOperationId(operationId);
  if (prefix) {
    name = `${sanitize(prefix)}_${name}`;
  }
  return name.slice(0, MAX_TOOL_NAME_LENGTH);
}

function resolveCollisions(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((name) => {
    const count = seen.get(name) ?? 0;
    seen.set(name, count + 1);
    if (count === 0) {
      return name;
    }
    return `${name}_${count + 1}`.slice(0, MAX_TOOL_NAME_LENGTH);
  });
}

function sanitizeOperationId(value: string): string {
  return value
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .toLowerCase();
}

function sanitize(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .toLowerCase();
}

function ensureUnique(name: string, usedNames: Set<string>, prefixOnCollision?: string): string {
  let candidate = name;
  if (usedNames.has(candidate) && prefixOnCollision) {
    candidate = `${prefixOnCollision}_${name}`;
  }

  let suffix = 2;
  const base = candidate;
  while (usedNames.has(candidate)) {
    candidate = `${base}_${suffix}`;
    suffix += 1;
  }
  usedNames.add(candidate);
  return candidate;
}

function matchPattern(value: string, pattern: string): boolean {
  if (pattern.includes("*")) {
    const regex = new RegExp(`^${pattern.replace(/\*/g, ".*").replace(/\//g, "\\/")}$`);
    return regex.test(value);
  }
  return value === pattern;
}

function coerceStringRecord(value: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") {
      out[key] = entry;
    }
  }
  return out;
}

function isSecuritySchemeLocation(value: unknown): value is "header" | "query" | "cookie" {
  return value === "header" || value === "query" || value === "cookie";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
