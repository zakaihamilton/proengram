import { Badge } from "panel-frame-ui";
import type { ReactNode } from "react";

export function Status({ ready }: { ready: boolean }) {
  return <Badge tone={ready ? "success" : "warning"}>{ready ? "Configured" : "Needs setup"}</Badge>;
}

export function InlineActionForm({
  action,
  fieldName,
  value,
  label,
}: {
  action: (formData: FormData) => Promise<void>;
  fieldName: string;
  value: string;
  label: string;
}) {
  return (
    <form action={action}>
      <input name={fieldName} type="hidden" value={value} />
      <button className="text-link" type="submit">
        {label}
      </button>
    </form>
  );
}

export function RemoveSourceAction({
  action,
  sourceId,
}: {
  action: (formData: FormData) => Promise<void>;
  sourceId: string;
}) {
  return <InlineActionForm action={action} fieldName="sourceId" label="Remove" value={sourceId} />;
}

export function ConnectionStatusList<T extends { id: string }>({
  items,
  title,
  renderRow,
}: {
  items: T[];
  title: string;
  renderRow: (item: T) => ReactNode;
}) {
  if (!items.length) return null;
  return (
    <div className="connection-action">
      <h3>{title}</h3>
      <div className="status-list">
        {items.map((item) => (
          <div className="status-row" key={item.id}>
            {renderRow(item)}
          </div>
        ))}
      </div>
    </div>
  );
}
