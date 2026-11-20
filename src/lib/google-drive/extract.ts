import ExcelJS from "exceljs";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { KnowledgeSegment } from "@/lib/knowledge/chunk";

const GOOGLE_DRIVE_MIME_TYPES = {
  document: "application/vnd.google-apps.document",
  spreadsheet: "application/vnd.google-apps.spreadsheet",
  presentation: "application/vnd.google-apps.presentation",
  pdf: "application/pdf",
} as const;

const XLSX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export type GoogleDriveExtraction = {
  segments: KnowledgeSegment[];
  skipReason: string | null;
};

export function googleDriveExportMimeType(mimeType: string): string | null {
  switch (mimeType) {
    case GOOGLE_DRIVE_MIME_TYPES.document:
    case GOOGLE_DRIVE_MIME_TYPES.presentation:
    case GOOGLE_DRIVE_MIME_TYPES.pdf:
      return "application/pdf";
    case GOOGLE_DRIVE_MIME_TYPES.spreadsheet:
      return XLSX_MIME_TYPE;
    default:
      return null;
  }
}

async function extractPdfSegments(data: Uint8Array): Promise<KnowledgeSegment[]> {
  const document = await getDocument({
    data,
    useSystemFonts: true,
    stopAtErrors: true,
  }).promise;
  try {
    const segments: KnowledgeSegment[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = content.items
        .flatMap((item) => {
          if (!item || typeof item !== "object" || !("str" in item)) return [];
          const value = (item as { str?: unknown }).str;
          return typeof value === "string" && value.trim() ? [value.trim()] : [];
        })
        .join(" ");
      if (text) segments.push({ text, locator: `Page ${pageNumber}` });
      page.cleanup();
    }
    return segments;
  } finally {
    await document.cleanup();
  }
}

async function extractWorkbookSegments(data: Uint8Array): Promise<KnowledgeSegment[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(data) as never);
  const segments: KnowledgeSegment[] = [];

  for (const worksheet of workbook.worksheets) {
    let rows: string[] = [];
    let firstRow = 0;
    let lastRow = 0;
    const flush = () => {
      if (!rows.length) return;
      segments.push({
        text: rows.join("\n"),
        locator: `${worksheet.name} · rows ${firstRow}–${lastRow}`,
      });
      rows = [];
    };

    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      const values: string[] = [];
      row.eachCell({ includeEmpty: false }, (cell) => {
        const value = cell.text.trim();
        if (value) values.push(value);
      });
      if (!values.length) return;
      if (!rows.length) firstRow = rowNumber;
      lastRow = rowNumber;
      rows.push(`${rowNumber}: ${values.join(" | ")}`);
      if (rows.length >= 30) flush();
    });
    flush();
  }

  return segments;
}

export async function extractGoogleDriveFile(
  mimeType: string,
  data: Uint8Array,
): Promise<GoogleDriveExtraction> {
  try {
    let segments: KnowledgeSegment[];
    if (mimeType === GOOGLE_DRIVE_MIME_TYPES.spreadsheet) {
      segments = await extractWorkbookSegments(data);
    } else if (
      mimeType === GOOGLE_DRIVE_MIME_TYPES.document ||
      mimeType === GOOGLE_DRIVE_MIME_TYPES.presentation ||
      mimeType === GOOGLE_DRIVE_MIME_TYPES.pdf
    ) {
      segments = await extractPdfSegments(data);
    } else {
      return { segments: [], skipReason: "Unsupported file type." };
    }

    if (!segments.some((segment) => segment.text.trim())) {
      return { segments: [], skipReason: "No extractable text was found; OCR is not supported." };
    }
    return { segments, skipReason: null };
  } catch {
    return { segments: [], skipReason: "The file could not be extracted." };
  }
}
