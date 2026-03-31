import { requestUrl } from "obsidian";

const ZOTERO_BASE = "http://localhost:23119/api/users/0";

async function zoteroFetch(url: string): Promise<unknown> {
  const res = await requestUrl({
    url,
    headers: {
      "Zotero-Allowed-Request": "true",
    },
  });
  return res.json;
}

export interface ZoteroAnnotation {
  key: string;
  type: "highlight" | "note" | "underline" | "image" | "ink" | "text";
  text: string;
  comment: string;
  color: string;
  pageLabel: string;
  tags: string[];
  /** The attachment key that contains this annotation */
  attachmentKey: string;
  /** Sort key: page number (parsed as int, fallback to 0) */
  sortPage: number;
  /** Position within the page (sortIndex field from Zotero) */
  sortIndex: string;
}

export interface ZoteroItemInfo {
  key: string;
  title: string;
  creators: string;
  date: string;
  itemType: string;
  abstractNote: string;
  notes: ZoteroNote[];
}

export interface ZoteroNote {
  key: string;
  html: string;
}

interface ZoteroApiItem {
  key: string;
  data: Record<string, unknown>;
}

/**
 * Fetch a single item's metadata by key.
 */
export async function fetchItemInfo(itemKey: string): Promise<ZoteroItemInfo | null> {
  try {
    const [item, children] = await Promise.all([
      zoteroFetch(`${ZOTERO_BASE}/items/${itemKey}`) as Promise<ZoteroApiItem>,
      zoteroFetch(`${ZOTERO_BASE}/items/${itemKey}/children`) as Promise<ZoteroApiItem[]>,
    ]);
    const d = item.data;
    const creators = Array.isArray(d.creators)
      ? (d.creators as Array<{ firstName?: string; lastName?: string; name?: string }>)
          .map((c) => c.name || [c.firstName, c.lastName].filter(Boolean).join(" "))
          .join(", ")
      : "";
    const notes: ZoteroNote[] = children
      .filter((c) => (c.data.itemType as string) === "note")
      .map((c) => ({ key: c.key, html: (c.data.note as string) || "" }));
    return {
      key: item.key,
      title: (d.title as string) || "(untitled)",
      creators,
      date: (d.date as string) || "",
      itemType: (d.itemType as string) || "",
      abstractNote: (d.abstractNote as string) || "",
      notes,
    };
  } catch (e) {
    console.error("Zotero Annotations: failed to fetch item info", e);
    return null;
  }
}

/**
 * Given a top-level item key, find all PDF attachments, then collect
 * all annotation child items from those attachments.
 */
export async function fetchAnnotations(itemKey: string): Promise<ZoteroAnnotation[]> {
  // Step 1: get children of the top-level item → find PDF attachments
  const children = await zoteroFetch(`${ZOTERO_BASE}/items/${itemKey}/children`) as ZoteroApiItem[];

  const pdfAttachments = children.filter(
    (c) =>
      (c.data.itemType as string) === "attachment" &&
      (c.data.contentType as string) === "application/pdf"
  );

  if (pdfAttachments.length === 0) {
    return [];
  }

  // Step 2: for each PDF attachment, fetch annotation children
  const allAnnotations: ZoteroAnnotation[] = [];

  for (const pdf of pdfAttachments) {
    try {
      const annotItems = await zoteroFetch(
        `${ZOTERO_BASE}/items/${pdf.key}/children?itemType=annotation`
      ) as ZoteroApiItem[];

      for (const a of annotItems) {

        const pageLabel = (a.data.annotationPageLabel as string) || "";
        const pageNum = parseInt(pageLabel, 10);

        allAnnotations.push({
          key: a.key,
          type: (a.data.annotationType as ZoteroAnnotation["type"]) || "highlight",
          text: (a.data.annotationText as string) || "",
          comment: (a.data.annotationComment as string) || "",
          color: (a.data.annotationColor as string) || "#ffd400",
          pageLabel,
          tags: Array.isArray(a.data.tags)
            ? (a.data.tags as Array<{ tag: string }>).map((t) => t.tag)
            : [],
          attachmentKey: pdf.key,
          sortPage: isNaN(pageNum) ? 0 : pageNum,
          sortIndex: (a.data.annotationSortIndex as string) || "0",
        });
      }
    } catch (e) {
      console.error(`Zotero Annotations: failed to fetch annotations for attachment ${pdf.key}`, e);
    }
  }

  // Sort by page, then by sortIndex within page
  allAnnotations.sort((a, b) => {
    if (a.sortPage !== b.sortPage) return a.sortPage - b.sortPage;
    return a.sortIndex.localeCompare(b.sortIndex);
  });

  return allAnnotations;
}

/**
 * Check whether the Zotero local server is reachable.
 */
export async function isZoteroRunning(): Promise<boolean> {
  try {
    await zoteroFetch("http://localhost:23119/api/users/0/items?limit=1");
    return true;
  } catch {
    return false;
  }
}
