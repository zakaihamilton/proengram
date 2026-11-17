import type { BrainItem } from "@/lib/db/brain";
import { BrainItemCard } from "./brain-item-card";

export function BrainItemList({ items }: { items: BrainItem[] }) {
  return (
    <div className="item-list">
      {items.map((item) => (
        <BrainItemCard item={item} key={item.id} />
      ))}
    </div>
  );
}
