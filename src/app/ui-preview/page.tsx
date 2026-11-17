import { notFound } from "next/navigation";
import { PreviewGallery } from "@/components/preview-gallery";

export default function UiPreviewPage() {
  if (process.env.NODE_ENV !== "development") notFound();
  return <PreviewGallery />;
}
