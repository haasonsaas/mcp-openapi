import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

export function paginateWithCursor<T>(items: T[], cursor: string | undefined, pageSize: number): { items: T[]; nextCursor?: string } {
  const offset = decodeCursor(cursor);
  const sliced = items.slice(offset, offset + pageSize);
  const nextOffset = offset + sliced.length;

  return {
    items: sliced,
    ...(nextOffset < items.length ? { nextCursor: encodeCursor(nextOffset) } : {})
  };
}

export function decodeCursor(cursor: string | undefined): number {
  if (!cursor) {
    return 0;
  }

  try {
    const parsed = Number(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new Error("Invalid cursor");
    }
    return parsed;
  } catch {
    throw new McpError(ErrorCode.InvalidParams, "Invalid tools/list cursor");
  }
}

export function encodeCursor(offset: number): string {
  return Buffer.from(String(offset), "utf8").toString("base64url");
}
