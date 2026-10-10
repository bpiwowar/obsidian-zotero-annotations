import { addIcon, Platform, Plugin, PluginSettingTab, SettingDefinitionItem, App, Notice, TAbstractFile, TFile, debounce, setIcon } from "obsidian";
import { AnnotationView, VIEW_TYPE_ZOTERO_ANNOTATIONS, ZOTERO_ICON, ZOTERO_ICON_SVG } from "./annotation-view";
import { ZoteroLink, createCursorDetectorPlugin, extractZoteroKey } from "./cursor-detector";
import {
  ZoteroWriter,
  fetchAnnotations,
  fetchItemInfo,
  isNotFound,
  fetchItemSummary,
  fetchLibraryState,
  isZoteroRunning,
  searchItemSummaries,
  type ZoteroItemSummary,
} from "./zotero-client";
import { Mention, MentionIndex } from "./mention-index";
import { PaperHit, PaperInfo, buildPaperOutline } from "./paper-outline";
import { LiteratureNotes } from "./literature-notes";
import { ANNOTATION_DRAG_TYPE, AnnotationDrag, annotationMarkdown } from "./note-format";
import { EditorView } from "@codemirror/view";
import { confirm } from "./confirm-modal";
import { CACHE_LANGUAGE, parseCache, readOnlyCache } from "./annotation-cache";
import { os } from "./node";
import { DeadItem, deadItem, deadItems, findReplacement, linkTexts, searchQueries, withMetadata } from "./item-recovery";
import { RelinkResult, RelinkedItem, RepairEntry, RepairModal, RepairReport } from "./repair-modal";

/** When literature notes get created */
type CreateMode = "manual" | "cursor" | "linked";

interface ZoteroAnnotationsSettings {
  zoteroDataDir: string;
  /** Keep a literature note per paper in the vault, synced with Zotero */
  literatureNotes: boolean;
  createMode: CreateMode;
  notesFolder: string;
  imageFolder: string;
  /** Minutes between checks for changes in Zotero (0 = only on focus / when a paper is shown) */
  syncInterval: number;
  /** Send edits of literature notes to Zotero without being asked */
  pushEdits: boolean;
  /** Key given by Zotero to write to the library ("Always allow"), empty until then */
  zoteroApiKey: string;
  /** Show the paper of the open literature note in the sidebar */
  followNote: boolean;
  /** Most words of the title kept in note names */
  titleMaxWords: number;
  /** Note names keep the title up to the first of these characters */
  titleCutAt: string;
}

const DEFAULT_SETTINGS: ZoteroAnnotationsSettings = {
  zoteroDataDir: Platform.isDesktop ? `${os().homedir()}/Zotero` : "",
  literatureNotes: false,
  createMode: "manual",
  notesFolder: "Zotero",
  imageFolder: "Zotero/images",
  syncInterval: 5,
  pushEdits: true,
  zoteroApiKey: "",
  followNote: true,
  titleMaxWords: 6,
  titleCutAt: ":",
};


const DOUBLE_CLICK_MS = 300;

/** Local storage key: whether the link repair report searches every item when it opens */
const REPAIR_AUTO_SEARCH = "zotero-annotations-repair-auto-search";

/** Searches of the link repair report are reused this long */
const REPAIR_SEARCH_MS = 5 * 60_000;

/** `zotero://select` links of a note (group 2: the item key, possibly malformed — not 8 characters) */
const SELECT_LINK_RE = /zotero:\/\/select\/(library|groups\/\d+)\/items\/([A-Z0-9]+)/gi;

/** Showing a paper asks Zotero whether anything changed at most this often */
const PAPER_CHECK_MS = 10_000;

/** Edits of a literature note are sent to Zotero once the note was left alone this long */
const PUSH_IDLE_MS = 30_000;

export default class ZoteroAnnotationsPlugin extends Plugin {
  settings: ZoteroAnnotationsSettings = DEFAULT_SETTINGS;
  private debounceTimer: number | null = null;
  private originalWindowOpen: typeof window.open | null = null;
  private pendingClickTimers = new Map<string, number>();
  private openInZotero: (url: string) => void = (url) => window.open(url);
  /** Item → what the sidebar shows, with the library version it was read at */
  private cache = new Map<
    string,
    {
      info: Awaited<ReturnType<typeof fetchItemInfo>>;
      annotations: Awaited<ReturnType<typeof fetchAnnotations>>;
      version: number;
    }
  >();
  /** Last library version seen, and when it was asked */
  private libraryVersion: { value: number; at: number; pending: Promise<number> | null } = {
    value: 0,
    at: 0,
    pending: null,
  };
  /** key → item summary, for the paper list (null = not a paper, or not found) */
  private summaries = new Map<string, PaperInfo | null>();
  /** Paper of each PDF attachment met in an open-pdf link */
  private attachmentPapers = new Map<string, string>();
  /** The link under the cursor, so that a late attachment lookup does not override a newer one */
  private cursorLink: ZoteroLink | null = null;
  private mentions!: MentionIndex;
  literature!: LiteratureNotes;
  private syncTimer: number | null = null;
  /** The last link repair report, to reopen it (after jumping to a note from it) */
  private repairReport: RepairReport | null = null;
  /** Library searches of the repair report, by query */
  private repairSearches = new Map<string, { at: number; items: Promise<ZoteroItemSummary[]> }>();
  /** Pending sends of edited literature notes, by path */
  private pushTimers = new Map<string, number>();

