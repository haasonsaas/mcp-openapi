import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { compileOperations } from "./compiler.js";
import { loadOpenApiDocument } from "./openapi.js";
import type { CompileOptions, OperationModel } from "./types.js";

const CACHE_FORMAT_VERSION = 2;

interface CacheEntry {
  hash: string;
  operations: OperationModel[];
}

export async function loadFromCompileCache(
  specPath: string,
  serverUrl: string | undefined,
  cachePath: string,
  options: CompileOptions = {}
): Promise<Map<string, OperationModel> | null> {
  try {
    const hash = await computeSpecInputHash(specPath, serverUrl, options);
    const raw = await readFile(resolve(cachePath), "utf8");
    const parsed = JSON.parse(raw) as CacheEntry;
    if (parsed.hash !== hash) {
      return null;
    }

    return new Map(parsed.operations.map((op) => [op.operationId, op]));
  } catch {
    return null;
  }
}

export async function compileWithCache(
  specPath: string,
  serverUrl: string | undefined,
  cachePath: string,
  options: CompileOptions = {}
): Promise<Map<string, OperationModel>> {
  const doc = await loadOpenApiDocument(specPath);
  return compileDocumentWithCache(doc, specPath, serverUrl, cachePath, options);
}

export async function compileDocumentWithCache(
  doc: Record<string, unknown>,
  specPath: string,
  serverUrl: string | undefined,
  cachePath: string,
  options: CompileOptions = {}
): Promise<Map<string, OperationModel>> {
  const hash = await computeSpecInputHash(specPath, serverUrl, options);
  const cached = await readCacheEntry(cachePath, hash);
  if (cached) {
    return cached;
  }

  const operations = compileOperations(doc, serverUrl, options);
  const entry: CacheEntry = {
    hash,
    operations: [...operations.values()]
  };

  const abs = resolve(cachePath);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, JSON.stringify(entry), "utf8");

  return operations;
}

async function readCacheEntry(cachePath: string, hash: string): Promise<Map<string, OperationModel> | null> {
  try {
    const raw = await readFile(resolve(cachePath), "utf8");
    const parsed = JSON.parse(raw) as CacheEntry;
    if (parsed.hash !== hash) {
      return null;
    }

    return new Map(parsed.operations.map((op) => [op.operationId, op]));
  } catch {
    return null;
  }
}

async function computeSpecInputHash(
  specPath: string,
  serverUrl: string | undefined,
  options: CompileOptions
): Promise<string> {
  const rawSpec = await readFile(resolve(specPath), "utf8");
  return computeHash({
    cacheFormatVersion: CACHE_FORMAT_VERSION,
    rawSpec,
    serverUrl,
    options
  });
}

function computeHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
