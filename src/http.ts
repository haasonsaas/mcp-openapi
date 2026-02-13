import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type {
  AuthRequirement,
  ExecutionHooks,
  ExecutionResult,
  InvocationPlan,
  OperationModel,
  ParameterSpec,
  RuntimeOptions
} from "./types.js";

interface AttemptResult {
  response: Response;
  attempt: number;
}

interface PaginationOptions {
  enabled: boolean;
  mode: "autoCursor" | "incrementPage";
  maxPages: number;
  cursorParam: string;
  nextCursorPath: string;
  pageParam: string;
  startPage: number;
}

export async function executeOperation(
  operation: OperationModel,
  input: unknown,
  runtime: RuntimeOptions,
  hooks: ExecutionHooks = {}
): Promise<ExecutionResult> {
  const args = (isObject(input) ? input : {}) as Record<string, unknown>;
  const pagination = parsePagination(args.pagination);

  await emitProgress(hooks, { progress: 0, total: pagination.enabled ? pagination.maxPages : 1, message: "Starting request" });

  if (!pagination.enabled) {
    throwIfAborted(hooks.signal);
    const plan = await buildInvocationPlan(operation, args);
    const result = await fetchWithRetry(plan, runtime, hooks);

    await emitProgress(hooks, { progress: 1, total: 1, message: "Request complete" });

    return {
      status: result.response.status,
      statusText: result.response.statusText,
      headers: simplifyHeaders(result.response.headers),
      body: await parseResponseBody(result.response),
      attempts: result.attempt
    };
  }

  return executePaginated(operation, args, runtime, pagination, hooks);
}

export async function buildInvocationPlan(
  operation: OperationModel,
  input: Record<string, unknown>,
  queryOverride?: Record<string, unknown>
): Promise<InvocationPlan> {
  const pathParams = asRecord(input.path);
  const queryParams = queryOverride ?? asRecord(input.query);
  const headerParams = asRecord(input.header);
  const cookieParams = asRecord(input.cookie);

  const baseUrl = operation.servers[0];
  const url = new URL(buildPath(baseUrl, operation.pathTemplate, operation.parameters, pathParams));

  applyQueryParams(url, operation.parameters.filter((p) => p.in === "query"), queryParams);

  const headers: Record<string, string> = {};
  applyHeaderParams(headers, operation.parameters.filter((p) => p.in === "header"), headerParams);
  applyCookieParams(headers, operation.parameters.filter((p) => p.in === "cookie"), cookieParams);
  applyAuth(headers, url, cookieParams, operation.authOptions);

  const body = await encodeBody(input.body, operation.requestBodyContentType);

  if (body !== undefined && operation.requestBodyContentType && !(body instanceof FormData)) {
    headers["content-type"] = operation.requestBodyContentType;
  }

  return {
    url: url.toString(),
    method: operation.method,
    headers,
    body
  };
}

async function executePaginated(
  operation: OperationModel,
  input: Record<string, unknown>,
  runtime: RuntimeOptions,
  pagination: PaginationOptions,
  hooks: ExecutionHooks
): Promise<ExecutionResult> {
  const baseQuery = asRecord(input.query);
  const pageBodies: unknown[] = [];
  let totalAttempts = 0;
  let currentPage = pagination.startPage;
  let cursor: unknown;
  let pagesFetched = 0;
  let finalStatus = 200;
  let finalStatusText = "OK";
  let finalHeaders: Record<string, string> = {};
  let stoppedReason: "completed" | "maxPages" | "error" | "noNextCursor" | "emptyPage" = "completed";

  for (let i = 0; i < pagination.maxPages; i += 1) {
    throwIfAborted(hooks.signal);

    const query = { ...baseQuery };

    if (pagination.mode === "autoCursor") {
      if (i > 0 && cursor === undefined) {
        stoppedReason = "noNextCursor";
        break;
      }
      if (cursor !== undefined) {
        query[pagination.cursorParam] = cursor;
      }
    } else {
      query[pagination.pageParam] = currentPage;
      currentPage += 1;
    }

    const plan = await buildInvocationPlan(operation, input, query);
    const result = await fetchWithRetry(plan, runtime, hooks);
    const body = await parseResponseBody(result.response);
    totalAttempts += result.attempt;
    pagesFetched += 1;

    finalStatus = result.response.status;
    finalStatusText = result.response.statusText;
    finalHeaders = simplifyHeaders(result.response.headers);

    pageBodies.push(body);

    await emitProgress(hooks, {
      progress: pagesFetched,
      total: pagination.maxPages,
      message: `Fetched page ${pagesFetched}`
    });

    if (result.response.status >= 400) {
      stoppedReason = "error";
      return {
        status: finalStatus,
        statusText: finalStatusText,
        headers: finalHeaders,
        body,
        attempts: totalAttempts,
        pageBodies,
        pagination: {
          enabled: true,
          mode: pagination.mode,
          pagesFetched,
          maxPages: pagination.maxPages,
          stoppedReason
        }
      };
    }

    if (pagination.mode === "autoCursor") {
      cursor = readPath(body, pagination.nextCursorPath);
      if (cursor === undefined || cursor === null || cursor === "") {
        stoppedReason = "completed";
        break;
      }
    } else if (isEmptyPage(body)) {
      stoppedReason = "emptyPage";
      break;
    }
  }

  if (pagesFetched === pagination.maxPages) {
    stoppedReason = "maxPages";
  }

  return {
    status: finalStatus,
    statusText: finalStatusText,
    headers: finalHeaders,
    body: aggregatePageBodies(pageBodies),
    attempts: totalAttempts,
    pageBodies,
    pagination: {
      enabled: true,
      mode: pagination.mode,
      pagesFetched,
      maxPages: pagination.maxPages,
      stoppedReason
    }
  };
}