  async onload(): Promise<void> {
    await this.loadSettings();
    addIcon(ZOTERO_ICON, ZOTERO_ICON_SVG);

    this.literature = new LiteratureNotes(
      this.app,
      () => ({
        ...this.settings,
        titleOptions: { maxWords: this.settings.titleMaxWords, cutAt: this.settings.titleCutAt },
      }),
      this.manifest.dir ? `${this.manifest.dir}/literature-notes.json` : null,
      new ZoteroWriter(
        "Obsidian Zotero Annotations",
        () => this.settings.zoteroApiKey || null,
        async (key) => {
          this.settings.zoteroApiKey = key ?? "";
          await this.saveSettings();
        }
      ),
      this.manifest.version
    );

    // Index of vault notes linking to Zotero items. The vault scan is lazy
    // (first lookup) and cached on disk, so it costs little on startup.
    this.mentions = new MentionIndex(
      this.app,
      this.manifest.dir ? `${this.manifest.dir}/mention-index.json` : null
    );

    this.registerMentionIndexEvents();

    // Without a Zotero to talk to (mobile), the sidebar shows the copy kept in
    // literature notes, and nothing is synced
    this.addSettingTab(new ZoteroAnnotationsSettingTab(this.app, this));
    this.interceptLinksToSidebar();

    // Register the sidebar view
    this.registerView(VIEW_TYPE_ZOTERO_ANNOTATIONS, (leaf) => {
      const view = new AnnotationView(leaf);
      view.zoteroDataDir = this.settings.zoteroDataDir;
      // Zotero's rendering when on this computer, else the copy in the vault
      const zoteroImage = view.imageSource;
      view.imageSource = async (key) => {
        const src = Platform.isDesktop ? await zoteroImage(key) : null;
        if (src) return src;
        const copy = this.app.vault.getAbstractFileByPath(this.literature.annotationImagePath(key));
        return copy instanceof TFile ? this.app.vault.getResourcePath(copy) : null;
      };
      view.openExternal = (url) => this.openInZotero(url);
      view.onNavigate = (itemKey) => void this.loadAnnotations(itemKey, true);
      // The paper's own literature note links to it everywhere: not a mention
      view.mentionProvider = async (itemKey) => {
        const own = this.literature.findNote(itemKey)?.path;
        return (await this.mentions.getMentions(itemKey)).filter((m) => m.path !== own);
      };
      view.openMention = (mention) => void this.openMention(mention);
      view.onListPapers = () => void this.showPapersInActiveNote();
      view.literatureNotesEnabled = () => this.settings.literatureNotes;
      view.isEditingLiteratureNote = (itemKey) => this.activeNoteKey() === itemKey;
      view.openLiteratureNote = (itemKey) => void this.openLiteratureNote(itemKey);
      view.onRefresh = (itemKey, overwrite) => void this.refreshItem(itemKey, overwrite);
      view.onRecover = Platform.isDesktop ? (itemKey) => void this.recoverItem(itemKey) : null;
      return view;
    });

    // The annotation cache at the end of literature notes: one line, read-only
    this.registerMarkdownCodeBlockProcessor(CACHE_LANGUAGE, (source, el) => {
      const cache = parseCache(source);
      const line = el.createDiv({ cls: "zotero-annot-cache-summary" });
      setIcon(line.createSpan(), "archive");
      const count = cache?.annotations.length ?? 0;
      line.appendText(
        cache
          ? `${count} Zotero annotation${count === 1 ? "" : "s"}, copy of ${new Date(cache.cached).toLocaleDateString()}`
          : "Copy of Zotero annotations (unreadable)"
      );
      line.setAttribute("title", "Kept to show the annotations sidebar when Zotero cannot be reached");
    });
    this.registerEditorExtension(readOnlyCache);

    // Register the CM6 extension for cursor detection and dblclick handling
    this.registerEditorExtension(
      createCursorDetectorPlugin({
        onChange: (link) => this.onLinkChanged(link),
        onDoubleClick: (link) => this.handleDoubleClick(link),
      })
    );

    this.addCommand({
      id: "toggle-annotations-sidebar",
      name: "Toggle annotations sidebar",
      callback: () => void this.toggleSidebar(),
    });

    this.addCommand({
      id: "toggle-freeze",
      name: "Pin/unpin annotations sidebar",
      callback: () => {
        const view = this.getView();
        if (view) view.toggleFreeze();
      },
    });

    this.addCommand({
      id: "list-papers-in-note",
      name: "List Zotero papers in current note",
      callback: () => void this.showPapersInActiveNote(),
    });

    if (Platform.isDesktop) {
      this.addCommand({
        id: "repair-links-in-note",
        name: "Repair links to deleted or merged Zotero items in current note",
        checkCallback: (checking) => {
          const file = this.app.workspace.getActiveFile();
          if (!file || file.extension !== "md") return false;
          if (!checking) void this.repairLinksInNote(file);
          return true;
        },
      });

      this.addCommand({
        id: "show-repair-report",
        name: "Show the last report of Zotero link repairs",
        checkCallback: (checking) => {
          if (!this.repairReport) return false;
          if (!checking) this.showRepairReport();
          return true;
        },
      });

      this.addCommand({
        id: "repair-links-in-vault",
        name: "Repair links to deleted or merged Zotero items in all notes",
        callback: () => void this.repairLinksInVault(),
      });
    }

    this.addCommand({
      id: "rescan-mentions",
      name: "Rescan vault for Zotero mentions",
      callback: () => {
        void this.mentions.rebuild();
      },
    });

    // Literature notes are written from Zotero
    if (Platform.isDesktop) {
      this.addCommand({
        id: "open-literature-note",
        name: "Open literature note of the paper in the sidebar",
        checkCallback: (checking) => {
          const key = this.getView()?.getCurrentItemKey();
          if (!this.settings.literatureNotes || !key) return false;
          if (!checking) void this.openLiteratureNote(key);
          return true;
        },
      });

      this.addCommand({
        id: "refresh-literature-note",
        name: "Refresh literature note from Zotero",
        checkCallback: (checking) => {
          const file = this.app.workspace.getActiveFile();
          if (!this.settings.literatureNotes || !file || !this.literature.keyOf(file)) return false;
          if (!checking) {
            void this.refreshLiteratureNote(file);
          }
          return true;
        },
      });

      this.addCommand({
        id: "push-literature-note",
        name: "Send literature note edits to Zotero",
        checkCallback: (checking) => {
          const file = this.app.workspace.getActiveFile();
          if (!this.settings.literatureNotes || !file || !this.literature.keyOf(file)) return false;
          if (!checking) void this.pushLiteratureNote(file, true);
          return true;
        },
      });

      this.addCommand({
        id: "sync-literature-notes",
        name: "Sync changed literature notes with Zotero",
        checkCallback: (checking) => {
          if (!this.settings.literatureNotes) return false;
          if (!checking) {
            void this.literature.sync().catch((e: Error) => new Notice(`Could not sync with Zotero: ${e.message}`));
          }
          return true;
        },
      });

      this.addCommand({
        id: "refresh-all-literature-notes",
        name: "Refresh all literature notes from Zotero",
        checkCallback: (checking) => {
          if (!this.settings.literatureNotes) return false;
          if (!checking) void this.refreshAllLiteratureNotes();
          return true;
        },
      });

      this.addCommand({
        id: "push-all-literature-notes",
        name: "Send all literature note edits to Zotero",
        checkCallback: (checking) => {
          if (!this.settings.literatureNotes) return false;
          if (!checking) void this.pushAllLiteratureNotes();
          return true;
        },
      });

      this.addCommand({
        id: "sync-all-literature-notes",
        name: "Sync all literature notes with Zotero (send edits, then refresh)",
        checkCallback: (checking) => {
          if (!this.settings.literatureNotes) return false;
          if (!checking) {
            void (async () => {
              if (await this.pushAllLiteratureNotes()) await this.refreshAllLiteratureNotes();
            })();
          }
          return true;
        },
      });
    }

    this.addCommand({
      id: "refresh-annotations",
      name: "Refresh current annotations",
      callback: () => {
        const view = this.getView();
        if (view) {
          const key = view.getCurrentItemKey();
          if (key) {
            this.cache.delete(key);
            this.summaries.delete(key);
            void this.loadAnnotations(key);
          }
        }
      },
    });

    // Runs right away when the layout is already ready (e.g. on plugin reload),
    // so it must come after everything it uses has been set up
    this.app.workspace.onLayoutReady(() => {
      this.removeDuplicateViews();
      this.registerEvent(this.app.workspace.on("layout-change", () => this.removeDuplicateViews()));
      this.registerFollowNoteEvents();
      if (Platform.isDesktop) {
        this.registerLiteratureNoteEvents();
        this.registerAnnotationDrop();
        this.restartSync();
      }
    });
  }

