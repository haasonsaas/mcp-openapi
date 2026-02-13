import test from "node:test";
import assert from "node:assert/strict";
import { paginateWithCursor } from "../src/pagination.js";

test("tools/list pagination cursor is stable", () => {
  const items = Array.from({ length: 120 }, (_, i) => ({ name: `tool_${i}` }));

  const page1 = paginateWithCursor(items, undefined, 50);
  assert.equal(page1.items.length, 50);
  assert.ok(page1.nextCursor);

  const page2 = paginateWithCursor(items, page1.nextCursor, 50);
  assert.equal(page2.items.length, 50);
  assert.ok(page2.nextCursor);

  const page3 = paginateWithCursor(items, page2.nextCursor, 50);
  assert.equal(page3.items.length, 20);
  assert.equal(page3.nextCursor, undefined);

  assert.equal(page1.items[0].name, "tool_0");
  assert.equal(page2.items[0].name, "tool_50");
  assert.equal(page3.items[0].name, "tool_100");
});
