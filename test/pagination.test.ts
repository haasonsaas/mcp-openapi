import test from "node:test";
import assert from "node:assert/strict";
import { decodeCursor, encodeCursor, paginateWithCursor } from "../src/pagination.js";

test("paginateWithCursor pages correctly", () => {
  const items = ["a", "b", "c", "d", "e"];
  const first = paginateWithCursor(items, undefined, 2);

  assert.deepEqual(first.items, ["a", "b"]);
  assert.ok(first.nextCursor);

  const second = paginateWithCursor(items, first.nextCursor, 2);
  assert.deepEqual(second.items, ["c", "d"]);
  assert.ok(second.nextCursor);

  const third = paginateWithCursor(items, second.nextCursor, 2);
  assert.deepEqual(third.items, ["e"]);
  assert.equal(third.nextCursor, undefined);
});

test("cursor roundtrip", () => {
  const encoded = encodeCursor(42);
  assert.equal(decodeCursor(encoded), 42);
});

test("invalid cursor throws mcp error", () => {
  assert.throws(() => decodeCursor("not-base64"));
});
