import Link from "next/link";
import { Badge, Card } from "panel-frame-ui";
import { formatRelativeTime } from "@/lib/date";
import type { BrainItem } from "@/lib/db/brain";

const kindLabels = {
  github_markdown: "GitHub Markdown",
  google_drive_document: "Google Drive",
  saved_answer: "Saved answer",
  sentry8_policy: "Sentry8 policy",
  decision_record: "Decision",
  project_update: "Project update",
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
      {item.projectName ? <span className="metric-note">{item.projectName}</span> : null}
      {item.matchLocator ? <span className="metric-note">{item.matchLocator}</span> : null}
      <p className="brain-item-excerpt">
        {(item.matchExcerpt ?? item.markdown)
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
