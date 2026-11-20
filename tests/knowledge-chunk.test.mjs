import assert from "node:assert/strict";
import { test } from "node:test";
import { chunkMarkdown, chunkSegments } from "../src/lib/knowledge/chunk.ts";

test("chunkMarkdown keeps section headings as searchable locators", () => {
  const chunks = chunkMarkdown("# Company Guide\n\n## Hiring\n\nUse the approved hiring workflow.");

  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].content, "Use the approved hiring workflow.");
  assert.equal(chunks[0].locator, "Hiring");
});

test("chunkSegments preserves Hebrew text and page locators", () => {
  const chunks = chunkSegments([
    { text: "הצוות מאשר את ההחלטה בפרויקט אלפא", locator: "עמוד 4" },
    { text: "English summary for the same project", locator: "Page 5" },
  ]);

  assert.deepEqual(
    chunks.map((chunk) => chunk.locator),
    ["עמוד 4", "Page 5"],
  );
  assert.match(chunks[0].content, /ההחלטה/);
  assert.match(chunks[1].content, /same project/);
});

test("long segments produce overlapping chunks without losing the tail", () => {
  const text = `${"alpha ".repeat(500)}tail`;
  const chunks = chunkSegments([{ text, locator: "Sheet1 · rows 1–40" }]);

  assert.ok(chunks.length > 1);
  assert.equal(chunks.at(-1).locator, "Sheet1 · rows 1–40");
  assert.match(chunks.at(-1).content, /tail/);
});
