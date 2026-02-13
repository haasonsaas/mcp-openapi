import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import yaml from "js-yaml";
import $RefParser from "@apidevtools/json-schema-ref-parser";

export async function loadOpenApiDocument(specPath: string): Promise<Record<string, unknown>> {
  const absPath = resolve(specPath);
  const raw = await readFile(absPath, "utf8");
  const parsed = parseByExtension(absPath, raw);

  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Spec at ${absPath} is not a JSON object`);
  }

  const dereferenced = await $RefParser.dereference(absPath, parsed as object);
  validateShape(dereferenced as Record<string, unknown>, absPath);
  return dereferenced as Record<string, unknown>;
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