function aggregatePageBodies(pageBodies: unknown[]): unknown {
  if (pageBodies.length === 0) {
    return [];
  }

  if (pageBodies.every((page) => Array.isArray(page))) {
    return pageBodies.flatMap((page) => page as unknown[]);
  }

  if (pageBodies.every((page) => isObject(page) && Array.isArray((page as Record<string, unknown>).items))) {
    const first = { ...(pageBodies[0] as Record<string, unknown>) };
    first.items = pageBodies.flatMap((page) => ((page as Record<string, unknown>).items as unknown[]) ?? []);
    first._pages = pageBodies.length;
    return first;
  }

  return pageBodies;
}

function isEmptyPage(body: unknown): boolean {
  if (Array.isArray(body)) {
    return body.length === 0;
  }

  if (isObject(body) && Array.isArray((body as Record<string, unknown>).items)) {
    return ((body as Record<string, unknown>).items as unknown[]).length === 0;
  }

  return false;
}

function parsePagination(value: unknown): PaginationOptions {
  const input = asRecord(value);
  return {
    enabled: Boolean(input.enabled),
    mode: input.mode === "incrementPage" ? "incrementPage" : "autoCursor",
    maxPages: toPositiveInt(input.maxPages, 5),
    cursorParam: typeof input.cursorParam === "string" && input.cursorParam.trim() ? input.cursorParam : "cursor",
    nextCursorPath:
      typeof input.nextCursorPath === "string" && input.nextCursorPath.trim() ? input.nextCursorPath : "next_cursor",
    pageParam: typeof input.pageParam === "string" && input.pageParam.trim() ? input.pageParam : "page",
    startPage: toPositiveInt(input.startPage, 1)
  };
}

function toPositiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function buildPath(
  baseUrl: string,
  pathTemplate: string,
  pathSpecs: ParameterSpec[],
  pathParams: Record<string, unknown>
): string {
  const map = new Map(pathSpecs.filter((p) => p.in === "path").map((p) => [p.name, p]));

  const renderedPath = pathTemplate.replaceAll(/\{([^}]+)\}/g, (_full, name: string) => {
    const spec = map.get(name);
    const value = pathParams[name];
    if (value === undefined) {
      throw new Error(`Missing required path parameter: ${name}`);
    }

    const serialized = serializePrimitiveByStyle(value, spec?.style ?? "simple", false);
    return encodePathSegment(serialized);
  });

  return baseUrl.endsWith("/") ? `${baseUrl.slice(0, -1)}${renderedPath}` : `${baseUrl}${renderedPath}`;
}

function encodePathSegment(serialized: string): string {
  return encodeURIComponent(serialized)
    .replaceAll("%2F", "/")
    .replaceAll("%3B", ";")
    .replaceAll("%2C", ",")
    .replaceAll("%3D", "=")
    .replaceAll("%2E", ".");
}

function applyQueryParams(url: URL, specs: ParameterSpec[], queryParams: Record<string, unknown>): void {
  const byName = new Map(specs.map((spec) => [spec.name, spec]));

  for (const [name, value] of Object.entries(queryParams)) {
    if (value === undefined || value === null) {
      continue;
    }

    const spec = byName.get(name);
    const style = spec?.style ?? "form";
    const explode = spec?.explode ?? true;

    serializeQueryParam(url.searchParams, name, value, style, explode, Boolean(spec?.allowReserved));
  }
}

