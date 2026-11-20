export function parseKnowledgeCitations(
  value: string,
): Array<{ title: string; url: string }> | null {
  const citations: Array<{ title: string; url: string }> = [];
  for (const line of value.split("\n")) {
    const text = line.trim();
    if (!text) continue;
    const separator = text.indexOf("|");
    if (separator < 1) return null;
    const title = text.slice(0, separator).trim();
    const url = text.slice(separator + 1).trim();
    try {
      const parsed = new URL(url);
      if (
        !title ||
        title.length > 240 ||
        !["http:", "https:"].includes(parsed.protocol) ||
        url.length > 2048
      ) {
        return null;
      }
    } catch {
      return null;
    }
    citations.push({ title, url });
    if (citations.length > 30) return null;
  }
  return citations;
}

export function formatKnowledgeCitations(citations: Array<{ title: string; url: string }>): string {
  return citations.map((citation) => `${citation.title} | ${citation.url}`).join("\n");
}

export function normalizeKnowledgeDate(value: string): string | null {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value
    ? null
    : parsed.toISOString();
}
