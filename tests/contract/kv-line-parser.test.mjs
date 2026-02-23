import test from "node:test";
import assert from "node:assert/strict";
import { parseKeyValueLine } from "../../scripts/lib/kv-line-parser.mjs";

test("parses key=value line with coercion", () => {
  const row = parseKeyValueLine("event=COUNT_BATCH_RUNNER round=1771 progress=12 finalized=false");
  assert.equal(row.event, "COUNT_BATCH_RUNNER");
  assert.equal(row.round, 1771);
  assert.equal(row.progress, 12);
  assert.equal(row.finalized, false);
});

test("returns null for empty or non-kv lines", () => {
  assert.equal(parseKeyValueLine(""), null);
  assert.equal(parseKeyValueLine("hello world"), null);
});
