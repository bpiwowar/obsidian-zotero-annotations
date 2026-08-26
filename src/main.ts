import { Plugin, PluginSettingTab, Setting, App, TAbstractFile, TFile } from "obsidian";
import { AnnotationView, VIEW_TYPE_ZOTERO_ANNOTATIONS } from "./annotation-view";
import { createCursorDetectorPlugin, extractZoteroKey } from "./cursor-detector";
import { fetchAnnotations, fetchItemInfo, isZoteroRunning } from "./zotero-client";
import { Mention, MentionIndex } from "./mention-index";
import { homedir } from "os";

interface ZoteroAnnotationsSettings {
  zoteroDataDir: string;
}

const DEFAULT_SETTINGS: ZoteroAnnotationsSettings = {
  zoteroDataDir: `${homedir()}/Zotero`,
};

const DOUBLE_CLICK_MS = 300;

export default class ZoteroAnnotationsPlugin extends Plugin {
  settings: ZoteroAnnotationsSettings = DEFAULT_SETTINGS;
  private debounceTimer: number | null = null;
  private originalWindowOpen: typeof window.open | null = null;
  private pendingClickTimers = new Map<string, number>();
  private openInZotero: (url: string) => void = (url) => window.open(url);
  private cache = new Map<
    string,
    { info: Awaited<ReturnType<typeof fetchItemInfo>>; annotations: Awaited<ReturnType<typeof fetchAnnotations>> }
  >();
  private mentions!: MentionIndex;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new ZoteroAnnotationsSettingTab(this.app, this));

    // Index of vault notes linking to Zotero items. The vault scan is lazy
    // (first lookup) and cached on disk, so it costs little on startup.
    this.mentions = new MentionIndex(
      this.app,
      this.manifest.dir ? `${this.manifest.dir}/mention-index.json` : null
    );
    this.registerMentionIndexEvents();

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
      if (key && url.includes("zotero://select/") && !bypassIntercept) {
        const existing = this.pendingClickTimers.get(key);
        if (existing) activeWindow.clearTimeout(existing);
        const timer = activeWindow.setTimeout(() => {
          this.pendingClickTimers.delete(key);
          void (async () => {
            await this.ensureSidebarOpen();
            await this.loadAnnotations(key);
          })();
        }, DOUBLE_CLICK_MS);
        this.pendingClickTimers.set(key, timer);
        return null;
      }
      return origOpen.apply(window, args) as WindowProxy | null;
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
        activeWindow.clearTimeout(pending);
        this.pendingClickTimers.delete(key);
      }
      evt.preventDefault();
      evt.stopPropagation();
      openInZotero(href);
    });

    // Register the sidebar view
    this.registerView(VIEW_TYPE_ZOTERO_ANNOTATIONS, (leaf) => {
      const view = new AnnotationView(leaf);
      view.zoteroDataDir = this.settings.zoteroDataDir;
      view.openExternal = openInZotero;
      view.onNavigate = (itemKey) => void this.loadAnnotations(itemKey, true);
      view.mentionProvider = (itemKey) => this.mentions.getMentions(itemKey);
      view.openMention = (mention) => void this.openMention(mention);
      return view;
    });

    // Register the CM6 extension for cursor detection and dblclick handling
    this.registerEditorExtension(
      createCursorDetectorPlugin({
        onChange: (itemKey) => this.onItemKeyChanged(itemKey),
        onDoubleClick: (itemKey) => this.handleDoubleClick(itemKey),
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
      id: "rescan-mentions",
      name: "Rescan vault for Zotero mentions",
      callback: () => {
        void this.mentions.rebuild();
      },
    });

    this.addCommand({
      id: "refresh-annotations",
      name: "Refresh current annotations",
      callback: () => {
        const view = this.getView();
        if (view) {
          const key = view.getCurrentItemKey();
          if (key) {
            this.cache.delete(key);
            void this.loadAnnotations(key);
          }
        }
      },
    });
  }

  onunload(): void {
    if (this.debounceTimer) {
      activeWindow.clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    for (const timer of this.pendingClickTimers.values()) {
      activeWindow.clearTimeout(timer);
    }
    this.pendingClickTimers.clear();
    if (this.originalWindowOpen) {
      window.open = this.originalWindowOpen;
      this.originalWindowOpen = null;
    }
    this.mentions.unload();
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

  private handleDoubleClick(itemKey: string): void {
    if (this.debounceTimer) {
      activeWindow.clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    const pending = this.pendingClickTimers.get(itemKey);
    if (pending) {
      activeWindow.clearTimeout(pending);
      this.pendingClickTimers.delete(itemKey);
    }
    this.openInZotero(`zotero://select/library/items/${itemKey}`);
  }

  private onItemKeyChanged(itemKey: string | null): void {
    if (this.debounceTimer) {
      activeWindow.clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = activeWindow.setTimeout(() => {
      if (itemKey) {
        void (async () => {
          await this.ensureSidebarOpen();
          await this.loadAnnotations(itemKey);
        })();
      } else {
        const view = this.getView();
        if (view && !view.isFrozen()) {
          view.showEmpty();
        }
      }
    }, 300);
  }

  /**
   * @param force load even when the sidebar is pinned (explicit user action,
   *   e.g. clicking a related item)
   */
  private async loadAnnotations(itemKey: string, force = false): Promise<void> {
    const view = this.getView();
    if (!view || (view.isFrozen() && !force)) return;

    if (view.getCurrentItemKey() === itemKey && this.cache.has(itemKey)) {
      return;
    }

    const cached = this.cache.get(itemKey);
    if (cached) {
      view.setAnnotations(itemKey, cached.info, cached.annotations, force);
      return;
    }

    view.showLoading(itemKey, force);

    const running = await isZoteroRunning();
    if (!running) {
      view.showError("Cannot reach Zotero. Make sure Zotero is running and the local API is enabled in Settings \u2192 Advanced.", force);
      return;
    }

    try {
      const [info, annotations] = await Promise.all([
        fetchItemInfo(itemKey),
        fetchAnnotations(itemKey),
      ]);

      this.cache.set(itemKey, { info, annotations });

      if (view.getCurrentItemKey() === itemKey || !view.isFrozen()) {
        view.setAnnotations(itemKey, info, annotations, force);
      }
    } catch (e) {
      console.error("Zotero Annotations: error loading annotations", e);
      view.showError(`Failed to load annotations: ${(e as Error).message}`, force);
    }
  }

  private getView(): AnnotationView | null {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_ZOTERO_ANNOTATIONS);
    if (leaves.length > 0) {
      return leaves[0].view as AnnotationView;
    }
    return null;
  }

  private async ensureSidebarOpen(): Promise<void> {
    if (this.getView()) return;

    const leaf = this.app.workspace.getRightLeaf(false);
    if (leaf) {
      await leaf.setViewState({
        type: VIEW_TYPE_ZOTERO_ANNOTATIONS,
        active: true,
      });
    }
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

class ZoteroAnnotationsSettingTab extends PluginSettingTab {
  plugin: ZoteroAnnotationsPlugin;

  constructor(app: App, plugin: ZoteroAnnotationsPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Zotero data directory")
      .setDesc("Path to your Zotero data folder (used to load annotation images from cache)")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.zoteroDataDir)
          .setValue(this.plugin.settings.zoteroDataDir)
          .onChange(async (value) => {
            this.plugin.settings.zoteroDataDir = value;
            await this.plugin.saveSettings();
          })
      );
  }
}
