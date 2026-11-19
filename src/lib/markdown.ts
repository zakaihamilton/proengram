export type InlineToken =
  | { kind: "text"; key: string; value: string }
  | { kind: "code"; key: string; value: string }
  | { kind: "strong"; key: string; children: InlineToken[] }
  | { kind: "em"; key: string; children: InlineToken[] }
  | { kind: "del"; key: string; children: InlineToken[] }
  | { kind: "link"; key: string; href: string; children: InlineToken[] };

type MarkdownCell = {
  key: string;
  children: InlineToken[];
};

type MarkdownRow = {
  key: string;
  cells: MarkdownCell[];
};

export type MarkdownBlock =
  | { kind: "heading"; key: string; level: 2 | 3 | 4; children: InlineToken[] }
  | { kind: "paragraph"; key: string; children: InlineToken[] }
  | { kind: "code"; key: string; language: string | null; code: string }
  | { kind: "blockquote"; key: string; blocks: MarkdownBlock[] }
  | { kind: "list"; key: string; ordered: boolean; items: MarkdownCell[] }
  | { kind: "hr"; key: string }
  | { kind: "table"; key: string; headers: MarkdownCell[]; rows: MarkdownRow[] };

export function safeLinkHref(href: string): string | null {
  const trimmed = href.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol === "https:" || url.protocol === "http:" || url.protocol === "mailto:") {
      return url.toString();
    }
    return null;
  } catch {
    return null;
  }
}

function findClosingBackticks(text: string, from: number, tickCount: number): number {
  let index = from;
  while (index < text.length) {
    if (text[index] === "`") {
      let count = 0;
      while (index + count < text.length && text[index + count] === "`") {
        count += 1;
      }
      if (count === tickCount) return index;
      index += count;
    } else {
      index += 1;
    }
  }
  return -1;
}

function findMatchingDelimiter(text: string, from: number, delimiter: string): number {
  let index = from;
  while (index < text.length) {
    if (text[index] === "\\") {
      index += 2;
      continue;
    }
    if (text[index] === "`") {
      let tickCount = 0;
      while (index + tickCount < text.length && text[index + tickCount] === "`") {
        tickCount += 1;
      }
      const closeTicks = findClosingBackticks(text, index + tickCount, tickCount);
      if (closeTicks !== -1) {
        index = closeTicks + tickCount;
        continue;
      }
    }
    if (text.startsWith(delimiter, index)) {
      if (delimiter.length === 1 && text.startsWith(delimiter + delimiter, index)) {
        index += 2;
        continue;
      }
      return index;
    }
    index += 1;
  }
  return -1;
}

function parseLinkEnd(
  text: string,
  startAfterBracket: number,
): { labelEnd: number; href: string; end: number } | null {
  let index = startAfterBracket;
  let depth = 1;
  while (index < text.length && depth > 0) {
    if (text[index] === "\\") {
      index += 2;
      continue;
    }
    if (text[index] === "[") depth += 1;
    else if (text[index] === "]") depth -= 1;
    index += 1;
  }
  if (depth !== 0 || text[index] !== "(") return null;
  const labelEnd = index - 1;
  let hrefIndex = index + 1;
  let parenDepth = 1;
  while (hrefIndex < text.length && parenDepth > 0) {
    if (text[hrefIndex] === "\\") {
      hrefIndex += 2;
      continue;
    }
    if (text[hrefIndex] === "(") parenDepth += 1;
    else if (text[hrefIndex] === ")") parenDepth -= 1;
    hrefIndex += 1;
  }
  if (parenDepth !== 0) return null;
  const rawTarget = text.slice(index + 1, hrefIndex - 1).trim();
  const spaceIndex = rawTarget.search(/\s/);
  const rawHref = spaceIndex === -1 ? rawTarget : rawTarget.slice(0, spaceIndex);
  const href = rawHref.startsWith("<") && rawHref.endsWith(">") ? rawHref.slice(1, -1) : rawHref;
  return { labelEnd, href, end: hrefIndex };
}

