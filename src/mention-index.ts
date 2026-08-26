import { App, TFile } from "obsidian";

/** One occurrence of a `zotero://` link inside a vault note. */
export interface Mention {
  /** Vault-relative path of the note */
  path: string;
  /** 0-based line number of the occurrence */
  line: number;
  /** Trimmed text of the line, for context */
  text: string;
}

/**
 * Matches any zotero:// URI pointing at an item, in the personal library or a
 * group library. `open-pdf` links carry an attachment key rather than the item
 * key, but indexing them costs nothing — a lookup simply never hits them.
 */
const ZOTERO_URI_SOURCE =
  "zotero:\\/\\/(?:select|open-pdf)\\/(?:library|groups\\/\\d+)\\/items\\/([A-Z0-9]{8})";

/** Longest line snippet kept for context */
const MAX_SNIPPET = 300;

/** Bumped when the cache format changes, to invalidate files written by older versions */
const CACHE_VERSION = 1;

/** How long to wait after a note is modified before re-scanning it */
const RESCAN_DEBOUNCE_MS = 500;

/** How long to wait after an index change before writing the cache to disk */
const SAVE_DEBOUNCE_MS = 2000;

/** A zotero:// link found on one line of one note */
interface Hit {
  key: string;
  line: number;
  text: string;
}

interface FileEntry {
  /** mtime of the note when it was scanned, used to validate the disk cache */
  mtime: number;
  hits: Hit[];
}

interface CacheFile {
  version: number;
  files: Record<string, FileEntry>;
}

/**
 * Index of Zotero item keys → places in the vault that link to them.
 *
 * Scanning every note is the expensive part, so it happens at most once per
 * session (lazily, on the first lookup) and the result is kept in memory.
 * Vault edits re-scan only the affected note, and the index is mirrored to a
 * JSON file next to the plugin so a restart only re-reads notes whose mtime
 * changed.
 */
export class MentionIndex {
  private entries = new Map<string, FileEntry>();
  private byKey = new Map<string, Mention[]>();
  private buildPromise: Promise<void> | null = null;
  private listeners = new Set<() => void>();
  private rescanTimers = new Map<string, number>();
  private saveTimer: number | null = null;

  constructor(
    private app: App,
    /** Vault-relative path of the JSON cache, or null to disable persistence */
    private cachePath: string | null
  ) {}

  /** Subscribes to index changes; returns an unsubscribe function. */
  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /** All places in the vault linking to `itemKey`, sorted by path then line. */
  async getMentions(itemKey: string): Promise<Mention[]> {
    await this.ensureBuilt();
    return this.byKey.get(itemKey.toUpperCase()) || [];
  }

  /** Drops the index (memory and disk) and re-scans the whole vault. */
  async rebuild(): Promise<void> {
    this.entries.clear();
    this.buildPromise = this.scanVault(false);
    await this.buildPromise;
  }

  onFileChanged(file: TFile): void {
    // Nothing to keep in sync yet: the lazy build will read the current state.
    // This also makes the burst of `create` events Obsidian fires at startup free.
    if (!this.buildPromise) return;
    if (file.extension !== "md") return;
    const existing = this.rescanTimers.get(file.path);
    if (existing) activeWindow.clearTimeout(existing);
    const timer = activeWindow.setTimeout(() => {
      this.rescanTimers.delete(file.path);
      void this.scanFile(file).then(() => this.commit());
    }, RESCAN_DEBOUNCE_MS);
    this.rescanTimers.set(file.path, timer);
  }

  onFileDeleted(path: string): void {
    if (!this.buildPromise) return;
    if (this.entries.delete(path)) this.commit();
  }

  onFileRenamed(file: TFile, oldPath: string): void {
    if (!this.buildPromise) return;
    this.entries.delete(oldPath);
    if (file.extension !== "md") {
      this.commit();
      return;
    }
    void this.scanFile(file).then(() => this.commit());
  }

