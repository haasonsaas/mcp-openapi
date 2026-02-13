import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { compileOperations } from "./compiler.js";
import { loadOpenApiDocument } from "./openapi.js";
import type { CompileOptions, OperationModel } from "./types.js";

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
    const doc = await loadOpenApiDocument(specPath);
    const hash = computeHash({ doc, serverUrl, options });
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
  const cached = await loadFromCompileCache(specPath, serverUrl, cachePath, options);
  if (cached) {
    return cached;
  }

  const doc = await loadOpenApiDocument(specPath);
  const operations = compileOperations(doc, serverUrl, options);
  const entry: CacheEntry = {
    hash: computeHash({ doc, serverUrl, options }),
    operations: [...operations.values()]
  };

  const abs = resolve(cachePath);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, JSON.stringify(entry), "utf8");

  return operations;
}

function computeHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
