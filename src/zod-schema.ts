import { z, type ZodTypeAny } from "zod";
import type { JsonSchema } from "./types.js";

export function zodFromJsonSchema(schema: JsonSchema): ZodTypeAny {
  return convertSchema(schema, new WeakMap<object, ZodTypeAny>());
}

function convertSchema(schema: unknown, seen: WeakMap<object, ZodTypeAny>): ZodTypeAny {
  if (!isObject(schema)) {
    return z.any();
  }

  if (seen.has(schema)) {
    return seen.get(schema)!;
  }

  const s = schema as Record<string, unknown>;

  if (Array.isArray(s.enum)) {
    return unionOrSingle((s.enum as unknown[]).map((v) => z.literal(v as string | number | boolean | null)));
  }

  if (Array.isArray(s.oneOf) && s.oneOf.length > 0) {
    return unionOrSingle((s.oneOf as unknown[]).map((x) => convertSchema(x, seen)));
  }

  if (Array.isArray(s.anyOf) && s.anyOf.length > 0) {
    return unionOrSingle((s.anyOf as unknown[]).map((x) => convertSchema(x, seen)));
  }

  if (Array.isArray(s.allOf) && s.allOf.length > 0) {
    const all = (s.allOf as unknown[]).map((x) => convertSchema(x, seen));
    const [first, ...rest] = all;
    if (!first) {
      return z.any();
    }

    return rest.reduce((acc, cur) => z.intersection(acc, cur), first);
  }

  const type = s.type;
  if (Array.isArray(type)) {
    const entries = type.map((t) => convertSchema({ ...s, type: t }, seen));
    if (entries.length === 1) {
      return entries[0];
    }
    if (entries.length > 1) {
      return unionOrSingle(entries);
    }
  }

  switch (type) {
    case "string": {
      let out = z.string();
      if (typeof s.minLength === "number") {
        out = out.min(s.minLength);
      }
      if (typeof s.maxLength === "number") {
        out = out.max(s.maxLength);
      }
      if (typeof s.pattern === "string") {
        out = out.regex(new RegExp(s.pattern));
      }
      return out;
    }
    case "integer": {
      let out = z.number().int();
      if (typeof s.minimum === "number") {
        out = out.gte(s.minimum);
      }
      if (typeof s.maximum === "number") {
        out = out.lte(s.maximum);
      }
      return out;
    }
    case "number": {
      let out = z.number();
      if (typeof s.minimum === "number") {
        out = out.gte(s.minimum);
      }
      if (typeof s.maximum === "number") {
        out = out.lte(s.maximum);
      }
      return out;
    }
    case "boolean":
      return z.boolean();
    case "null":
      return z.null();
    case "array": {
      const itemSchema = isObject(s.items) ? convertSchema(s.items, seen) : z.any();
      let out = z.array(itemSchema);
      if (typeof s.minItems === "number") {
        out = out.min(s.minItems);
      }
      if (typeof s.maxItems === "number") {
        out = out.max(s.maxItems);
      }
      return out;
    }
    case "object": {
      const props = isObject(s.properties) ? (s.properties as Record<string, unknown>) : {};
      const required = Array.isArray(s.required) ? new Set(s.required.filter((x): x is string => typeof x === "string")) : new Set<string>();

      const shape: Record<string, ZodTypeAny> = {};
      for (const [key, value] of Object.entries(props)) {
        const inner = convertSchema(value, seen);
        shape[key] = required.has(key) ? inner : inner.optional();
      }

      const objectSchema = z.object(shape);
      seen.set(schema, objectSchema);

      if (s.additionalProperties === false) {
        return objectSchema.strict();
      }

      if (isObject(s.additionalProperties)) {
        return objectSchema.catchall(convertSchema(s.additionalProperties, seen));
      }

      return objectSchema.passthrough();
    }
    default:
      if (isObject(s.properties)) {
        return convertSchema({ ...s, type: "object" }, seen);
      }
      return z.any();
  }
}

function isObject(value: unknown): value is object {
  return value !== null && typeof value === "object";
}

function unionOrSingle(items: ZodTypeAny[]): ZodTypeAny {
  if (items.length === 0) {
    return z.any();
  }
  if (items.length === 1) {
    return items[0];
  }
  return z.union(items as [ZodTypeAny, ZodTypeAny, ...ZodTypeAny[]]);
}
