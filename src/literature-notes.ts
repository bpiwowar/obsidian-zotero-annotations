/**
 * Literature notes: one vault note per Zotero paper, kept in sync with Zotero.
 *
 *     ---
 *     zotero-key: ABCD1234          ← identity
 *     title, citekey                ← refreshed from Zotero
 *     zotero: zotero://select/…     ← link to the item
 *     zotero-pdf: zotero://open-pdf/…  ← its PDF in Zotero's reader
 *     pdf: file:///…/paper.pdf      ← the PDF file (or other file)
 *     zotero-note: NOTEKEY          ← the Zotero note the body mirrors
 *     ---
 *     …a Zotero child note, as Markdown…
 *
 * With several Zotero notes, each one is a region of the body instead:
 *
 *     %%zt-note: NOTEKEY%%
 *     …
 *     %%/zt-note%%
 *
 * Each region (or the whole body) mirrors one Zotero child note. A region is refreshed
 * from Zotero only while its text is still what was last written (tracked by
 * hash); a region edited in Obsidian is left alone. Annotations are not
 * copied into notes: the sidebar shows them.
 */
import { App, Notice, TFile, htmlToMarkdown, normalizePath } from "obsidian";
import { createHash } from "crypto";
import { readFile } from "fs/promises";
import {
  ZoteroApiItem,
  fetchAttachmentPath,
  fetchChangedItems,
  fetchChildren,
  fetchItem,
  fetchItems,
  fetchLibraryState,
} from "./zotero-client";
import {
  ShortTitleOptions,
  attachmentReaderLink,
  fileUrl,
  itemBacklink,
  mainAttachment,
  notePath,
  NoteRegion,
  SINGLE_NOTE_PROPERTY,
  noteLayout,
  noteRegion,
  NoteAnnotation,
  annotationImage,
  annotationLink,
  citationLink,
} from "./note-format";

export interface LiteratureNoteSettings {
  /** Folder new literature notes are created in */
  notesFolder: string;
  /** Folder images (annotation excerpts, note images) are copied to */
  imageFolder: string;
  /** Zotero data directory, for the annotation image cache */
  zoteroDataDir: string;
  /** How note names shorten titles */
  titleOptions: ShortTitleOptions;
}

/** Bumped when the state file format changes */
const STATE_VERSION = 1;

/** Below this, re-opening a literature note does not query Zotero again */
const REFRESH_ON_OPEN_MS = 60_000;

/** Above this many unknown changed items, refresh every tracked note instead */
const MAX_CHANGED_LOOKUP = 1000;


interface RegionState {
  /** Zotero version of the note when it was last written to the file */
  version: number;
  /** Hash of the region text as last written */
  hash: string;
}

interface TrackedNote {
  path: string;
  /** Keys of the item's attachments, notes, annotations and note images */
  descendants: string[];
  regions: Record<string, RegionState>;
  /** Hash of the whole file after the last write */
  fileHash: string;
}

interface SyncState {
  version: number;
  serverId: string;
  libraryVersion: number;
  items: Record<string, TrackedNote>;
}


function hash(text: string): string {
  return createHash("sha1").update(text.trim()).digest("hex");
}

/** A URI-encoded JSON attribute of Zotero note HTML (`data-annotation`, `data-citation`) */
function parseDataAttribute<T>(el: Element, name: string): T | null {
  try {
    return JSON.parse(decodeURIComponent(el.getAttribute(name) || "")) as T;
  } catch {
    return null;
  }
}

/** "http://zotero.org/users/1/items/KEY" → "library/items/KEY" ("groups/N/items/KEY" for groups) */
function zoteroUriPath(uri: string): string | null {
  const m = uri.match(/\/(users\/\w+|groups\/\d+)\/items\/([A-Z0-9]{8})$/);
  if (!m) return null;
  return `${m[1].startsWith("groups") ? m[1] : "library"}/items/${m[2]}`;
}