function serializeQueryParam(
  searchParams: URLSearchParams,
  name: string,
  value: unknown,
  style: string,
  explode: boolean,
  allowReserved: boolean
): void {
  const encode = (v: string) => (allowReserved ? v : encodeURIComponent(v));

  if (style === "deepObject" && isObject(value)) {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      searchParams.append(`${name}[${k}]`, String(v));
    }
    return;
  }

  if (Array.isArray(value)) {
    if (style === "spaceDelimited") {
      searchParams.append(name, value.map((v) => encode(String(v))).join(" "));
      return;
    }

    if (style === "pipeDelimited") {
      searchParams.append(name, value.map((v) => encode(String(v))).join("|"));
      return;
    }

    if (explode) {
      for (const item of value) {
        searchParams.append(name, encode(String(item)));
      }
      return;
    }

    searchParams.append(name, value.map((v) => encode(String(v))).join(","));
    return;
  }

  if (isObject(value)) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (explode) {
      for (const [k, v] of entries) {
        searchParams.append(k, encode(String(v)));
      }
      return;
    }

    const flattened = entries.flatMap(([k, v]) => [k, String(v)]);
    searchParams.append(name, flattened.map((x) => encode(x)).join(","));
    return;
  }

  searchParams.append(name, encode(String(value)));
}

function applyHeaderParams(headers: Record<string, string>, specs: ParameterSpec[], headerParams: Record<string, unknown>): void {
  const byName = new Map(specs.map((spec) => [spec.name.toLowerCase(), spec]));
  for (const [name, value] of Object.entries(headerParams)) {
    if (value === undefined || value === null) {
      continue;
    }

    const key = name.toLowerCase();
    const spec = byName.get(key);
    const style = spec?.style ?? "simple";
    const explode = spec?.explode ?? false;

    headers[key] = serializePrimitiveByStyle(value, style, explode);
  }
}

function applyCookieParams(headers: Record<string, string>, specs: ParameterSpec[], cookieParams: Record<string, unknown>): void {
  const byName = new Map(specs.map((spec) => [spec.name, spec]));
  const cookies: string[] = [];

  for (const [name, value] of Object.entries(cookieParams)) {
    if (value === undefined || value === null) {
      continue;
    }

    const spec = byName.get(name);
    const style = spec?.style ?? "form";
    const explode = spec?.explode ?? true;
    const serialized = serializePrimitiveByStyle(value, style, explode);
    cookies.push(`${name}=${serialized}`);
  }

  if (cookies.length > 0) {
    const existing = headers.cookie ? `${headers.cookie}; ` : "";
    headers.cookie = `${existing}${cookies.join("; ")}`;
  }
}

function serializePrimitiveByStyle(value: unknown, style: string, explode: boolean): string {
  if (Array.isArray(value)) {
    if (style === "label") {
      return `.${value.join(".")}`;
    }
    if (style === "matrix") {
      return explode ? value.map((v) => `;${String(v)}`).join("") : `;${value.join(",")}`;
    }
    return value.join(explode ? "," : ",");
  }

  if (isObject(value)) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (style === "label") {
      return explode
        ? `.${entries.map(([k, v]) => `${k}=${String(v)}`).join(".")}`
        : `.${entries.flatMap(([k, v]) => [k, String(v)]).join(",")}`;
    }

    if (style === "matrix") {
      if (explode) {
        return entries.map(([k, v]) => `;${k}=${String(v)}`).join("");
      }
      return `;${entries.flatMap(([k, v]) => [k, String(v)]).join(",")}`;
    }

    return explode ? entries.map(([k, v]) => `${k}=${String(v)}`).join(",") : entries.flatMap(([k, v]) => [k, String(v)]).join(",");
  }

  if (style === "label") {
    return `.${String(value)}`;
  }

  if (style === "matrix") {
    return `;${String(value)}`;
  }

  return String(value);
}

async function encodeBody(bodyValue: unknown, contentType?: string): Promise<BodyInit | undefined> {
  if (bodyValue === undefined) {
    return undefined;
  }

  const lower = (contentType ?? "application/json").toLowerCase();

  if (lower.includes("multipart/form-data")) {
    return buildFormData(bodyValue);
  }

  if (lower.includes("application/x-www-form-urlencoded")) {
    return buildUrlEncoded(bodyValue);
  }

  if (lower.includes("application/octet-stream")) {
    return buildBinary(bodyValue);
  }

  if (lower.includes("json") || typeof bodyValue === "object") {
    return JSON.stringify(bodyValue);
  }

  return String(bodyValue);
}

