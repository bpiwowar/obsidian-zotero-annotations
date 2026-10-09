import { RequestUrlParam, RequestUrlResponse, requestUrl } from "obsidian";
import type { NoteAnnotation } from "./note-format";

const ZOTERO_API = "http://localhost:23119/api";
const ZOTERO_BASE = `${ZOTERO_API}/users/0`;

/** Most item keys the API accepts in one `itemKey=` filter */
const MAX_KEYS_PER_REQUEST = 50;

/**
 * Every request to Zotero goes through here. Zotero drops requests that look
 * like they come from a browser (Obsidian's user agent does) unless they
 * carry `Zotero-Allowed-Request`: without it the connection closes with an
 * empty response.
 */
function zoteroRequest(params: RequestUrlParam): Promise<RequestUrlResponse> {
  return requestUrl({ ...params, headers: { "Zotero-Allowed-Request": "true", ...params.headers } });
}

async function zoteroFetch(url: string): Promise<unknown> {
  const res = await zoteroRequest({ url });
  return res.json;
}

/** Case-insensitive response header lookup */
function header(res: RequestUrlResponse, name: string): string | null {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(res.headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return null;
}

export interface ZoteroAnnotation {
  key: string;
  type: "highlight" | "note" | "underline" | "image" | "ink" | "text";
  text: string;
  comment: string;
  color: string;
  pageLabel: string;
  /** Page in the PDF, from 0 (null for EPUBs and snapshots) */
  pageIndex: number | null;
  /** `annotationPosition` (page, rectangles…) */
  position: NoteAnnotation["position"] | null;
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
  /** Author and year as Zotero cites the item: "Doe et al., 2020" */
  citation: string;
  date: string;
  itemType: string;
  abstractNote: string;
  notes: ZoteroNote[];
  /** Items linked through Zotero's "Related" field */
  related: ZoteroItemSummary[];
}

export interface ZoteroNote {
  key: string;
  html: string;
}

/** Just enough of an item to list it: no children, no relations. */
export interface ZoteroItemSummary {
  key: string;
  title: string;
  /** Short form, e.g. "Doe et al." */
  creators: string;
  /** 4-digit year, or "" if the date could not be parsed */
  year: string;
  itemType: string;
}

export interface ZoteroApiItem {
  key: string;
  version: number;
  data: Record<string, unknown>;
}

type ZoteroCreator = { firstName?: string; lastName?: string; name?: string };

function creatorList(data: Record<string, unknown>): ZoteroCreator[] {
  return Array.isArray(data.creators) ? (data.creators as ZoteroCreator[]) : [];
}

function creatorName(c: ZoteroCreator): string {
  return c.name || [c.firstName, c.lastName].filter(Boolean).join(" ");
}

/** "Doe", "Doe & Roe", "Doe et al." */
function shortCreators(data: Record<string, unknown>): string {
  const names = creatorList(data)
    .map((c) => c.lastName || c.name || "")
    .filter(Boolean);
  if (names.length === 0) return "";
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} & ${names[1]}`;
  return `${names[0]} et al.`;
}

/**
 * Extract item keys from a Zotero `relations` object. Values of `dc:relation`
 * are URIs like `http://zotero.org/users/12345/items/ABCD1234` and may be a
 * single string rather than an array.
 */
export function extractRelatedKeys(relations: unknown): string[] {
  if (!relations || typeof relations !== "object") return [];
  const raw = (relations as Record<string, unknown>)["dc:relation"];
  const uris = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  const keys: string[] = [];
  for (const uri of uris) {
    if (typeof uri !== "string") continue;
    const m = /\/items\/([A-Z0-9]+)\/?$/i.exec(uri);
    if (m) keys.push(m[1]);
  }
  return Array.from(new Set(keys));
}

/** Child item types that are never interesting as a "related paper" */
const NON_PAPER_TYPES = new Set(["attachment", "note", "annotation"]);

/**
 * Fetch an item's title/creators/year with a single request.
 *
 * Keys taken from `zotero://open-pdf` links point at an attachment rather than
 * the paper, so an attachment is resolved to its parent item.
 */
export async function fetchItemSummary(key: string): Promise<ZoteroItemSummary | null> {
  try {
    const item = (await zoteroFetch(`${ZOTERO_BASE}/items/${key}`)) as ZoteroApiItem;
    const d = item.data;
    const itemType = (d.itemType as string) || "";
    if (itemType === "attachment" && typeof d.parentItem === "string") {
      return await fetchItemSummary(d.parentItem);
    }
    if (NON_PAPER_TYPES.has(itemType)) return null;
    const date = (d.date as string) || "";
    return {
      key: item.key,
      title: (d.title as string) || "(untitled)",
      creators: shortCreators(d),
      year: /\b(\d{4})\b/.exec(date)?.[1] || "",
      itemType,
    };
  } catch (e) {
    console.error(`Zotero Annotations: failed to fetch item ${key}`, e);
    return null;
  }
}

async function fetchRelatedItems(keys: string[]): Promise<ZoteroItemSummary[]> {
  const results = await Promise.all(keys.map((key) => fetchItemSummary(key)));

  return results
    .filter((r): r is ZoteroItemSummary => r !== null)
    .sort((a, b) => a.title.localeCompare(b.title));
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
    const creators = creatorList(d).map(creatorName).join(", ");
    const notes: ZoteroNote[] = children
      .filter((c) => (c.data.itemType as string) === "note")
      .map((c) => ({ key: c.key, html: (c.data.note as string) || "" }));
    const related = await fetchRelatedItems(extractRelatedKeys(d.relations));
    return {
      key: item.key,
      title: (d.title as string) || "(untitled)",
      creators,
      citation: [shortCreators(d), /\b(\d{4})\b/.exec((d.date as string) || "")?.[1]].filter(Boolean).join(", "),
      date: (d.date as string) || "",
      itemType: (d.itemType as string) || "",
      abstractNote: (d.abstractNote as string) || "",
      notes,
      related,
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
        let position: ZoteroAnnotation["position"] = null;
        try {
          position = JSON.parse((a.data.annotationPosition as string) || "null") as ZoteroAnnotation["position"];
        } catch {
          // no position
        }
        const pageIndex = typeof position?.pageIndex === "number" ? position.pageIndex : null;

        allAnnotations.push({
          key: a.key,
          type: (a.data.annotationType as ZoteroAnnotation["type"]) || "highlight",
          text: (a.data.annotationText as string) || "",
          comment: (a.data.annotationComment as string) || "",
          color: (a.data.annotationColor as string) || "#ffd400",
          pageLabel,
          pageIndex,
          position,
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

// ---------------------------------------------------------------------------
// Raw access, versions and writes (Zotero 10+ local API)
// ---------------------------------------------------------------------------

/**
 * Identity and state of the Zotero database behind the local API.
 *
 * Versions are local to one database (they have nothing to do with web-sync
 * versions), so anything stored alongside a version must also store the
 * server ID and be discarded when it changes.
 */
export interface LibraryState {
  serverId: string;
  /** Incremented once per transaction touching the library */
  version: number;
}

export async function fetchLibraryState(): Promise<LibraryState> {
  const res = await zoteroRequest({ url: `${ZOTERO_BASE}/items?limit=1&format=keys` });
  return {
    serverId: header(res, "Zotero-Server-ID") || "",
    version: parseInt(header(res, "Last-Modified-Version") || "0", 10),
  };
}

/**
 * Keys of the items (of any type: papers, notes, attachments, annotations)
 * modified after `since`, with the library version they were read at.
 * Deletions are not reported: the local API has no `/deleted` endpoint.
 */
export async function fetchChangedItems(
  since: number
): Promise<{ version: number; changed: Record<string, number> }> {
  const res = await zoteroRequest({ url: `${ZOTERO_BASE}/items?since=${since}&format=versions` });
  return {
    version: parseInt(header(res, "Last-Modified-Version") || "0", 10),
    changed: (res.json as Record<string, number>) || {},
  };
}

export async function fetchItem(key: string): Promise<ZoteroApiItem> {
  return (await zoteroFetch(`${ZOTERO_BASE}/items/${key}`)) as ZoteroApiItem;
}

export async function fetchChildren(key: string, itemType?: string): Promise<ZoteroApiItem[]> {
  const filter = itemType ? `?itemType=${itemType}` : "";
  return (await zoteroFetch(`${ZOTERO_BASE}/items/${key}/children${filter}`)) as ZoteroApiItem[];
}

/** Fetches many items by key, batching the requests; missing keys are skipped. */
export async function fetchItems(keys: string[]): Promise<ZoteroApiItem[]> {
  const result: ZoteroApiItem[] = [];
  for (let i = 0; i < keys.length; i += MAX_KEYS_PER_REQUEST) {
    const batch = keys.slice(i, i + MAX_KEYS_PER_REQUEST);
    const items = (await zoteroFetch(
      `${ZOTERO_BASE}/items?itemKey=${batch.join(",")}&includeTrashed=1`
    )) as ZoteroApiItem[];
    result.push(...items);
  }
  return result;
}

export interface ZoteroCollection {
  key: string;
  name: string;
  parentCollection: string | null;
}

export async function fetchCollections(): Promise<ZoteroCollection[]> {
  const raw = (await zoteroFetch(`${ZOTERO_BASE}/collections`)) as ZoteroApiItem[];
  return raw.map((c) => ({
    key: c.key,
    name: (c.data.name as string) || "",
    parentCollection: typeof c.data.parentCollection === "string" ? c.data.parentCollection : null,
  }));
}

/**
 * Absolute path of an attachment's file (stored or linked), or null when the
 * attachment has no file on this computer.
 */
export async function fetchAttachmentPath(key: string): Promise<string | null> {
  try {
    const res = await zoteroRequest({ url: `${ZOTERO_BASE}/items/${key}/file/view/url`, throw: false });
    if (res.status !== 200 || !res.text.startsWith("file://")) return null;
    return decodeURIComponent(new URL(res.text.trim()).pathname);
  } catch {
    return null;
  }
}

/** Raised when a write is rejected because the object changed in Zotero (HTTP 412). */
export class ZoteroConflictError extends Error {}

/**
 * Write access to the local API.
 *
 * Writes need two headers: `Zotero-Server-ID` (which database we expect) and
 * `Zotero-API-Key`, obtained through `/local/authorize`, which shows the user
 * an Allow / Always Allow / Deny dialog in Zotero. Only an "Always Allow" key
 * is worth keeping; a plain "Allow" key is consumed by the first write.
 */
export class ZoteroWriter {
  constructor(
    private appName: string,
    private loadKey: () => string | null,
    private saveKey: (key: string | null) => Promise<void>
  ) {}

  /**
   * Updates fields of an item, failing with {@link ZoteroConflictError} if
   * it changed in Zotero since `version`.
   */
  async patchItem(serverId: string, key: string, version: number, data: Record<string, unknown>): Promise<void> {
    await this.write(serverId, "PATCH", `/items/${key}`, data, version);
  }

  /** Creates items, returning their keys in the same order. */
  async createItems(serverId: string, items: Record<string, unknown>[]): Promise<string[]> {
    const res = (await this.write(serverId, "POST", "/items", items, null)) as {
      successful?: Record<string, { key: string }>;
      failed?: Record<string, { message?: string }>;
    };
    return items.map((_, i) => {
      const ok = res.successful?.[i];
      if (!ok) throw new Error(res.failed?.[i]?.message || "Zotero refused to create the item");
      return ok.key;
    });
  }

  private async write(
    serverId: string,
    method: string,
    path: string,
    body: unknown,
    version: number | null
  ): Promise<unknown> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const apiKey = this.loadKey() || (await this.authorize(serverId));
      const headers: Record<string, string> = {
        "Zotero-Server-ID": serverId,
        "Zotero-API-Key": apiKey,
      };
      if (version !== null) headers["If-Unmodified-Since-Version"] = String(version);
      const res = await zoteroRequest({
        url: `${ZOTERO_BASE}${path}`,
        method,
        contentType: "application/json",
        body: JSON.stringify(body),
        headers,
        throw: false,
      });
      if (res.status === 401) {
        // Revoked, or a single-use key: ask again once
        await this.saveKey(null);
        continue;
      }
      if (res.status === 412) throw new ZoteroConflictError(res.text);
      if (res.status >= 400) throw new Error(`Zotero write failed (${res.status}): ${res.text}`);
      return res.status === 204 ? null : res.json;
    }
    throw new Error("Zotero did not authorize this plugin to write");
  }

  /** Asks Zotero for a key; resolves once the user has answered the dialog. */
  private async authorize(serverId: string): Promise<string> {
    const res = await zoteroRequest({
      url: `${ZOTERO_API}/local/authorize`,
      method: "POST",
      contentType: "application/json",
      body: JSON.stringify({ appName: this.appName }),
      headers: { "Zotero-Server-ID": serverId },
      throw: false,
    });
    if (res.status === 403) throw new Error("Write access was denied in Zotero");
    if (res.status !== 200) throw new Error(`Zotero authorization failed (${res.status}): ${res.text}`);
    const { key, remember } = res.json as { key: string; remember: boolean };
    if (remember) await this.saveKey(key);
    return key;
  }
}