/** What a literature note is built from */
interface ItemBundle {
  item: ZoteroApiItem;
  attachments: ZoteroApiItem[];
  notes: ZoteroApiItem[];
  /** Attachment key → absolute file path (when the file is on this computer) */
  filePaths: Map<string, string>;
}

/** A Zotero note converted for the vault */
interface RenderedNote {
  key: string;
  version: number;
  markdown: string;
}

export class LiteratureNotes {
  private state: SyncState = { version: STATE_VERSION, serverId: "", libraryVersion: 0, items: {} };
  private stateLoaded: Promise<void> | null = null;
  private locks = new Map<string, Promise<unknown>>();
  private lastRefresh = new Map<string, number>();
  private syncing: Promise<void> | null = null;

  constructor(
    private app: App,
    private settings: () => LiteratureNoteSettings,
    /** Vault-relative path of the state file, or null to keep it in memory */
    private statePath: string | null
  ) {}

  // -------------------------------------------------------------------------
  // Lookup
  // -------------------------------------------------------------------------

  /** The literature note of an item, if one exists in the vault */
  findNote(itemKey: string): TFile | null {
    const tracked = this.state.items[itemKey];
    if (tracked) {
      const file = this.app.vault.getAbstractFileByPath(tracked.path);
      if (file instanceof TFile && this.keyOf(file) === itemKey) return file;
    }
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (this.keyOf(file) === itemKey) return file;
    }
    return null;
  }

  /** The Zotero item key of a literature note, or null for other notes */
  keyOf(file: TFile): string | null {
    const key: unknown = this.app.metadataCache.getFileCache(file)?.frontmatter?.["zotero-key"];
    return typeof key === "string" && /^[A-Z0-9]{8}$/.test(key) ? key : null;
  }

  // -------------------------------------------------------------------------
  // Create / update
  // -------------------------------------------------------------------------

  /** Opens the literature note of an item, creating it first if needed. */
  async open(itemKey: string): Promise<void> {
    const file = (await this.ensure(itemKey)) ?? null;
    if (file) await this.app.workspace.getLeaf(false).openFile(file);
  }

  /**
   * The literature note of an item, created if it does not exist yet.
   * With `onlyWithNotes`, a paper without Zotero notes gets no file.
   */
  async ensure(itemKey: string, { onlyWithNotes = false } = {}): Promise<TFile | null> {
    await this.loadState();
    return this.locked(itemKey, async () => {
      const existing = this.findNote(itemKey);
      if (existing) return existing;
      return this.create(itemKey, onlyWithNotes);
    });
  }

  /**
   * Re-renders a literature note from Zotero. With `overwrite`, regions edited
   * or removed in Obsidian are replaced too.
   */
  async update(file: TFile, overwrite = false): Promise<void> {
    const key = this.keyOf(file);
    if (!key) return;
    await this.loadState();
    await this.locked(key, () => this.refresh(key, file, overwrite));
  }

  /**
   * Called when a note is opened: refreshes it if it is a literature note of
   * this plugin not refreshed recently. Notes with a zotero-key made by other
   * tools are only touched by an explicit refresh.
   */
  async onOpen(file: TFile): Promise<void> {
    const key = this.keyOf(file);
    if (!key) return;
    await this.loadState();
    if (this.state.items[key]?.path !== file.path) return;
    const last = this.lastRefresh.get(key) || 0;
    if (Date.now() - last < REFRESH_ON_OPEN_MS) return;
    try {
      await this.update(file);
    } catch (e) {
      console.warn("Zotero Annotations: could not refresh literature note", e);
    }
  }

  onRename(file: TFile, oldPath: string): void {
    for (const tracked of Object.values(this.state.items)) {
      if (tracked.path === oldPath) {
        tracked.path = file.path;
        void this.saveState();
      }
    }
  }

  private async create(itemKey: string, onlyWithNotes: boolean): Promise<TFile | null> {
    const bundle = await this.fetchBundle(itemKey);
    if (!bundle || (onlyWithNotes && bundle.notes.length === 0)) return null;
    const { notesFolder, titleOptions } = this.settings();
    let base = notePath(bundle.item, normalizePath(notesFolder || "/"), titleOptions);
    base = normalizePath(base);
    for (let i = 2; this.app.vault.getAbstractFileByPath(`${base}.md`); i++) base = `${base} (${i})`;
    const path = `${base}.md`;
    await this.ensureFolder(path.split("/").slice(0, -1).join("/"));

    const notes = await this.renderNotes(bundle, path);
    // A single note needs no markers
    const single = notes.length === 1 ? notes[0].key : null;
    const body = single ? `${notes[0].markdown.trim()}\n` : notes.map((n) => noteRegion(n.key, n.markdown)).join("\n\n");

    const file = await this.app.vault.create(path, body);
    await this.writeFrontmatter(file, bundle, single);
    await this.track(itemKey, file, bundle, notes);
    return file;
  }

  private async refresh(itemKey: string, file: TFile, overwrite = false): Promise<void> {
    const bundle = await this.fetchBundle(itemKey);
    if (!bundle) return;
    const notes = await this.renderNotes(bundle, file.path);
    const tracked = this.state.items[itemKey];
    const known = tracked?.regions || {};
    const kept: string[] = [];

    // The Zotero note held without markers (see `noteLayout`), if any
    let single: string | null = null;
    await this.app.vault.process(file, (text) => {
      const layout = noteLayout(text);
      const { regions } = layout;
      const byKey = new Map(regions.filter((r) => r.key).map((r) => [r.key as string, r]));
      const zoteroKeys = new Set(notes.map((n) => n.key));

      // Note regions: refreshed while unmodified, added when new, dropped when deleted in Zotero
      const replaced = new Map<NoteRegion, string | null>();
      const added: RenderedNote[] = [];
      for (const note of notes) {
        const region = byKey.get(note.key);
        const prev = known[note.key];
        if (!region) {
          // A region removed from the file on purpose is not brought back
          if (!prev || overwrite) added.push(note);
        } else if (overwrite || !prev || hash(region.body) === prev.hash) {
          replaced.set(region, note.markdown);
        } else {
          kept.push(note.key);
        }
      }
      for (const region of regions) {
        if (!region.key || zoteroKeys.has(region.key)) continue;
        const prev = known[region.key];
        if (overwrite || (prev && hash(region.body) === prev.hash)) replaced.set(region, null);
      }

      const remaining = [
        ...regions
          .filter((r) => replaced.get(r) !== null)
          .map((r) => ({ key: r.key, body: replaced.get(r) ?? r.body })),
        ...added.map((n) => ({ key: n.key, body: n.markdown })),
      ];
      const head = text.slice(0, layout.contentStart);
      // Text of the body outside the regions (none when the body is the note)
      let outside = "";
      if (!layout.bare) {
        let pos = layout.contentStart;
        for (const r of regions) {
          outside += text.slice(pos, r.start);
          pos = r.end;
        }
        outside += text.slice(pos);
      }

      // A single Zotero note and nothing else: no markers
      if (remaining.length === 1 && remaining[0].key && !outside.trim()) {
        single = remaining[0].key;
        return `${head}${remaining[0].body.trim()}\n`;
      }
      if (layout.bare) {
        return remaining.length > 0 ? `${head}${remaining.map((r) => noteRegion(r.key, r.body)).join("\n\n")}\n` : head;
      }

      const edits: { start: number; end: number; text: string }[] = [];
      for (const [region, body] of replaced) {
        edits.push({ start: region.start, end: region.end, text: body === null ? "" : noteRegion(region.key, body) });
      }
      if (added.length > 0) {
        const at = regions.length > 0 ? regions[regions.length - 1].end : text.length;
        const block = added.map((n) => noteRegion(n.key, n.markdown)).join("\n\n");
        edits.push({ start: at, end: at, text: `\n\n${block}` });
      }
      let out = text;
      edits.sort((a, b) => b.start - a.start);
      for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);
      return out.replace(/\n{4,}/g, "\n\n\n");
    });

    await this.writeFrontmatter(file, bundle, single);
    await this.track(itemKey, file, bundle, notes, new Set(kept));
    if (kept.length > 0) {
      new Notice(
        `${file.basename}: ${kept.length} note section(s) edited in Obsidian were kept as they are.`
      );
    }
  }

  private async writeFrontmatter(file: TFile, bundle: ItemBundle, single: string | null): Promise<void> {
    const d = bundle.item.data;
    await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
      fm["zotero-key"] = bundle.item.key;
      fm.title = (d.title as string) || null;
      fm.citekey = (d.citationKey as string) || null;
      fm.zotero = itemBacklink(bundle.item.key);
      if (single) fm[SINGLE_NOTE_PROPERTY] = single;
      else delete fm[SINGLE_NOTE_PROPERTY];
      const main = mainAttachment(bundle.attachments, bundle.filePaths);
      if (main) {
        fm["zotero-pdf"] = attachmentReaderLink(main.key);
        fm.pdf = fileUrl(main.path);
      } else {
        delete fm["zotero-pdf"];
        delete fm.pdf;
      }
    });
  }

  /** Records what was written, so later updates can tell local edits apart. */
  private async track(
    itemKey: string,
    file: TFile,
    bundle: ItemBundle,
    notes: RenderedNote[],
    keptLocal: Set<string> = new Set()
  ): Promise<void> {
    const prev = this.state.items[itemKey]?.regions || {};
    const regions: Record<string, RegionState> = {};
    const text = await this.app.vault.read(file);
    const inFile = new Set(noteLayout(text).regions.map((r) => r.key));
    for (const note of notes) {
      if (keptLocal.has(note.key)) {
        if (prev[note.key]) regions[note.key] = prev[note.key];
      } else if (inFile.has(note.key) || prev[note.key]) {
        regions[note.key] = { version: note.version, hash: hash(note.markdown) };
      }
    }
    const descendants = [...bundle.attachments.map((a) => a.key), ...bundle.notes.map((n) => n.key)];
    this.state.items[itemKey] = { path: file.path, descendants, regions, fileHash: hash(text) };
    this.lastRefresh.set(itemKey, Date.now());
    await this.saveState();
  }

  // -------------------------------------------------------------------------
  // Incremental sync
  // -------------------------------------------------------------------------

  /**
   * Refreshes the literature notes whose item changed in Zotero since the
   * last sync (item, notes, attachments or annotations).
   */
  sync(): Promise<void> {
    if (!this.syncing) {
      this.syncing = this.doSync().finally(() => {
        this.syncing = null;
      });
    }
    return this.syncing;
  }

  private async doSync(): Promise<void> {
    await this.loadState();
    const lib = await fetchLibraryState();
    const tracked = Object.keys(this.state.items);

    let affected: Set<string>;
    if (lib.serverId !== this.state.serverId || this.state.libraryVersion === 0) {
      // Another Zotero database (or first run): versions mean nothing, re-check everything
      affected = new Set(tracked);
      this.state.serverId = lib.serverId;
      for (const t of Object.values(this.state.items)) {
        for (const r of Object.values(t.regions)) r.version = 0;
      }
    } else if (lib.version === this.state.libraryVersion) {
      return;
    } else {
      affected = await this.affectedItems(this.state.libraryVersion);
    }

    for (const key of affected) {
      const file = this.findNote(key);
      if (!file) {
        delete this.state.items[key];
        continue;
      }
      try {
        await this.locked(key, () => this.refresh(key, file));
      } catch (e) {
        console.error(`Zotero Annotations: failed to sync ${file.path}`, e);
      }
    }
    this.state.libraryVersion = lib.version;
    await this.saveState();
  }

  /** Tracked items touched by the changes since `since` */
  private async affectedItems(since: number): Promise<Set<string>> {
    const { changed } = await fetchChangedItems(since);
    const owners = new Map<string, string>();
    for (const [key, t] of Object.entries(this.state.items)) {
      owners.set(key, key);
      for (const d of t.descendants) owners.set(d, key);
    }
    const affected = new Set<string>();
    let unknown: string[] = [];
    for (const key of Object.keys(changed)) {
      const owner = owners.get(key);
      if (owner) affected.add(owner);
      else unknown.push(key);
    }
    if (unknown.length > MAX_CHANGED_LOOKUP) return new Set(Object.keys(this.state.items));

    // New children (a new annotation, note or attachment) are found through
    // their parent; an annotation on a new attachment needs two hops.
    for (let hop = 0; hop < 2 && unknown.length > 0; hop++) {
      const items = await fetchItems(unknown);
      const parents: string[] = [];
      for (const item of items) {
        const parent = item.data.parentItem;
        if (typeof parent !== "string") continue;
        const owner = owners.get(parent);
        if (owner) affected.add(owner);
        else parents.push(parent);
      }
      unknown = Array.from(new Set(parents));
    }
    return affected;
  }

  // -------------------------------------------------------------------------
  // Zotero → vault
  // -------------------------------------------------------------------------

  private async fetchBundle(itemKey: string): Promise<ItemBundle | null> {
    let item = await fetchItem(itemKey);
    // Keys from open-pdf links point at the attachment
    if (item.data.itemType === "attachment" && typeof item.data.parentItem === "string") {
      item = await fetchItem(item.data.parentItem);
    }
    if (["attachment", "note", "annotation"].includes(item.data.itemType as string)) return null;

    const children = await fetchChildren(item.key);
    const attachments = children.filter((c) => c.data.itemType === "attachment");
    const notes = children.filter((c) => c.data.itemType === "note");
    const filePaths = new Map<string, string>();
    await Promise.all(
      attachments.map(async (att) => {
        const path = await fetchAttachmentPath(att.key);
        if (path) filePaths.set(att.key, path);
      })
    );
    return { item, attachments, notes, filePaths };
  }

  private annotationCachePath(annotationKey: string): string {
    return `${this.settings().zoteroDataDir}/cache/library/${annotationKey}.png`;
  }

  /** Copies a file into the image folder (unless an identical copy is there); null if unreadable */
  async importImage(source: string, name: string): Promise<TFile | null> {
    let data: Buffer;
    try {
      data = await readFile(source);
    } catch {
      return null;
    }
    const folder = normalizePath(this.settings().imageFolder || this.settings().notesFolder || "/");
    await this.ensureFolder(folder);
    const path = normalizePath(`${folder}/${name}`);
    const bytes = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      if (existing.stat.size !== data.byteLength) await this.app.vault.modifyBinary(existing, bytes);
      return existing;
    }
    return this.app.vault.createBinary(path, bytes);
  }

  private async renderNotes(bundle: ItemBundle, sourcePath: string): Promise<RenderedNote[]> {
    const notes: RenderedNote[] = [];
    for (const n of bundle.notes) {
      const markdown = await this.noteToMarkdown((n.data.note as string) || "", sourcePath);
      notes.push({ key: n.key, version: n.version, markdown });
    }
    return notes;
  }

  /**
   * Converts a Zotero note to Markdown. Images are copied into the vault and
   * embedded; math is kept verbatim (htmlToMarkdown would escape it).
   * Highlights and citations become links holding what Zotero needs to
   * rebuild them (see `annotationLink`, `citationLink`).
   */
  private async noteToMarkdown(html: string, sourcePath: string): Promise<string> {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const tokens = new Map<string, string>();
    const token = (value: string): string => {
      const t = `ZTTOKEN${tokens.size}ZT`;
      tokens.set(t, value);
      return t;
    };

    for (const img of Array.from(doc.querySelectorAll("img"))) {
      let file: TFile | null = null;
      const attachmentKey = img.getAttribute("data-attachment-key");
      if (attachmentKey) {
        const path = await fetchAttachmentPath(attachmentKey);
        if (path) file = await this.importImage(path, `${attachmentKey}.${path.split(".").pop() || "png"}`);
      }
      const annotation = parseDataAttribute<NoteAnnotation>(img, "data-annotation");
      if (!file && annotation?.annotationKey) {
        file = await this.importImage(this.annotationCachePath(annotation.annotationKey), `${annotation.annotationKey}.png`);
      }
      // An image from an annotation keeps its link (see `annotationImage`)
      const target = annotation?.attachmentURI && zoteroUriPath(annotation.attachmentURI);
      const width = parseInt(img.getAttribute("width") || "", 10);
      let link = "";
      if (file && annotation && target) {
        link = annotationImage(file.path, annotationLink(target, annotation), width > 0 ? width : undefined);
      } else if (file) {
        link = `!${this.app.fileManager.generateMarkdownLink(file, sourcePath)}`;
      }
      img.replaceWith(doc.createTextNode(token(link)));
    }

    // Quotes from the PDF link back to their page, citations to the cited item
    for (const span of Array.from(doc.querySelectorAll("span.highlight, span.underline"))) {
      const annotation = parseDataAttribute<NoteAnnotation>(span, "data-annotation");
      const target = annotation?.attachmentURI && zoteroUriPath(annotation.attachmentURI);
      if (!target) continue;
      const a = doc.body.createEl("a");
      a.setAttribute("href", annotationLink(target, annotation));
      a.append(...Array.from(span.childNodes));
      span.replaceWith(a);
    }
    for (const span of Array.from(doc.querySelectorAll("span.citation"))) {
      const citation = parseDataAttribute<{ citationItems?: { uris?: string[]; locator?: string }[] }>(
        span,
        "data-citation"
      );
      const cited = citation?.citationItems?.[0];
      const target = cited?.uris?.[0] && zoteroUriPath(cited.uris[0]);
      if (!target) continue;
      const a = doc.body.createEl("a");
      a.setAttribute("href", citationLink(target, cited.locator));
      a.textContent = span.textContent;
      span.replaceWith(a);
    }

    for (const el of Array.from(doc.querySelectorAll(".math"))) {
      const raw = (el.textContent || "").trim();
      if (el.tagName === "PRE") {
        const expr = raw.replace(/^\$\$|\$\$$/g, "").trim();
        const p = doc.body.createEl("p");
        p.textContent = token(`$$\n${expr}\n$$`);
        el.replaceWith(p);
      } else {
        el.replaceWith(doc.createTextNode(token(raw)));
      }
    }

    let md = htmlToMarkdown(doc.body);
    for (const [t, value] of tokens) md = md.split(t).join(value);
    return md.trim();
  }

  // -------------------------------------------------------------------------
  // Plumbing
  // -------------------------------------------------------------------------

  private async ensureFolder(folder: string): Promise<void> {
    if (!folder || folder === "/") return;
    const path = normalizePath(folder);
    if (this.app.vault.getAbstractFileByPath(path)) return;
    try {
      await this.app.vault.createFolder(path);
    } catch {
      // created concurrently
    }
  }

  /** Serializes operations on one item */
  private locked<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) || Promise.resolve();
    const next = prev.then(fn, fn);
    const settled = next.catch(() => undefined);
    this.locks.set(key, settled);
    void settled.then(() => {
      if (this.locks.get(key) === settled) this.locks.delete(key);
    });
    return next;
  }

  private loadState(): Promise<void> {
    if (!this.stateLoaded) this.stateLoaded = this.readState();
    return this.stateLoaded;
  }

  private async readState(): Promise<void> {
    if (!this.statePath) return;
    try {
      const adapter = this.app.vault.adapter;
      if (!(await adapter.exists(this.statePath))) return;
      const raw = JSON.parse(await adapter.read(this.statePath)) as SyncState | null;
      if (raw && raw.version === STATE_VERSION && raw.items) this.state = raw;
    } catch (e) {
      console.error("Zotero Annotations: failed to load literature note state", e);
    }
  }

  private async saveState(): Promise<void> {
    if (!this.statePath) return;
    try {
      await this.app.vault.adapter.write(this.statePath, JSON.stringify(this.state));
    } catch (e) {
      console.error("Zotero Annotations: failed to save literature note state", e);
    }
  }
}
