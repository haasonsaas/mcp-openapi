export type JsonSchema = Record<string, unknown>;

export interface LintDiagnostic {
  level: "error" | "warning";
  code: string;
  message: string;
  location?: string;
}

export interface CompileOptions {
  strict?: boolean;
  toolNameTemplate?: string;
}

export interface SecurityScheme {
  name: string;
  type: string;
  in?: "query" | "header" | "cookie";
  scheme?: string;
  tokenUrl?: string;
  scopes?: Record<string, string>;
}

export interface AuthRequirement {
  schemes: SecurityScheme[];
}

export interface ParameterSpec {
  name: string;
  in: "query" | "header" | "path" | "cookie";
  required: boolean;
  schema?: JsonSchema;
  style?: string;
  explode?: boolean;
  allowReserved?: boolean;
}

export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface OperationModel {
  operationId: string;
  title?: string;
  tags?: string[];
  method: string;
  pathTemplate: string;
  description: string;
  toolDescription: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  outputWrapKey?: string;
  parameters: ParameterSpec[];
  requestBodyContentType?: string;
  responseContentType?: string;
  successResponseSchema?: JsonSchema;
  responseSchemasByStatus?: Record<string, JsonSchema>;
  servers: string[];
  authOptions: AuthRequirement[];
  annotations?: ToolAnnotations;
}

export interface InvocationPlan {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: BodyInit;
}

export interface RuntimeOptions {
  timeoutMs: number;
  retries: number;
  retryDelayMs: number;
  maxResponseBytes: number;
  allowedHosts: string[];
  maxConcurrency: number;
  allowToolPatterns: string[];
  denyToolPatterns: string[];
  allowedMethods: string[];
  allowedPathPrefixes: string[];
  responseTransformModule?: string;
  sseMaxSessions: number;
  sseSessionTtlMs: number;
}

export interface PaginationSummary {
  enabled: boolean;
  mode: "autoCursor" | "incrementPage";
  pagesFetched: number;
  maxPages: number;
  stoppedReason: "completed" | "maxPages" | "error" | "noNextCursor" | "emptyPage";
}

export interface ExecutionResult {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: unknown;
  attempts: number;
  pagination?: PaginationSummary;
  pageBodies?: unknown[];
}

export interface ExecutionHooks {
  signal?: AbortSignal;
  onProgress?: (progress: { progress: number; total?: number; message?: string }) => Promise<void> | void;
  onLog?: (entry: { level: "debug" | "info" | "notice" | "warning" | "error"; data: unknown }) => Promise<void> | void;
}