async function buildFormData(value: unknown): Promise<FormData> {
  if (!isObject(value)) {
    throw new Error("multipart/form-data body must be an object");
  }

  const form = new FormData();
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (raw === undefined || raw === null) {
      continue;
    }

    if (Array.isArray(raw)) {
      for (const item of raw) {
        await appendFormValue(form, key, item);
      }
      continue;
    }

    await appendFormValue(form, key, raw);
  }

  return form;
}

async function appendFormValue(form: FormData, key: string, value: unknown): Promise<void> {
  if (typeof value === "string" && value.startsWith("@file:")) {
    const path = value.slice("@file:".length);
    const content = await readFile(path);
    form.append(key, new Blob([content]), basename(path));
    return;
  }

  if (value instanceof Blob) {
    form.append(key, value);
    return;
  }

  form.append(key, typeof value === "string" ? value : JSON.stringify(value));
}

function buildUrlEncoded(value: unknown): URLSearchParams {
  const params = new URLSearchParams();
  if (!isObject(value)) {
    return params;
  }

  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (raw === undefined || raw === null) {
      continue;
    }

    if (Array.isArray(raw)) {
      for (const item of raw) {
        params.append(key, String(item));
      }
      continue;
    }

    params.append(key, String(raw));
  }

  return params;
}

function buildBinary(value: unknown): BodyInit {
  if (value instanceof Blob) {
    return value;
  }

  if (value instanceof Uint8Array) {
    return Buffer.from(value);
  }

  if (value instanceof ArrayBuffer) {
    return Buffer.from(value);
  }

  if (typeof value === "string") {
    if (value.startsWith("base64:")) {
      return Buffer.from(value.slice("base64:".length), "base64");
    }
    return Buffer.from(value);
  }

  throw new Error("application/octet-stream body must be string, base64:string, Blob, ArrayBuffer, or Uint8Array");
}

function applyAuth(
  headers: Record<string, string>,
  url: URL,
  cookieParams: Record<string, unknown>,
  authOptions: AuthRequirement[]
): void {
  if (authOptions.length === 0) {
    return;
  }

  const selected = authOptions[0];
  for (const scheme of selected.schemes) {
    const keyByName = process.env[`MCP_OPENAPI_${scheme.name.toUpperCase()}_TOKEN`];

    if (scheme.type === "apiKey") {
      const token = keyByName ?? process.env.MCP_OPENAPI_API_KEY;
      if (!token) {
        continue;
      }

      if (scheme.in === "query") {
        url.searchParams.set(scheme.name, token);
      } else if (scheme.in === "cookie") {
        const existing = headers.cookie ? `${headers.cookie}; ` : "";
        headers.cookie = `${existing}${scheme.name}=${token}`;
      } else {
        headers[(scheme.name || "x-api-key").toLowerCase()] = token;
      }
      continue;
    }

    if (scheme.type === "http" && scheme.scheme?.toLowerCase() === "bearer") {
      const token = keyByName ?? process.env.MCP_OPENAPI_BEARER_TOKEN;
      if (token) {
        headers.authorization = `Bearer ${token}`;
      }
      continue;
    }

    if (scheme.type === "oauth2" || scheme.type === "openIdConnect") {
      const token = keyByName ?? process.env.MCP_OPENAPI_OAUTH2_ACCESS_TOKEN ?? process.env.MCP_OPENAPI_BEARER_TOKEN;
      if (token) {
        headers.authorization = `Bearer ${token}`;
      }
      continue;
    }

    if (scheme.type === "http" && scheme.scheme?.toLowerCase() === "basic") {
      const username = process.env.MCP_OPENAPI_BASIC_USERNAME;
      const password = process.env.MCP_OPENAPI_BASIC_PASSWORD;
      if (username && password) {
        const encoded = Buffer.from(`${username}:${password}`).toString("base64");
        headers.authorization = `Basic ${encoded}`;
      }
      continue;
    }
  }

  for (const [key, value] of Object.entries(cookieParams)) {
    if (value === undefined || value === null) {
      continue;
    }

    const existing = headers.cookie ? `${headers.cookie}; ` : "";
    headers.cookie = `${existing}${key}=${String(value)}`;
  }
}

