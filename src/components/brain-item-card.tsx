import Link from "next/link";
import { Badge, Card } from "panel-frame-ui";
import type { BrainItem } from "@/lib/db/brain";
import { formatRelativeTime } from "@/lib/date";

const kindLabels = {
  github_markdown: "GitHub Markdown",
  saved_answer: "Saved answer",
  sentry8_policy: "Sentry8 policy",
} as const;

export function BrainItemCard({ item }: { item: BrainItem }) {
  return (
    <Card className="brain-item">
      <div className="brain-item-meta">
        <Badge tone={item.kind === "sentry8_policy" ? "accent" : "neutral"}>
          {kindLabels[item.kind]}
        </Badge>
        <span>{formatRelativeTime(item.updatedAt)}</span>
        {item.sourceRevision ? <span>Revision {item.sourceRevision.slice(0, 8)}</span> : null}
      </div>
      <Link className="brain-item-title" href={`/knowledge/${item.id}`}>
        {item.title}
      </Link>
      <p className="brain-item-excerpt">
        {item.markdown
          .replace(/^#+\s*/gm, "")
          .replace(/\s+/g, " ")
          .trim()}
      </p>
      {item.sourceUrl ? (
        <a className="source-link" href={item.sourceUrl} rel="noreferrer" target="_blank">
          Open source ↗
        </a>
      ) : null}
    </Card>
  );
}
