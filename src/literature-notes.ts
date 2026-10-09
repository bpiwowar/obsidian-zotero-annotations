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
 * Each region (or the whole body) mirrors one Zotero child note, both ways:
 * a note changed in Zotero replaces its region while the region is still
 * what was last written (tracked by hash), a region edited in Obsidian is
 * sent to Zotero ({@link LiteratureNotes.push}) while the Zotero note is
 * still what was last seen (tracked by hash of its HTML: Zotero bumps
 * versions without changes). When both changed, the user chooses.
 * Annotations are not copied into notes: the sidebar shows them.
 */
import { App, Notice, TFile, arrayBufferToBase64, htmlToMarkdown, normalizePath } from "obsidian";
import { createHash } from "crypto";
import { readFile } from "fs/promises";
import {
  ZoteroApiItem,
  ZoteroConflictError,
  ZoteroWriter,
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
import { ImageRef, imageSources, markdownToHtml } from "./note-html";
import { choose } from "./confirm-modal";

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
  /** Zotero version of the note when last synced */
  version: number;
  /** Hash of the region text when last synced */
  hash: string;
  /** Hash of the note's HTML in Zotero when last synced (absent in older state) */
  html?: string;
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
  /** The note's HTML in Zotero */
  html: string;
}

/** Whether a Zotero note is still what was last synced */
function zoteroUnchanged(prev: RegionState, note: { version: number; html: string }): boolean {
  return prev.html !== undefined ? prev.html === hash(note.html) : prev.version === note.version;
}

/** Zotero note HTML: the body in the wrapper of the note it replaces (schema version, cited items) */
function wrapNoteHtml(body: string, previous: string | null): string {
  let attrs = ' data-schema-version="9"';
  const wrapper = previous
    ? new DOMParser().parseFromString(previous, "text/html").querySelector("body > div[data-schema-version]")
    : null;
  if (wrapper) {
    attrs = Array.from(wrapper.attributes)
      .map((a) => ` ${a.name}="${a.value.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"`)
      .join("");
  }
  return `<div${attrs}>${body}</div>`;
}

function noteHtml(note: ZoteroApiItem): string {
  return (note.data.note as string) || "";
}

/** Raised when a Zotero note changed since the region pushed over it was last synced */
class PushConflict extends Error {
  constructor(readonly note: ZoteroApiItem) {
    super("The note changed in Zotero");
  }
}

/** A region edited on both sides */
interface Conflict {
  key: string;
  body: string;
  note: ZoteroApiItem;
}

export class LiteratureNotes {
  private state: SyncState = { version: STATE_VERSION, serverId: "", libraryVersion: 0, items: {} };
  private stateLoaded: Promise<void> | null = null;
  private locks = new Map<string, Promise<unknown>>();
  private lastRefresh = new Map<string, number>();
  private syncing: Promise<void> | null = null;
  /** Conflicts already reported ("KEY@version"), so that background pushes report each once */
  private reported = new Set<string>();

  constructor(
    private app: App,
    private settings: () => LiteratureNoteSettings,
    /** Vault-relative path of the state file, or null to keep it in memory */
    private statePath: string | null,
    private writer: ZoteroWriter
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
    const untouched = new Set<string>();

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
        } else if (!overwrite && prev && (prev.html !== undefined || hash(region.body) !== prev.hash) && zoteroUnchanged(prev, note)) {
          // Zotero has nothing new: the text stands (edits go to Zotero by `push`)
          untouched.add(note.key);
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
    await this.track(itemKey, file, bundle, notes, new Set([...kept, ...untouched]));
    if (kept.length > 0) {
      new Notice(
        `${file.basename}: ${kept.length} note section(s) changed both in Obsidian and in Zotero were ` +
          'kept as they are: use "Send literature note edits to Zotero" to choose a version.'
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

  /**
   * Records what was written, so later updates can tell local edits apart.
   * Regions in `keptLocal` (not written) keep their previous state.
   */
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
        regions[note.key] = { version: note.version, hash: hash(note.markdown), html: hash(note.html) };
      }
    }
    const descendants = [...bundle.attachments.map((a) => a.key), ...bundle.notes.map((n) => n.key)];
    this.state.items[itemKey] = { path: file.path, descendants, regions, fileHash: hash(text) };
    this.lastRefresh.set(itemKey, Date.now());
    await this.saveState();
  }