  unload(): void {
    for (const timer of this.rescanTimers.values()) activeWindow.clearTimeout(timer);
    this.rescanTimers.clear();
    if (this.saveTimer !== null) {
      activeWindow.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.listeners.clear();
  }

  private ensureBuilt(): Promise<void> {
    if (!this.buildPromise) this.buildPromise = this.scanVault(true);
    return this.buildPromise;
  }

  private async scanVault(useCache: boolean): Promise<void> {
    if (useCache) await this.loadCache();

    const present = new Set<string>();
    for (const file of this.app.vault.getMarkdownFiles()) {
      present.add(file.path);
      const cached = this.entries.get(file.path);
      if (cached && cached.mtime === file.stat.mtime) continue;
      await this.scanFile(file);
    }
    // Notes deleted while the plugin (or Obsidian) was not running
    for (const path of Array.from(this.entries.keys())) {
      if (!present.has(path)) this.entries.delete(path);
    }
    this.commit();
  }

  private async scanFile(file: TFile): Promise<void> {
    let hits: Hit[] = [];
    try {
      const content = await this.app.vault.cachedRead(file);
      // Cheap bail-out: the vast majority of notes contain no Zotero link
      if (content.includes("zotero://")) {
        hits = collectHits(content);
      }
    } catch (e) {
      console.error(`Zotero Annotations: failed to read ${file.path}`, e);
      hits = [];
    }
    this.entries.set(file.path, { mtime: file.stat.mtime, hits });
  }

  /** Rebuilds the key → mentions map, notifies listeners, and saves the cache. */
  private commit(): void {
    this.byKey.clear();
    for (const [path, entry] of this.entries) {
      for (const hit of entry.hits) {
        let list = this.byKey.get(hit.key);
        if (!list) {
          list = [];
          this.byKey.set(hit.key, list);
        }
        list.push({ path, line: hit.line, text: hit.text });
      }
    }
    for (const list of this.byKey.values()) {
      list.sort((a, b) => (a.path === b.path ? a.line - b.line : a.path.localeCompare(b.path)));
    }
    this.scheduleSave();
    for (const cb of this.listeners) cb();
  }

  private scheduleSave(): void {
    if (!this.cachePath) return;
    if (this.saveTimer !== null) activeWindow.clearTimeout(this.saveTimer);
    this.saveTimer = activeWindow.setTimeout(() => {
      this.saveTimer = null;
      void this.saveCache();
    }, SAVE_DEBOUNCE_MS);
  }

  private async loadCache(): Promise<void> {
    if (!this.cachePath) return;
    try {
      const adapter = this.app.vault.adapter;
      if (!(await adapter.exists(this.cachePath))) return;
      const raw = JSON.parse(await adapter.read(this.cachePath)) as CacheFile | null;
      if (!raw || raw.version !== CACHE_VERSION || !raw.files) return;
      for (const [path, entry] of Object.entries(raw.files)) {
        if (entry && typeof entry.mtime === "number" && Array.isArray(entry.hits)) {
          this.entries.set(path, entry);
        }
      }
    } catch (e) {
      console.error("Zotero Annotations: failed to load mention cache", e);
    }
  }

  private async saveCache(): Promise<void> {
    if (!this.cachePath) return;
    try {
      const files: Record<string, FileEntry> = {};
      for (const [path, entry] of this.entries) {
        // Notes without any Zotero link still need an entry: their mtime is
        // what lets a restart skip re-reading them.
        files[path] = entry;
      }
      const payload: CacheFile = { version: CACHE_VERSION, files };
      await this.app.vault.adapter.write(this.cachePath, JSON.stringify(payload));
    } catch (e) {
      console.error("Zotero Annotations: failed to save mention cache", e);
    }
  }
}

/** Finds every zotero:// item link in a note, at most one hit per (key, line). */
function collectHits(content: string): Hit[] {
  const hits: Hit[] = [];
  const re = new RegExp(ZOTERO_URI_SOURCE, "gi");
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    const keys = new Set<string>();
    while ((match = re.exec(line)) !== null) keys.add(match[1].toUpperCase());
    if (keys.size === 0) continue;
    const text = line.trim().slice(0, MAX_SNIPPET);
    for (const key of keys) hits.push({ key, line: i, text });
  }
  return hits;
}
