import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import yaml from "js-yaml";
import $RefParser from "@apidevtools/json-schema-ref-parser";

export async function loadOpenApiDocument(specPath: string): Promise<Record<string, unknown>> {
  const absPath = resolve(specPath);
  const raw = await readFile(absPath, "utf8");
  const parsed = parseByExtension(absPath, raw);

  if (!isRecord(parsed)) {
    throw new Error(`Spec at ${absPath} is not a JSON object`);
  }

  const sanitized = sanitizeBrokenInternalRefs(parsed, parsed);
  try {
    const dereferenced = await $RefParser.dereference(absPath, sanitized as object);
    validateShape(dereferenced as Record<string, unknown>, absPath);
    return dereferenced as Record<string, unknown>;
  } catch (error) {
    if (!isInternalMissingPointerError(error)) {
      throw error;
    }

    const resolved = resolveInternalRefs(sanitized, sanitized);
    validateShape(resolved, absPath);
    return resolved;
  }
}

function parseByExtension(path: string, raw: string): unknown {
  if (path.endsWith(".yaml") || path.endsWith(".yml")) {
    return yaml.load(raw);
  }

  if (path.endsWith(".json")) {
    return JSON.parse(raw);
  }

  try {
    return JSON.parse(raw);
  } catch {
    return yaml.load(raw);
  }
}

function validateShape(doc: Record<string, unknown>, source: string): void {
  const version = doc.openapi;
  const paths = doc.paths;

  if (typeof version !== "string") {
    throw new Error(`Missing or invalid \"openapi\" field in ${source}`);
  }

  if (!paths || typeof paths !== "object") {
    throw new Error(`Missing or invalid \"paths\" in ${source}`);
  }
}

function sanitizeBrokenInternalRefs<T>(value: T, root: Record<string, unknown>): T {
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeBrokenInternalRefs(entry, root)) as T;
  }

  if (!isRecord(value)) {
    return value;
  }

  const ref = typeof value.$ref === "string" ? value.$ref : undefined;
  if (ref && isBrokenInternalRef(ref, root)) {
    const withoutRef: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (key === "$ref") {
        continue;
      }
      withoutRef[key] = sanitizeBrokenInternalRefs(child, root);
    }
    return withoutRef as T;
  }

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    out[key] = sanitizeBrokenInternalRefs(child, root);
  }
  return out as T;
}

function resolveInternalRefs<T>(value: T, root: Record<string, unknown>, stack: string[] = []): T {
  if (Array.isArray(value)) {
    return value.map((entry) => resolveInternalRefs(entry, root, stack)) as T;
  }

  if (!isRecord(value)) {
    return value;
  }

  const ref = typeof value.$ref === "string" ? value.$ref : undefined;
  if (ref && ref.startsWith("#")) {
    if (stack.includes(ref)) {
      return {} as T;
    }

    const resolved = resolveJsonPointer(root, ref);
    const siblings = { ...value };
    delete siblings.$ref;

    if (resolved === undefined) {
      return resolveInternalRefs(siblings as T, root, stack);
    }

    const resolvedClone = structuredClone(resolved);
    const resolvedValue = resolveInternalRefs(resolvedClone, root, [...stack, ref]);
    if (isRecord(resolvedValue) && Object.keys(siblings).length > 0) {
      return resolveInternalRefs(mergeObjects(resolvedValue, siblings) as T, root, [...stack, ref]);
    }

    return resolvedValue as T;
  }

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    out[key] = resolveInternalRefs(child, root, stack);
  }
  return out as T;
}

function isBrokenInternalRef(ref: string, root: Record<string, unknown>): boolean {
  if (ref === "#") {
    return false;
  }

  if (!ref.startsWith("#/")) {
    return false;
  }

  return resolveJsonPointer(root, ref) === undefined;
}

function resolveJsonPointer(root: unknown, ref: string): unknown {
  if (ref === "#") {
    return root;
  }

  const tokens = ref
    .slice(2)
    .split("/")
    .map((token) => decodePointerToken(token));

  let current: unknown = root;
  for (const token of tokens) {
    if (Array.isArray(current)) {
      const index = Number.parseInt(token, 10);
      if (!Number.isFinite(index)) {
        return undefined;
      }
      current = current[index];
      continue;
    }

    if (!isRecord(current)) {
      return undefined;
    }

    current = current[token];
  }

  return current;
}

function decodePointerToken(token: string): string {
  return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

function mergeObjects(base: Record<string, unknown>, overlay: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    const existing = merged[key];
    if (isRecord(existing) && isRecord(value)) {
      merged[key] = mergeObjects(existing, value);
      continue;
    }
    merged[key] = value;
  }
  return merged;
}

function isInternalMissingPointerError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const candidate = error as { code?: unknown; name?: unknown; targetRef?: unknown };
  const isMissingPointer = candidate.code === "EMISSINGPOINTER" || candidate.name === "MissingPointerError";
  if (!isMissingPointer) {
    return false;
  }

  return typeof candidate.targetRef === "string" && candidate.targetRef.startsWith("#");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