  // -------------------------------------------------------------------------
  // Vault → Zotero
  // -------------------------------------------------------------------------

  /** Pushes every tracked literature note (see {@link push}) */
  async pushAll(): Promise<void> {
    await this.loadState();
    for (const tracked of Object.values(this.state.items)) {
      const file = this.app.vault.getAbstractFileByPath(tracked.path);
      if (file instanceof TFile) await this.push(file);
    }
  }

  /**
   * Sends the edits of a literature note to Zotero: regions edited in
   * Obsidian update their Zotero note, new regions (and the body of a paper
   * without Zotero notes) become Zotero notes. A region removed in Obsidian
   * is not deleted in Zotero. `interactive` (asked by the user) sends every
   * region, edited or not, and asks about regions changed on both sides;
   * otherwise those are reported once.
   */
  async push(file: TFile, interactive = false): Promise<void> {
    const itemKey = this.keyOf(file);
    if (!itemKey) return;
    await this.loadState();
    const { sent, conflicts } = await this.locked(itemKey, () => this.doPush(itemKey, file, interactive));
    if (interactive) {
      for (const conflict of conflicts) await this.resolveConflict(itemKey, file, conflict);
      if (conflicts.length === 0) {
        new Notice(sent > 0 ? `${file.basename}: ${sent} note(s) sent to Zotero.` : `${file.basename}: no Zotero note to send.`);
      }
      return;
    }
    const fresh = conflicts.filter((c) => !this.reported.has(`${c.key}@${c.note.version}`));
    for (const c of fresh) this.reported.add(`${c.key}@${c.note.version}`);
    if (fresh.length > 0) {
      new Notice(
        `${file.basename}: ${fresh.length} note section(s) changed both in Obsidian and in Zotero. ` +
          'Use "Send literature note edits to Zotero" to choose a version.'
      );
    }
  }