function parseInlineMarkdown(text: string, keyPrefix = "inline"): InlineToken[] {
  const tokens: InlineToken[] = [];
  let tokenCounter = 0;
  let plain = "";
  let index = 0;

  const nextKey = (kind: string) => `${keyPrefix}-${kind}-${tokenCounter++}`;
  const flushPlain = () => {
    if (!plain) return;
    tokens.push({ kind: "text", key: nextKey("t"), value: plain });
    plain = "";
  };

  while (index < text.length) {
    const ch = text[index];
    if (ch === "\\" && index + 1 < text.length && /[\\`*_{}[\]()#+\-.!~|>]/.test(text[index + 1])) {
      plain += text[index + 1];
      index += 2;
      continue;
    }

    if (ch === "`") {
      let tickCount = 0;
      while (index + tickCount < text.length && text[index + tickCount] === "`") {
        tickCount += 1;
      }
      const closeIndex = findClosingBackticks(text, index + tickCount, tickCount);
      if (closeIndex !== -1) {
        flushPlain();
        const rawCode = text.slice(index + tickCount, closeIndex);
        const codeValue =
          rawCode.length >= 2 && rawCode.startsWith(" ") && rawCode.endsWith(" ")
            ? rawCode.slice(1, -1)
            : rawCode;
        tokens.push({ kind: "code", key: nextKey("c"), value: codeValue });
        index = closeIndex + tickCount;
        continue;
      }
    }

    if (ch === "!" && text[index + 1] === "[") {
      const parsed = parseLinkEnd(text, index + 2);
      if (parsed) {
        plain += text.slice(index + 2, parsed.labelEnd);
        index = parsed.end;
        continue;
      }
    }

    if (ch === "[") {
      const parsed = parseLinkEnd(text, index + 1);
      if (parsed) {
        const label = text.slice(index + 1, parsed.labelEnd);
        const safeHref = safeLinkHref(parsed.href);
        if (safeHref) {
          flushPlain();
          const key = nextKey("a");
          tokens.push({
            kind: "link",
            key,
            href: safeHref,
            children: parseInlineMarkdown(label, key),
          });
        } else {
          plain += label;
        }
        index = parsed.end;
        continue;
      }
    }

    if (text.startsWith("**", index) || text.startsWith("__", index)) {
      const delimiter = text.slice(index, index + 2);
      const closeIndex = findMatchingDelimiter(text, index + 2, delimiter);
      if (closeIndex > index + 2) {
        flushPlain();
        const key = nextKey("b");
        tokens.push({
          kind: "strong",
          key,
          children: parseInlineMarkdown(text.slice(index + 2, closeIndex), key),
        });
        index = closeIndex + 2;
        continue;
      }
    }

    if (text.startsWith("~~", index)) {
      const closeIndex = findMatchingDelimiter(text, index + 2, "~~");
      if (closeIndex > index + 2) {
        flushPlain();
        const key = nextKey("s");
        tokens.push({
          kind: "del",
          key,
          children: parseInlineMarkdown(text.slice(index + 2, closeIndex), key),
        });
        index = closeIndex + 2;
        continue;
      }
    }

    if ((ch === "*" || ch === "_") && !text.startsWith(ch + ch, index)) {
      const closeIndex = findMatchingDelimiter(text, index + 1, ch);
      if (closeIndex > index + 1) {
        flushPlain();
        const key = nextKey("i");
        tokens.push({
          kind: "em",
          key,
          children: parseInlineMarkdown(text.slice(index + 1, closeIndex), key),
        });
        index = closeIndex + 1;
        continue;
      }
    }

    plain += ch;
    index += 1;
  }

  flushPlain();
  return tokens;
}

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const HR_RE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const FENCE_RE = /^(\s*)(`{3,}|~{3,})(.*)$/;
const UNORDERED_RE = /^\s*[-*+]\s+(.*)$/;
const ORDERED_RE = /^\s*\d+\.\s+(.*)$/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/;

function splitTableRow(line: string): string[] {
  let trimmed = line.trim();
  if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);
  if (trimmed.endsWith("|")) trimmed = trimmed.slice(0, -1);
  return trimmed.split("|").map((cell) => cell.trim());
}

function isBlockStarter(lines: string[], index: number): boolean {
  const line = lines[index];
  if (!line.trim()) return true;
  if (FENCE_RE.test(line)) return true;
  if (HEADING_RE.test(line)) return true;
  if (HR_RE.test(line)) return true;
  if (/^\s*>\s?/.test(line)) return true;
  if (UNORDERED_RE.test(line) || ORDERED_RE.test(line)) return true;
  if (index + 1 < lines.length && line.includes("|") && TABLE_SEP_RE.test(lines[index + 1])) {
    return true;
  }
  return false;
}

function parseLines(lines: string[], keyPrefix: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  let blockIndex = 0;
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const blockKey = `${keyPrefix}-${blockIndex++}`;
    const fenceMatch = FENCE_RE.exec(line);
    if (fenceMatch) {
      const fenceChar = fenceMatch[2][0];
      const fenceLen = fenceMatch[2].length;
      const language = fenceMatch[3].trim().split(/\s+/)[0] || null;
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length) {
        const closing = new RegExp(`^\\s*${fenceChar}{${fenceLen},}\\s*$`);
        if (closing.test(lines[index])) {
          index += 1;
          break;
        }
        codeLines.push(lines[index]);
        index += 1;
      }
      blocks.push({ kind: "code", key: blockKey, language, code: codeLines.join("\n") });
      continue;
    }

    const headingMatch = HEADING_RE.exec(line);
    if (headingMatch) {
      const rawLevel = headingMatch[1].length;
      const level: 2 | 3 | 4 = rawLevel <= 2 ? 2 : rawLevel === 3 ? 3 : 4;
      const headingText = headingMatch[2].replace(/\s+#+\s*$/, "").trim();
      blocks.push({
        kind: "heading",
        key: blockKey,
        level,
        children: parseInlineMarkdown(headingText, blockKey),
      });
      index += 1;
      continue;
    }

    if (HR_RE.test(line)) {
      blocks.push({ kind: "hr", key: blockKey });
      index += 1;
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quoteLines: string[] = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        quoteLines.push(lines[index].replace(/^\s*>\s?/, ""));
        index += 1;
      }
      blocks.push({
        kind: "blockquote",
        key: blockKey,
        blocks: parseLines(quoteLines, `${blockKey}-q`),
      });
      continue;
    }

    if (index + 1 < lines.length && line.includes("|") && TABLE_SEP_RE.test(lines[index + 1])) {
      const headers: MarkdownCell[] = splitTableRow(line).map((cell, col) => {
        const cellKey = `${blockKey}-h-${col}`;
        return { key: cellKey, children: parseInlineMarkdown(cell, cellKey) };
      });
      index += 2;
      const rows: MarkdownRow[] = [];
      while (index < lines.length && lines[index].trim() && lines[index].includes("|")) {
        const cells = splitTableRow(lines[index]);
        const rowIndex = rows.length;
        const rowKey = `${blockKey}-r-${rowIndex}`;
        rows.push({
          key: rowKey,
          cells: headers.map((_, col) => {
            const cellKey = `${rowKey}-c-${col}`;
            return { key: cellKey, children: parseInlineMarkdown(cells[col] ?? "", cellKey) };
          }),
        });
        index += 1;
      }
      blocks.push({ kind: "table", key: blockKey, headers, rows });
      continue;
    }

    const unorderedMatch = UNORDERED_RE.exec(line);
    const orderedMatch = ORDERED_RE.exec(line);
    if (unorderedMatch || orderedMatch) {
      const ordered = Boolean(orderedMatch);
      const pattern = ordered ? ORDERED_RE : UNORDERED_RE;
      const items: MarkdownCell[] = [];
      while (index < lines.length) {
        const match = pattern.exec(lines[index]);
        if (!match) break;
        const itemKey = `${blockKey}-li-${items.length}`;
        items.push({ key: itemKey, children: parseInlineMarkdown(match[1].trim(), itemKey) });
        index += 1;
      }
      blocks.push({ kind: "list", key: blockKey, ordered, items });
      continue;
    }

    const paragraphLines: string[] = [line.trim()];
    index += 1;
    while (index < lines.length && !isBlockStarter(lines, index)) {
      paragraphLines.push(lines[index].trim());
      index += 1;
    }
    blocks.push({
      kind: "paragraph",
      key: blockKey,
      children: parseInlineMarkdown(paragraphLines.join(" "), blockKey),
    });
  }

  return blocks;
}

export function parseMarkdown(markdown: string): MarkdownBlock[] {
  const normalized = markdown.replace(/\r\n?/g, "\n");
  return parseLines(normalized.split("\n"), "md");
}
