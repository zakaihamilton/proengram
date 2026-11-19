import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMarkdown, safeLinkHref } from "../src/lib/markdown.ts";

test("safeLinkHref permits http, https, and mailto and rejects unsafe protocols", () => {
  assert.equal(safeLinkHref("https://example.com/docs"), "https://example.com/docs");
  assert.equal(safeLinkHref("http://example.com/path?a=1"), "http://example.com/path?a=1");
  assert.equal(safeLinkHref("mailto:team@example.com"), "mailto:team@example.com");
  assert.equal(safeLinkHref("javascript:alert(1)"), null);
  assert.equal(safeLinkHref("data:text/html,<script>alert(1)</script>"), null);
  assert.equal(safeLinkHref("vbscript:msgbox(1)"), null);
  assert.equal(safeLinkHref("  "), null);
});

test("parseMarkdown parses headings, paragraphs, code blocks, lists, blockquotes, and tables", () => {
  const input = [
    "# Main Title",
    "",
    "### Subsection",
    "",
    "Paragraph with **bold**, *italic*, ~~old~~, `inline()`, [safe](https://example.com) and [xss](javascript:alert(1)).",
    "",
    "```ts",
    "const x = 1;",
    "```",
    "",
    "> Quoted note",
    "",
    "- First bullet",
    "- Second bullet",
    "",
    "1. Step one",
    "2. Step two",
    "",
    "| Column A | Column B |",
    "| --- | --- |",
    "| Val 1 | Val 2 |",
    "",
    "---",
  ].join("\n");

  const blocks = parseMarkdown(input);
  assert.equal(blocks[0].kind, "heading");
  assert.equal(blocks[0].level, 2);
  assert.equal(blocks[1].kind, "heading");
  assert.equal(blocks[1].level, 3);

  const paragraph = blocks[2];
  assert.equal(paragraph.kind, "paragraph");
  assert.equal(
    paragraph.children.some((token) => token.kind === "strong"),
    true,
  );
  assert.equal(
    paragraph.children.some((token) => token.kind === "em"),
    true,
  );
  assert.equal(
    paragraph.children.some((token) => token.kind === "del"),
    true,
  );
  assert.equal(
    paragraph.children.some((token) => token.kind === "code" && token.value === "inline()"),
    true,
  );
  const links = paragraph.children.filter((token) => token.kind === "link");
  assert.equal(links.length, 1);
  assert.equal(links[0].href, "https://example.com/");
  assert.equal(
    paragraph.children.some((token) => token.kind === "text" && token.value.includes("xss")),
    true,
  );

  assert.equal(blocks[3].kind, "code");
  assert.equal(blocks[3].language, "ts");
  assert.equal(blocks[3].code, "const x = 1;");

  assert.equal(blocks[4].kind, "blockquote");
  assert.equal(blocks[4].blocks[0].kind, "paragraph");

  assert.equal(blocks[5].kind, "list");
  assert.equal(blocks[5].ordered, false);
  assert.equal(blocks[5].items.length, 2);

  assert.equal(blocks[6].kind, "list");
  assert.equal(blocks[6].ordered, true);
  assert.equal(blocks[6].items.length, 2);

  assert.equal(blocks[7].kind, "table");
  assert.equal(blocks[7].headers.length, 2);
  assert.equal(blocks[7].rows.length, 1);

  assert.equal(blocks[8].kind, "hr");
});