  private async doPush(itemKey: string, file: TFile, all: boolean): Promise<{ sent: number; conflicts: Conflict[] }> {
    const tracked = this.state.items[itemKey];
    if (!tracked || tracked.path !== file.path) return { sent: 0, conflicts: [] };
    const text = await this.app.vault.read(file);
    const layout = noteLayout(text);
    const edited = layout.regions.filter(
      (r) => !r.key || (tracked.regions[r.key] && (all || hash(r.body) !== tracked.regions[r.key].hash))
    );
    // The body of a paper that never had Zotero notes becomes one
    const body = text.slice(layout.contentStart).trim();
    const newBody = layout.regions.length === 0 && Object.keys(tracked.regions).length === 0 ? body : "";
    if (edited.length === 0 && !newBody) return { sent: 0, conflicts: [] };

    const bundle = await this.fetchBundle(itemKey);
    if (!bundle) return { sent: 0, conflicts: [] };
    const { serverId } = await fetchLibraryState();
    const notes = new Map(bundle.notes.map((n) => [n.key, n]));
    const conflicts: Conflict[] = [];
    const created: { key: string; body: string }[] = [];
    let sent = 0;

    for (const region of edited) {
      if (!region.key) {
        const { key, state } = await this.createNote(serverId, bundle, file, region.body);
        created.push({ key, body: region.body });
        tracked.regions[key] = state;
        continue;
      }
      const note = notes.get(region.key);
      // Deleted in Zotero: the text stays in Obsidian only
      if (!note) continue;
      const prev = tracked.regions[region.key];
      try {
        if (!zoteroUnchanged(prev, { version: note.version, html: noteHtml(note) })) throw new PushConflict(note);
        tracked.regions[region.key] = await this.updateNote(serverId, bundle, file, region.key, region.body, note, prev);
        sent++;
      } catch (e) {
        if (!(e instanceof PushConflict)) throw e;
        conflicts.push({ key: region.key, body: region.body, note: e.note });
      }
    }

    let single: string | null = null;
    if (newBody) {
      const { key, state } = await this.createNote(serverId, bundle, file, newBody);
      tracked.regions[key] = state;
      single = key;
    }
    // Name the new notes in the file
    if (created.length > 0) {
      await this.app.vault.process(file, (current) => {
        let out = current;
        for (const c of created) {
          const region = noteLayout(out).regions.find((r) => !r.key && hash(r.body) === hash(c.body));
          if (region) out = out.slice(0, region.start) + noteRegion(c.key, region.body) + out.slice(region.end);
        }
        return out;
      });
    }
    if (single) {
      const key = single;
      await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
        fm[SINGLE_NOTE_PROPERTY] = key;
      });
    }
    const newKeys = [...created.map((c) => c.key), ...(single ? [single] : [])];
    tracked.descendants.push(...newKeys);
    await this.saveState();
    return { sent: sent + newKeys.length, conflicts };
  }

  /** Replaces a Zotero note by a region of the file; its new sync state */
  private async updateNote(
    serverId: string,
    bundle: ItemBundle,
    file: TFile,
    key: string,
    body: string,
    note: ZoteroApiItem,
    prev: RegionState
  ): Promise<RegionState> {
    let current = note;
    for (let attempt = 0; ; attempt++) {
      const html = wrapNoteHtml(await this.regionHtml(body, file.path, bundle, noteHtml(current)), noteHtml(current));
      try {
        await this.writer.patchItem(serverId, key, current.version, { note: html });
        break;
      } catch (e) {
        if (!(e instanceof ZoteroConflictError) || attempt > 0) throw e;
        // Zotero bumps versions on its own: only a change of content is a conflict
        current = await fetchItem(key);
        if (!zoteroUnchanged(prev, { version: current.version, html: noteHtml(current) })) throw new PushConflict(current);
      }
    }
    const fresh = await fetchItem(key);
    return { version: fresh.version, hash: hash(body), html: hash(noteHtml(fresh)) };
  }

  /** Creates a Zotero note of the paper from a region of the file */
  private async createNote(
    serverId: string,
    bundle: ItemBundle,
    file: TFile,
    body: string
  ): Promise<{ key: string; state: RegionState }> {
    const html = wrapNoteHtml(await this.regionHtml(body, file.path, bundle, null), null);
    const [key] = await this.writer.createItems(serverId, [{ itemType: "note", parentItem: bundle.item.key, note: html }]);
    const fresh = await fetchItem(key);
    return { key, state: { version: fresh.version, hash: hash(body), html: hash(noteHtml(fresh)) } };
  }

  /** Zotero note HTML of a region (inside the wrapper); `previous` is the HTML it replaces */
  private async regionHtml(body: string, sourcePath: string, bundle: ItemBundle, previous: string | null): Promise<string> {
    const library = bundle.item.library;
    const uri = (target: string): string => {
      if (target.startsWith("groups/")) return `http://zotero.org/${target}`;
      if (library?.type !== "user") throw new Error("Unknown Zotero user library");
      return `http://zotero.org/users/${library.id}/${target.replace(/^library\//, "")}`;
    };
    // Images of the note in Zotero keep their attachment (Zotero deletes unreferenced ones)
    const attachments = new Set<string>();
    if (previous) {
      const doc = new DOMParser().parseFromString(previous, "text/html");
      for (const img of Array.from(doc.querySelectorAll("img[data-attachment-key]"))) {
        attachments.add(img.getAttribute("data-attachment-key") as string);
      }
    }
    const images = new Map<string, ImageRef>();
    for (const src of imageSources(body)) {
      const file =
        this.app.metadataCache.getFirstLinkpathDest(src, sourcePath) ??
        this.app.vault.getAbstractFileByPath(normalizePath(src));
      if (!(file instanceof TFile)) continue;
      if (attachments.has(file.basename)) {
        images.set(src, { attachmentKey: file.basename });
        continue;
      }
      // Other images go as data: Zotero imports PNG and JPEG images when the note is opened
      const type = ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg" } as Record<string, string>)[
        file.extension.toLowerCase()
      ];
      if (!type) continue;
      const data = await this.app.vault.readBinary(file);
      images.set(src, { dataUrl: `data:${type};base64,${arrayBufferToBase64(data)}` });
    }
    return markdownToHtml(body, { uri, images, paper: uri(`library/items/${bundle.item.key}`) });
  }

  /** Asks which side wins for a region changed in Obsidian and in Zotero */
  private async resolveConflict(itemKey: string, file: TFile, conflict: Conflict): Promise<void> {
    const preview = conflict.body.replace(/\s+/g, " ").slice(0, 120);
    const choice = await choose(
      this.app,
      "Note changed in Obsidian and in Zotero",
      `A note of "${file.basename}" was edited in Obsidian and changed in Zotero since they were last in sync:\n\n` +
        `“${preview}${conflict.body.length > 120 ? "…" : ""}”`,
      ["Keep Obsidian version", "Keep Zotero version", "Decide later"]
    );
    if (choice !== 0 && choice !== 1) return;
    await this.locked(itemKey, async () => {
      const tracked = this.state.items[itemKey];
      const note = await fetchItem(conflict.key);
      const region = noteLayout(await this.app.vault.read(file)).regions.find((r) => r.key === conflict.key);
      if (!tracked || !region) return;
      if (choice === 0) {
        const bundle = await this.fetchBundle(itemKey);
        if (!bundle) return;
        const { serverId } = await fetchLibraryState();
        const seen: RegionState = { version: note.version, hash: "", html: hash(noteHtml(note)) };
        tracked.regions[conflict.key] = await this.updateNote(serverId, bundle, file, conflict.key, region.body, note, seen);
      } else {
        const markdown = await this.noteToMarkdown(noteHtml(note), file.path);
        await this.app.vault.process(file, (text) => {
          const r = noteLayout(text).regions.find((x) => x.key === conflict.key);
          if (!r) return text;
          const layout = noteLayout(text);
          const replacement = layout.bare ? `${markdown.trim()}\n` : noteRegion(r.key, markdown);
          return text.slice(0, r.start) + replacement + text.slice(r.end);
        });
        tracked.regions[conflict.key] = { version: note.version, hash: hash(markdown), html: hash(noteHtml(note)) };
      }
      this.reported.delete(`${conflict.key}@${conflict.note.version}`);
      await this.saveState();
    });
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
    return this.importImageData(data, name);
  }

  private async importImageData(data: Buffer, name: string): Promise<TFile> {
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
      const html = (n.data.note as string) || "";
      const markdown = await this.noteToMarkdown(html, sourcePath);
      notes.push({ key: n.key, version: n.version, markdown, html });
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
      // An image sent from Obsidian that Zotero has not imported yet (it does when the note is opened)
      const src = img.getAttribute("src") || "";
      const inline = /^data:image\/(png|jpeg);base64,(.+)$/.exec(src);
      if (!file && inline) {
        const data = Buffer.from(inline[2], "base64");
        const name = `${createHash("sha1").update(data).digest("hex").slice(0, 12)}.${inline[1] === "jpeg" ? "jpg" : "png"}`;
        file = await this.importImageData(data, name);
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
      a.setAttribute("href", annotationLink(target, annotation, span.classList.contains("underline") ? "underline" : "highlight"));
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