function readPath(value: unknown, path: string): unknown {
  if (!path) {
    return undefined;
  }

  const parts = path.split(".").filter(Boolean);
  let current: unknown = value;
  for (const part of parts) {
    if (!isObject(current) && !Array.isArray(current)) {
      return undefined;
    }

    if (Array.isArray(current)) {
      const index = Number(part);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        return undefined;
      }
      current = current[index];
      continue;
    }

    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

async function fetchWithRetry(plan: InvocationPlan, runtime: RuntimeOptions, hooks: ExecutionHooks): Promise<AttemptResult> {
  let attempt = 1;
  let lastError: unknown;

  while (attempt <= runtime.retries + 1) {
    throwIfAborted(hooks.signal);

    const timeoutController = new AbortController();
    const mergedSignal = mergeAbortSignals(hooks.signal, timeoutController.signal);
    const timer = setTimeout(() => timeoutController.abort(), runtime.timeoutMs);

    try {
      await emitLog(hooks, { level: "debug", data: { event: "request_attempt", attempt, url: plan.url, method: plan.method } });
      const response = await fetch(plan.url, {
        method: plan.method,
        headers: plan.headers,
        body: plan.body,
        signal: mergedSignal
      });

      clearTimeout(timer);

      if (shouldRetryStatus(response.status) && attempt <= runtime.retries) {
        const waitMs = retryDelayFor(response, runtime.retryDelayMs, attempt);
        await emitLog(hooks, {
          level: "warning",
          data: { event: "retrying_status", status: response.status, attempt, waitMs }
        });
        await sleep(waitMs, hooks.signal);
        attempt += 1;
        continue;
      }

      return { response, attempt };
    } catch (error) {
      clearTimeout(timer);
      lastError = error;

      if (isAbortError(error) && hooks.signal?.aborted) {
        throw new Error("Request cancelled by client");
      }

      if (attempt > runtime.retries || !isRetriableError(error)) {
        throw decorateNetworkError(error, attempt);
      }

      await emitLog(hooks, {
        level: "warning",
        data: { event: "retrying_error", attempt, detail: error instanceof Error ? error.message : String(error) }
      });
      await sleep(runtime.retryDelayMs * attempt, hooks.signal);
      attempt += 1;
    }
  }

  throw decorateNetworkError(lastError, attempt);
}

function mergeAbortSignals(a?: AbortSignal, b?: AbortSignal): AbortSignal | undefined {
  if (!a && !b) {
    return undefined;
  }

  if (a && !b) {
    return a;
  }

  if (!a && b) {
    return b;
  }

  const controller = new AbortController();
  const onAbort = () => controller.abort();

  a?.addEventListener("abort", onAbort, { once: true });
  b?.addEventListener("abort", onAbort, { once: true });

  if (a?.aborted || b?.aborted) {
    controller.abort();
  }

  return controller.signal;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error("Request cancelled by client");
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function decorateNetworkError(error: unknown, attempt: number): Error {
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(`Network request failed after ${attempt} attempt(s): ${detail}`);
}

function shouldRetryStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function isRetriableError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    error.name === "AbortError" ||
    error.name === "TypeError" ||
    error.message.toLowerCase().includes("network") ||
    error.message.toLowerCase().includes("timeout")
  );
}

function retryDelayFor(response: Response, baseDelayMs: number, attempt: number): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.max(baseDelayMs, seconds * 1000);
    }

    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) {
      const delta = date - Date.now();
      if (delta > 0) {
        return Math.max(baseDelayMs, delta);
      }
    }
  }

  return baseDelayMs * attempt;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const onAbort = () => {
      cleanup();
      reject(new Error("Request cancelled by client"));
    };

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";

  if (contentType.includes("application/json") || contentType.includes("+json")) {
    return response.json();
  }

  if (contentType.includes("application/octet-stream")) {
    const buffer = Buffer.from(await response.arrayBuffer());
    return { base64: buffer.toString("base64") };
  }

  return response.text();
}

function simplifyHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  const allowed = new Set([
    "content-type",
    "content-length",
    "retry-after",
    "x-ratelimit-remaining",
    "x-ratelimit-limit",
    "x-ratelimit-reset"
  ]);

  for (const [key, value] of headers.entries()) {
    if (allowed.has(key.toLowerCase())) {
      out[key.toLowerCase()] = value;
    }
  }

  return out;
}

async function emitProgress(
  hooks: ExecutionHooks,
  progress: { progress: number; total?: number; message?: string }
): Promise<void> {
  if (hooks.onProgress) {
    await hooks.onProgress(progress);
  }
}

async function emitLog(
  hooks: ExecutionHooks,
  entry: { level: "debug" | "info" | "notice" | "warning" | "error"; data: unknown }
): Promise<void> {
  if (hooks.onLog) {
    await hooks.onLog(entry);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return isObject(value) ? (value as Record<string, unknown>) : {};
}

function isObject(value: unknown): value is object {
  return value !== null && typeof value === "object";
}