  onunload(): void {
    if (this.debounceTimer) {
      window.clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    for (const timer of this.pendingClickTimers.values()) {
      window.clearTimeout(timer);
    }
    this.pendingClickTimers.clear();
    if (this.originalWindowOpen) {
      window.open = this.originalWindowOpen;
      this.originalWindowOpen = null;
    }
    this.mentions.unload();
    if (this.syncTimer !== null) window.clearInterval(this.syncTimer);
  }

  /**
   * A click on a zotero://select link shows the paper in the sidebar (after a
   * short delay to detect double-clicks); a double click opens it in Zotero.
   * On mobile, the sidebar shows the copy kept in the literature note.
   */
  private interceptLinksToSidebar(): void {
    // Save original window.open and patch it to intercept zotero://select/ links.
    // A single click opens the sidebar (after a short delay to detect double-clicks);
    // a double click cancels the pending sidebar update and opens the item in Zotero.
    const origOpen = window.open;
    this.originalWindowOpen = origOpen;
    let bypassIntercept = false;
    const openInZotero = (url: string): void => {
      bypassIntercept = true;
      try { origOpen.call(window, url); } finally { bypassIntercept = false; }
    };
    this.openInZotero = openInZotero;
    window.open = (...args: Parameters<typeof window.open>) => {
      const url = typeof args[0] === "string" ? args[0] : args[0]?.toString() || "";
      const key = extractZoteroKey(url);
      // In a literature note, its own paper is already in the sidebar: open it in Zotero
      if (key && url.includes("zotero://select/") && !bypassIntercept && key === this.activeNoteKey()) {
        return origOpen.apply(window, args);
      }
      if (key && url.includes("zotero://select/") && !bypassIntercept) {
        const existing = this.pendingClickTimers.get(key);
        if (existing) window.clearTimeout(existing);
        const timer = window.setTimeout(() => {
          this.pendingClickTimers.delete(key);
          void (async () => {
            await this.ensureSidebarOpen(true);
            await this.loadAnnotations(key);
          })();
        }, DOUBLE_CLICK_MS);
        this.pendingClickTimers.set(key, timer);
        return null;
      }
      return origOpen.apply(window, args);
    };

    // A dblclick on a zotero://select/ link cancels the pending sidebar update
    // and opens the item in Zotero instead.
    this.registerDomEvent(document, "dblclick", (evt: MouseEvent) => {
      const link = (evt.target as HTMLElement | null)?.closest("a") as HTMLAnchorElement | null;
      if (!link) return;
      const href = link.getAttribute("href") || link.href;
      if (!href.includes("zotero://select/")) return;
      const key = extractZoteroKey(href);
      if (!key) return;
      const pending = this.pendingClickTimers.get(key);
      if (pending) {
        window.clearTimeout(pending);
        this.pendingClickTimers.delete(key);
      }
      evt.preventDefault();
      evt.stopPropagation();
      openInZotero(href);
    });
  }

  /** (Re)starts the periodic check for changes in Zotero */
  restartSync(): void {
    if (this.syncTimer !== null) {
      window.clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
    void this.checkZotero();
    if (this.settings.syncInterval > 0) {
      this.syncTimer = window.setInterval(() => void this.checkZotero(), this.settings.syncInterval * 60_000);
    }
  }

  /**
   * Background check for changes in Zotero: updates the literature notes and
   * the paper on screen. Zotero not running is not an error worth a notice.
   */
  private async checkZotero(): Promise<void> {
    try {
      await this.currentLibraryVersion(0);
      const key = this.getView()?.getCurrentItemKey();
      if (key) await this.revalidate(key);
      if (this.settings.literatureNotes) {
        // Edits go out first, so that the sync that follows finds them in Zotero
        if (this.settings.pushEdits) await this.literature.pushAll();
        await this.literature.sync();
      }
    } catch (e) {
      console.warn("Zotero Annotations: sync failed", e);
    }
  }

  /** Zotero's library version, asked again when older than `maxAge` ms */
  private currentLibraryVersion(maxAge = PAPER_CHECK_MS): Promise<number> {
    const lv = this.libraryVersion;
    if (lv.pending) return lv.pending;
    if (Date.now() - lv.at < maxAge) return Promise.resolve(lv.value);
    lv.pending = fetchLibraryState()
      .then((state) => {
        lv.value = state.version;
        lv.at = Date.now();
        return lv.value;
      })
      .finally(() => {
        lv.pending = null;
      });
    return lv.pending;
  }

  /**
   * Reloads a paper the sidebar shows when Zotero changed since it was read,
   * and syncs the literature notes along.
   */
  private async revalidate(itemKey: string): Promise<void> {
    const cached = this.cache.get(itemKey);
    if (!cached) return;
    const version = await this.currentLibraryVersion();
    if (version === cached.version) return;
    const [info, annotations] = await Promise.all([fetchItemInfo(itemKey), fetchAnnotations(itemKey)]);
    this.cache.set(itemKey, { info, annotations, version });
    const view = this.getView();
    if (view?.isShowingItem(itemKey)) view.setAnnotations(itemKey, info, annotations, true);
    if (this.settings.literatureNotes) await this.literature.sync();
  }

  /** Sidebar Refresh: re-fetches the annotations, and the literature note if there is one */
  private async refreshItem(itemKey: string, overwrite = false): Promise<void> {
    const file = this.settings.literatureNotes ? this.literature.findNote(itemKey) : null;
    if (file) {
      if (overwrite) {
        const confirmed = await confirm(
          this.app,
          "Overwrite from Zotero?",
          `The Zotero note sections of "${file.basename}" will be replaced by their Zotero version: ` +
            "edits made in Obsidian are lost, sections removed in Obsidian come back, and sections " +
            "of notes deleted in Zotero are removed. Text outside these sections is kept.",
          "Overwrite"
        );
        if (!confirmed) return;
      }
      await this.refreshLiteratureNote(file, overwrite);
      return;
    }
    this.cache.delete(itemKey);
    this.summaries.delete(itemKey);
    await this.loadAnnotations(itemKey, true);
  }

  private async openLiteratureNote(itemKey: string): Promise<void> {
    try {
      await this.literature.open(itemKey);
    } catch (e) {
      new Notice(`Could not create the literature note: ${(e as Error).message}`);
    }
  }

  /**
   * Automatic creation (cursor / linked modes): creates the literature note of
   * a paper if missing, without opening it — only when the paper has Zotero
   * notes, since a note with nothing in it is only made on demand.
   */
  private async ensureLiteratureNote(key: string): Promise<void> {
    try {
      const summary = await this.resolveSummary(key);
      if (summary) await this.literature.ensure(summary.key, { onlyWithNotes: true });
    } catch (e) {
      console.warn(`Zotero Annotations: could not create literature note for ${key}`, e);
    }
  }

  /** The paper of the active literature note, if any */
  private activeNoteKey(): string | null {
    const file = this.app.workspace.getActiveFile();
    return file ? this.literature.keyOf(file) : null;
  }

  /** The paper of the active note, when the sidebar should follow it */
  private followedNoteKey(): string | null {
    if (!this.settings.followNote) return null;
    const file = this.app.workspace.getActiveFile();
    return file ? this.literature.keyOf(file) : null;
  }

  /** Shows the paper of the active literature note in the sidebar */
  private showActiveNotePaper(): void {
    const key = this.followedNoteKey();
    if (!key || this.getView()?.getCurrentItemKey() === key) return;
    void (async () => {
      await this.ensureSidebarOpen();
      await this.loadAnnotations(key);
    })();
  }

  /** Re-reads a literature note from Zotero, and the sidebar's annotations of its paper */
  async refreshLiteratureNote(file: TFile, overwrite = false): Promise<void> {
    const key = this.literature.keyOf(file);
    if (!key) return;
    try {
      await this.literature.update(file, overwrite);
      new Notice(`Refreshed "${file.basename}" from Zotero`);
    } catch (e) {
      new Notice(`Could not refresh from Zotero: ${(e as Error).message}`);
    }
    this.cache.delete(key);
    if (this.getView()?.getCurrentItemKey() === key) void this.loadAnnotations(key, true);
  }

  private registerFollowNoteEvents(): void {
    this.registerEvent(
      this.app.workspace.on("file-open", () => {
        this.getView()?.updateNotesVisibility();
        this.showActiveNotePaper();
      })
    );
    // A note just created gets its zotero-key after it is opened
    this.registerEvent(
      this.app.metadataCache.on("changed", (file) => {
        if (file !== this.app.workspace.getActiveFile()) return;
        this.getView()?.updateNotesVisibility();
        this.showActiveNotePaper();
      })
    );
    // On (re)load, Obsidian restores the sidebar view a little after the
    // plugin starts: asking for it right away would open a second one
    const timer = window.setTimeout(() => this.showActiveNotePaper(), 1000);
    this.register(() => window.clearTimeout(timer));
  }

  /**
   * Drops of image annotations from the sidebar: the image Zotero renders is
   * copied into the vault and embedded (other annotations drop as plain text).
   */
  private registerAnnotationDrop(): void {
    this.registerEvent(
      this.app.workspace.on("editor-drop", (evt, editor) => {
        const data = evt.dataTransfer?.getData(ANNOTATION_DRAG_TYPE);
        if (evt.defaultPrevented || !data) return;
        evt.preventDefault();
        const drag = JSON.parse(data) as AnnotationDrag;
        const cm = evt.target instanceof HTMLElement ? EditorView.findFromDOM(evt.target) : null;
        const at = cm?.posAtCoords({ x: evt.clientX, y: evt.clientY }) ?? null;
        void (async () => {
          const key = drag.annotation.key;
          const image = await this.literature.importImage(drag.imagePath, `${key}.png`);
          if (!image) new Notice("Zotero has no image for this annotation yet: open it in Zotero's reader first.");
          const md = annotationMarkdown(drag.annotation, drag.parentKey, drag.citation, image?.path);
          if (cm && at !== null) cm.dispatch({ changes: { from: at, insert: md }, selection: { anchor: at + md.length } });
          else editor.replaceSelection(md);
        })();
      })
    );
  }

  /** Sends the edits of every literature note to Zotero, asking about conflicts; false when it failed */
  private async pushAllLiteratureNotes(): Promise<boolean> {
    try {
      await this.literature.pushAll(true);
      return true;
    } catch (e) {
      new Notice(`Could not send the edits to Zotero: ${(e as Error).message}`);
      return false;
    }
  }

  /** Refreshes every literature note from Zotero (edited sections are kept), with a progress notice */
  private async refreshAllLiteratureNotes(): Promise<void> {
    const notice = new Notice("Refreshing literature notes from Zotero\u2026", 0);
    try {
      const { refreshed, failed } = await this.literature.refreshAll((done, total) =>
        notice.setMessage(`Refreshing literature notes from Zotero\u2026 ${done}/${total}`)
      );
      new Notice(
        `${refreshed} literature note(s) refreshed from Zotero` +
          (failed > 0 ? `, ${failed} failed (details in the developer console).` : ".")
      );
    } catch (e) {
      new Notice(`Could not refresh from Zotero: ${(e as Error).message}`);
    } finally {
      notice.hide();
    }
    const key = this.getView()?.getCurrentItemKey();
    if (key) {
      this.cache.delete(key);
      void this.loadAnnotations(key, true);
    }
  }

  /** Sends the edits of a literature note to Zotero; `interactive`: asked by the user (conflicts, errors shown) */
  private async pushLiteratureNote(file: TFile, interactive = false): Promise<void> {
    window.clearTimeout(this.pushTimers.get(file.path));
    this.pushTimers.delete(file.path);
    try {
      await this.literature.push(file, interactive);
    } catch (e) {
      if (interactive) new Notice(`Could not send the edits to Zotero: ${(e as Error).message}`);
      else console.warn(`Zotero Annotations: could not send ${file.path} to Zotero`, e);
    }
  }

  private registerLiteratureNoteEvents(): void {
    // Refresh a literature note when it is opened; send the edits of the one left
    let previous: TFile | null = null;
    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        if (!this.settings.literatureNotes) return;
        if (previous && previous !== file && this.settings.pushEdits && this.literature.keyOf(previous)) {
          void this.pushLiteratureNote(previous);
        }
        previous = file;
        if (file) void this.literature.onOpen(file);
      })
    );
    // …and once it has not been edited for a while
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (!(file instanceof TFile) || !this.settings.literatureNotes || !this.settings.pushEdits) return;
        if (!this.literature.keyOf(file)) return;
        window.clearTimeout(this.pushTimers.get(file.path));
        this.pushTimers.set(
          file.path,
          window.setTimeout(() => void this.pushLiteratureNote(file), PUSH_IDLE_MS)
        );
      })
    );
    this.register(() => this.pushTimers.forEach((t) => window.clearTimeout(t)));
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!(file instanceof TFile) || !this.literature.keyOf(file)) return;
        menu.addItem((item) =>
          item
            .setTitle("Refresh from Zotero")
            .setIcon("refresh-cw")
            .onClick(() => void this.refreshLiteratureNote(file))
        );
        menu.addItem((item) =>
          item
            .setTitle("Send edits to Zotero")
            .setIcon("upload")
            .onClick(() => void this.pushLiteratureNote(file, true))
        );
      })
    );
    // Check Zotero when coming back to Obsidian
    this.registerDomEvent(window, "focus", () => void this.checkZotero());
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (file instanceof TFile) this.literature.onRename(file, oldPath);
      })
    );


    // "linked" mode: every paper linked from the vault gets a literature note
    const createLinked = debounce(() => void this.createLinkedNotes(), 5000, true);
    this.register(
      this.mentions.onChange(() => {
        if (this.settings.literatureNotes && this.settings.createMode === "linked") createLinked();
      })
    );
    if (this.settings.literatureNotes && this.settings.createMode === "linked") createLinked();
  }

  async createLinkedNotes(): Promise<void> {
    for (const key of await this.mentions.getKeys()) {
      if (!this.settings.literatureNotes || this.settings.createMode !== "linked") return;
      // Malformed keys (see "Repair links…") name no item
      if (/^[A-Z0-9]{8}$/.test(key) && !this.literature.findNote(key)) await this.ensureLiteratureNote(key);
    }
  }


  /**
   * Keeps the mention index in sync with the vault, and the sidebar in sync
   * with the index.
   */
  private registerMentionIndexEvents(): void {
    const asMarkdown = (file: TAbstractFile): TFile | null =>
      file instanceof TFile && file.extension === "md" ? file : null;

    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        const md = asMarkdown(file);
        if (md) this.mentions.onFileChanged(md);
      })
    );
    this.registerEvent(
      this.app.vault.on("create", (file) => {
        const md = asMarkdown(file);
        if (md) this.mentions.onFileChanged(md);
      })
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        this.mentions.onFileDeleted(file.path);
      })
    );
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (file instanceof TFile) this.mentions.onFileRenamed(file, oldPath);
        else this.mentions.onFileDeleted(oldPath);
      })
    );

    this.register(
      this.mentions.onChange(() => {
        this.getView()?.refreshMentions();
      })
    );
  }

  /**
   * Lists every Zotero paper linked from the note being edited, laid out along
   * its heading structure, in the sidebar.
   */
  private async showPapersInActiveNote(): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== "md") {
      new Notice("Open a note to list the papers it mentions.");
      return;
    }

    await this.ensureSidebarOpen(true);
    const view = this.getView();
    if (!view) return;
    view.showPaperListLoading(file.basename);

    const hits = await this.mentions.getHitsInFile(file);
    const keys = Array.from(new Set(hits.map((h) => h.key)));

    if (keys.some((k) => !this.summaries.has(k)) && !(await isZoteroRunning())) {
      view.showError(
        "Cannot reach Zotero. Make sure Zotero is running and the local API is enabled in Settings \u2192 Advanced.",
        true
      );
      return;
    }

    const resolved = new Map<string, PaperInfo | null>();
    await Promise.all(
      keys.map(async (key) => {
        resolved.set(key, await this.resolveSummary(key));
      })
    );

    // The user may have left the paper list while Zotero was being queried
    if (!view.isShowingPapers()) return;

    const papers: PaperHit[] = [];
    for (const hit of hits) {
      const paper = resolved.get(hit.key);
      if (paper) papers.push({ line: hit.line, paper });
    }
    const headings = this.app.metadataCache.getFileCache(file)?.headings || [];
    view.setPaperList({
      path: file.path,
      name: file.basename,
      root: buildPaperOutline(headings, papers),
    });
  }

  /** Item summary for the paper list, fetched once per key and kept in memory. */
  private async resolveSummary(key: string): Promise<PaperInfo | null> {
    const cached = this.summaries.get(key);
    if (cached !== undefined) return cached;
    let summary: PaperInfo | null = Platform.isDesktop ? await fetchItemSummary(key) : null;
    if (!summary) {
      // Zotero not reachable: the copy kept in the literature note
      const info = (await this.literature.cachedPaper(key))?.info;
      if (info) summary = { key: info.key, title: info.title, creators: info.creators, year: /\b(\d{4})\b/.exec(info.date)?.[1] || "" };
    }
    this.summaries.set(key, summary);
    return summary;
  }

  /**
   * Repairs the links of a note pointing at items deleted from Zotero or in
   * its trash (merged duplicates): see {@link recoverItem}.
   */
  private async repairLinksInNote(file: TFile): Promise<void> {
    const text = await this.app.vault.read(file);
    const keys = new Set(Array.from(text.matchAll(SELECT_LINK_RE), (m) => m[2].toUpperCase()));
    const own = this.literature.keyOf(file);
    if (own) keys.add(own);
    await this.repairLinks([...keys], file.basename);
  }

  /** Repairs the links of every note of the vault (see {@link repairLinksInNote}) */
  private async repairLinksInVault(): Promise<void> {
    // Only paper links are repaired (open-pdf links name attachments)
    const keys: string[] = [];
    for (const key of await this.mentions.getKeys()) {
      const select = new RegExp(`zotero://select/(?:library|groups/\\d+)/items/${key}(?![A-Z0-9])`, "i");
      if ((await this.mentions.getMentions(key)).some((m) => select.test(m.text))) keys.push(key);
    }
    await this.repairLinks(keys, "Vault");
  }

  /** Relinks the dead items among `keys` (Zotero links of `where`) */
  private async repairLinks(keys: string[], where: string): Promise<void> {
    const notice = new Notice(`Checking ${keys.length} Zotero item(s)\u2026`, 0);
    try {
      const dead = await deadItems(keys);
      if (dead.length === 0) {
        new Notice(`${where}: every Zotero link is fine.`);
        return;
      }
      await this.recoverItems(dead, (item) => notice.setMessage(`Looking for the item that replaced ${item.key}\u2026`));
    } catch (e) {
      new Notice(`Could not check the links with Zotero: ${(e as Error).message}`);
    } finally {
      notice.hide();
    }
  }

  /** Sidebar: repairs the links of one item no longer in the library */
  private async recoverItem(key: string): Promise<void> {
    try {
      const dead = await deadItem(key);
      if (!dead) {
        new Notice(`Item ${key} is in your Zotero library: nothing to repair.`);
        return;
      }
      await this.recoverItems([dead]);
    } catch (e) {
      new Notice(`Could not look for the item in Zotero: ${(e as Error).message}`);
    }
  }

  /**
   * Points the links of dead items at the items Zotero merged them into, and
   * reports in a modal: the items relinked, then the others (no merge record)
   * to review, with a search to pick their item by hand.
   */
  private async recoverItems(dead: DeadItem[], onItem?: (item: DeadItem) => void): Promise<void> {
    const relinked: RelinkedItem[] = [];
    const review: RepairEntry[] = [];
    for (const found of dead) {
      onItem?.(found);
      // What Zotero's trash does not say, the literature note may, else the text of the links
      let item = withMetadata(found, await this.literature.knownMetadata(found.key));
      const mentions = await this.mentions.getMentions(item.key);
      const texts = linkTexts(
        mentions.map((m) => m.text),
        item.key
      );
      if (!item.title && texts.titles.length > 0) item = { ...item, title: texts.titles[0] };
      const replacement = await findReplacement(item);
      if (replacement?.certain) {
        const result = await this.relink(item.key, replacement.key);
        relinked.push({ dead: item, key: replacement.key, newTitle: replacement.title, result });
      } else {
        review.push({ dead: item, guess: replacement?.key ?? null, mentions, queries: searchQueries(item, texts) });
      }
    }
    this.repairReport = { relinked, review };
    this.showRepairReport();
  }

  /** Opens the last repair report as it was left */
  private showRepairReport(): void {
    const report = this.repairReport;
    if (!report) return;
    new RepairModal(this.app, report, {
      search: (query) => this.searchForRepair(query),
      relink: (oldKey, newKey) => this.relink(oldKey, newKey),
      openNote: (path) => {
        void this.openMention({ path, line: 0, text: "" });
        this.backToReportNotice();
      },
      openUrl: (url) => window.open(url),
      autoSearch: this.app.loadLocalStorage(REPAIR_AUTO_SEARCH) !== "off",
      setAutoSearch: (on) => this.app.saveLocalStorage(REPAIR_AUTO_SEARCH, on ? "on" : "off"),
      openMention: (mention) => {
        void this.openMention(mention);
        this.backToReportNotice();
      },
      showInZotero: (key) => this.openInZotero(`zotero://select/library/items/${key}`),
    }).open();
  }

  /** A notice leading back to the repair report, after opening a note from it */
  private backToReportNotice(): void {
    const back = createFragment();
    back.appendText("Opened from the Zotero link repair report. ");
    back.createEl("a", { text: "Back to the report" }).addEventListener("click", () => this.showRepairReport());
    new Notice(back, 15_000);
  }

  /** Library search of the repair report, reused for a few minutes */
  private searchForRepair(query: string): Promise<ZoteroItemSummary[]> {
    const hit = this.repairSearches.get(query);
    if (hit && Date.now() - hit.at < REPAIR_SEARCH_MS) return hit.items;
    const items = searchItemSummaries(query);
    this.repairSearches.set(query, { at: Date.now(), items });
    items.catch(() => this.repairSearches.delete(query));
    return items;
  }

  /** Points the vault's links (and the literature note) of item `oldKey` at `newKey`; returns the number of notes changed */
  private async relink(oldKey: string, newKey: string): Promise<RelinkResult> {
    const literature = await this.literature.rekey(oldKey, newKey);
    const moved = literature?.moved ? literature.file : null;
    const re = new RegExp(`(zotero://select/(?:library|groups/\\d+)/items/)${oldKey}(?![A-Z0-9])`, "gi");
    const paths = new Set((await this.mentions.getMentions(oldKey)).map((m) => m.path));
    let changed = moved ? 1 : 0;
    for (const path of paths) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) continue;
      let replaced = false;
      await this.app.vault.process(file, (text) => {
        const out = text.replace(re, `$1${newKey}`);
        replaced = out !== text;
        return out;
      });
      if (replaced && file !== moved) changed++;
    }
    for (const key of [oldKey, newKey]) {
      this.cache.delete(key);
      this.summaries.delete(key);
    }
    if (this.getView()?.getCurrentItemKey() === oldKey) await this.loadAnnotations(newKey, true);
    return { notes: changed, literature: literature && { path: literature.file.path, moved: literature.moved } };
  }

  /** Opens the note a mention lives in, scrolled to its line. */
  private async openMention(mention: Mention): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(mention.path);
    if (!(file instanceof TFile)) return;
    const leaf = this.app.workspace.getMostRecentLeaf() || this.app.workspace.getLeaf(true);
    await leaf.openFile(file, { eState: { line: mention.line } });
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<ZoteroAnnotationsSettings>);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  private handleDoubleClick(link: ZoteroLink): void {
    if (this.debounceTimer) {
      window.clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    const pending = this.pendingClickTimers.get(link.key);
    if (pending) {
      window.clearTimeout(pending);
      this.pendingClickTimers.delete(link.key);
    }
    // The link itself: a PDF link opens the PDF (at its annotation)
    this.openInZotero(link.url);
  }

  /** The paper of a link: the item of a `select` link, the parent of the attachment of an `open-pdf` one */
  private async paperOfLink(link: ZoteroLink): Promise<string | null> {
    if (link.kind === "select") return link.key;
    const known = this.attachmentPapers.get(link.key);
    if (known) return known;
    let paper = Platform.isDesktop ? ((await fetchItemSummary(link.key))?.key ?? null) : null;
    if (!paper) {
      // Zotero not reachable: the literature note naming this PDF
      const note = this.literature.findNoteOfAttachment(link.key);
      paper = note && this.literature.keyOf(note);
    }
    if (paper) this.attachmentPapers.set(link.key, paper);
    return paper;
  }


  private onLinkChanged(link: ZoteroLink | null): void {
    this.cursorLink = link;
    if (this.debounceTimer) {
      window.clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = window.setTimeout(() => {
      if (link) {
        void (async () => {
          const itemKey = await this.paperOfLink(link);
          if (!itemKey || this.cursorLink !== link) return;
          await this.ensureSidebarOpen();
          await this.loadAnnotations(itemKey);
          if (this.settings.literatureNotes && this.settings.createMode === "cursor") {
            void this.ensureLiteratureNote(itemKey);
          }
        })();
      } else {
        const noteKey = this.followedNoteKey();
        if (noteKey) void this.loadAnnotations(noteKey);
        else this.getView()?.showEmpty();
      }
    }, 300);
  }

  /**
   * @param force load even when the sidebar is pinned (explicit user action,
   *   e.g. clicking a related item)
   */
  private async loadAnnotations(itemKey: string, force = false): Promise<void> {
    const view = this.getView();
    if (!view || (view.ignoresCursor() && !force)) return;

    // Shown from the cache, then checked against Zotero
    const cached = this.cache.get(itemKey);
    if (cached) {
      if (!view.isShowingItem(itemKey)) view.setAnnotations(itemKey, cached.info, cached.annotations, force);
      void this.revalidate(itemKey).catch((e) => console.warn("Zotero Annotations: could not check Zotero", e));
      return;
    }

    view.showLoading(itemKey, force);

    const running = Platform.isDesktop && (await isZoteroRunning());
    if (!running) {
      // The copy kept in the paper's literature note
      const copy = await this.literature.cachedPaper(itemKey);
      if (copy) {
        view.setAnnotations(itemKey, copy.info, copy.annotations, force, copy.cached);
      } else if (Platform.isDesktop) {
        view.showError("Cannot reach Zotero. Make sure Zotero is running and the local API is enabled in Settings \u2192 Advanced.", force);
      } else {
        view.showError("No copy of this paper on this device: it is kept in literature notes, written on the computer running Zotero.", force);
      }
      return;
    }

    try {
      const [version, info, annotations] = await Promise.all([
        this.currentLibraryVersion(0),
        fetchItemInfo(itemKey),
        fetchAnnotations(itemKey),
      ]);

      this.cache.set(itemKey, { info, annotations, version });

      if (view.getCurrentItemKey() === itemKey || !view.ignoresCursor()) {
        view.setAnnotations(itemKey, info, annotations, force);
      }
    } catch (e) {
      if (isNotFound(e)) {
        view.showError(
          `Item ${itemKey} is not in your Zotero library: deleted, merged into another item, or in a group library.`,
          force,
          itemKey
        );
        return;
      }
      console.error("Zotero Annotations: error loading annotations", e);
      view.showError(`Failed to load annotations: ${(e as Error).message}`, force);
    }
  }

  /**
   * The sidebar view, if open and loaded. Obsidian loads views of hidden
   * leaves lazily: until then the leaf holds a placeholder, not our view.
   */
  private getView(): AnnotationView | null {
    const view = this.app.workspace.getLeavesOfType(VIEW_TYPE_ZOTERO_ANNOTATIONS)[0]?.view;
    return view instanceof AnnotationView ? view : null;
  }

  /**
   * Opens the sidebar view if needed.
   * @param reveal also bring it to the front (explicit user actions such as
   *   clicking a link): another tab of the sidebar may be hiding it
   */
  /**
   * Keeps a single sidebar view: earlier versions could open a new one while
   * the existing view was still unloaded (deferred).
   */
  private removeDuplicateViews(): void {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_ZOTERO_ANNOTATIONS);
    const keep = leaves.find((l) => l.view instanceof AnnotationView) ?? leaves[0];
    for (const leaf of leaves) if (leaf !== keep) leaf.detach();
  }

  private async ensureSidebarOpen(reveal = false): Promise<void> {
    if (!this.getView()) {
      const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_ZOTERO_ANNOTATIONS)[0];
      if (existing) await existing.loadIfDeferred();
    }
    if (!this.getView()) {
      const leaf = this.app.workspace.getRightLeaf(false);
      if (leaf) {
        await leaf.setViewState({
          type: VIEW_TYPE_ZOTERO_ANNOTATIONS,
          active: true,
        });
      }
    }
    const view = this.getView();
    if (reveal && view) await this.app.workspace.revealLeaf(view.leaf);
  }

  private async toggleSidebar(): Promise<void> {
    const existing = this.getView();
    if (existing) {
      existing.leaf.detach();
    } else {
      await this.ensureSidebarOpen();
    }
  }
}

/** Help text: how to get zotero:// links into notes */
function linksHelp(): DocumentFragment {
  const frag = createFragment();
  frag.appendText("The plugin reacts to ");
  frag.createEl("code", { text: "zotero://select/library/items/KEY" });
  frag.appendText(" (papers) and ");
  frag.createEl("code", { text: "zotero://open-pdf/library/items/KEY?page=…&annotation=…" });
  frag.appendText(" (annotations) links. To copy them from Zotero, install the ");
  frag.createEl("a", { text: "Actions & Tags", href: "https://github.com/windingwind/zotero-actions-tags" });
  frag.appendText(" add-on and import or create the actions of ");
  frag.createEl("a", {
    text: "these examples",
    href: "https://github.com/bpiwowar/obsidian-zotero-annotations/blob/main/docs/actions-tags.md",
  });
  frag.appendText(
    " (copy a Zotero link, a Markdown link, or an annotation as a quote). " +
      "Select a paper, or an annotation in the PDF reader, run the action, and paste into Obsidian."
  );
  return frag;
}

class ZoteroAnnotationsSettingTab extends PluginSettingTab {
  plugin: ZoteroAnnotationsPlugin;

  constructor(app: App, plugin: ZoteroAnnotationsPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    const off = () => !this.plugin.settings.literatureNotes;
    // Settings about talking to Zotero or writing notes from it: desktop only
    const desktop = () => Platform.isDesktop && !off();
    return [
      {
        name: "Zotero data directory",
        desc: "Path to your Zotero data folder (used to load annotation images from cache)",
        visible: () => Platform.isDesktop,
        control: {
          type: "text",
          key: "zoteroDataDir",
          placeholder: DEFAULT_SETTINGS.zoteroDataDir,
          defaultValue: DEFAULT_SETTINGS.zoteroDataDir,
        },
      },
      {
        name: "Getting Zotero links",
        desc: linksHelp(),
      },
      {
        name: "Follow literature notes",
        desc: "When a note with a zotero-key property is open, show its paper in the sidebar.",
        control: { type: "toggle", key: "followNote", defaultValue: DEFAULT_SETTINGS.followNote },
      },
      {
        type: "group",
        heading: "Literature notes",
        items: [
          {
            name: "Literature notes",
            desc: "Keep a note per paper in the vault, with its annotations and Zotero notes, updated when Zotero changes.",
            control: { type: "toggle", key: "literatureNotes", defaultValue: DEFAULT_SETTINGS.literatureNotes },
          },
          {
            name: "Create notes",
            desc: "When a literature note is created for a paper.",
            visible: desktop,
            control: {
              type: "dropdown",
              key: "createMode",
              defaultValue: DEFAULT_SETTINGS.createMode,
              options: {
                manual: "On demand (sidebar button or command)",
                cursor: "When the cursor is on a link to the paper",
                linked: "For every paper linked from the vault",
              },
            },
          },
          {
            name: "Notes folder",
            desc: "Where new literature notes are created.",
            visible: desktop,
            control: { type: "folder", key: "notesFolder", defaultValue: DEFAULT_SETTINGS.notesFolder },
          },
          {
            name: "Words of the title in note names",
            desc: "New notes are named \u201cShort title \u2013 KEY\u201d, keeping at most this many words of the title.",
            visible: desktop,
            control: { type: "number", key: "titleMaxWords", min: 1, defaultValue: DEFAULT_SETTINGS.titleMaxWords },
          },
          {
            name: "Cut the title at",
            desc: "Note names keep the title up to the first of these characters (e.g. \u201c:\u201d drops subtitles). Empty: keep the whole title.",
            visible: desktop,
            control: { type: "text", key: "titleCutAt", defaultValue: DEFAULT_SETTINGS.titleCutAt },
          },
          {
            name: "Image folder",
            desc: "Where annotation excerpts and images from Zotero notes are copied.",
            visible: () => !off(),
            control: { type: "folder", key: "imageFolder", defaultValue: DEFAULT_SETTINGS.imageFolder },
          },
          {
            name: "Check Zotero every (minutes)",
            desc: "0 checks only when Obsidian regains focus, or when a paper or its literature note is shown.",
            visible: desktop,
            control: { type: "number", key: "syncInterval", min: 0, defaultValue: DEFAULT_SETTINGS.syncInterval },
          },
          {
            name: "Send edits to Zotero",
            desc:
              "Note sections edited in Obsidian update their Zotero note when you leave the note, after 30 s " +
              "without typing, and on each check. Otherwise use \"Send literature note edits to Zotero\". " +
              "The first write asks for permission in Zotero (choose \"Always allow\").",
            visible: desktop,
            control: { type: "toggle", key: "pushEdits", defaultValue: DEFAULT_SETTINGS.pushEdits },
          },
        ],
      },
    ];
  }

  getControlValue(key: string): unknown {
    return this.plugin.settings[key as keyof ZoteroAnnotationsSettings];
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    if (!(key in DEFAULT_SETTINGS)) return;
    (this.plugin.settings as unknown as Record<string, unknown>)[key] = value;
    await this.plugin.saveSettings();
    if (key === "literatureNotes") this.update();
    if (!Platform.isDesktop) return;
    if (key === "literatureNotes" || key === "syncInterval") this.plugin.restartSync();
    if ((key === "createMode" || key === "literatureNotes") && this.plugin.settings.createMode === "linked") {
      void this.plugin.createLinkedNotes();
    }
  }
}
