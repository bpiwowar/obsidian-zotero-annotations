import { Plugin, PluginSettingTab, Setting, App } from "obsidian";
import { AnnotationView, VIEW_TYPE_ZOTERO_ANNOTATIONS } from "./annotation-view";
import { createCursorDetectorPlugin, extractZoteroKey } from "./cursor-detector";
import { fetchAnnotations, fetchItemInfo, isZoteroRunning } from "./zotero-client";

interface ZoteroAnnotationsSettings {
  zoteroDataDir: string;
}

function getDefaultZoteroDataDir(): string {
  try {
    const os = require("os") as typeof import("os");
    return `${os.homedir()}/Zotero`;
  } catch {
    return "";
  }
}

const DEFAULT_SETTINGS: ZoteroAnnotationsSettings = {
  zoteroDataDir: getDefaultZoteroDataDir(),
};

export default class ZoteroAnnotationsPlugin extends Plugin {
  settings: ZoteroAnnotationsSettings = DEFAULT_SETTINGS;
  /** Debounce timer for cursor changes */
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private originalWindowOpen: typeof window.open | null = null;
  /** Cache: itemKey → fetched annotations (avoid re-fetching on every cursor move) */
  private cache = new Map<
    string,
    { info: Awaited<ReturnType<typeof fetchItemInfo>>; annotations: Awaited<ReturnType<typeof fetchAnnotations>> }
  >();

  async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new ZoteroAnnotationsSettingTab(this.app, this));

    // Save original window.open and patch it to intercept zotero://select/ links
    const origOpen = window.open;
    this.originalWindowOpen = origOpen;
    let bypassIntercept = false;
    const self = this;
    window.open = (...args: Parameters<typeof window.open>) => {
      const url = typeof args[0] === "string" ? args[0] : args[0]?.toString() || "";
      const key = extractZoteroKey(url);
      if (key && url.includes("zotero://select/") && !bypassIntercept) {
        (async () => {
          await self.ensureSidebarOpen();
          await self.loadAnnotations(key);
        })();
        return null;
      }
      return origOpen.apply(window, args);
    };

    // Register the sidebar view
    this.registerView(VIEW_TYPE_ZOTERO_ANNOTATIONS, (leaf) => {
      const view = new AnnotationView(leaf);
      view.zoteroDataDir = this.settings.zoteroDataDir;
      view.openExternal = (url: string) => {
        bypassIntercept = true;
        try { origOpen.call(window, url); } finally { bypassIntercept = false; }
      };
      return view;
    });

    // Register the CM6 extension for cursor detection
    this.registerEditorExtension(
      createCursorDetectorPlugin((itemKey) => this.onItemKeyChanged(itemKey))
    );

    // Command: toggle sidebar
    this.addCommand({
      id: "toggle-annotations-sidebar",
      name: "Toggle Zotero Annotations sidebar",
      callback: () => this.toggleSidebar(),
    });

    // Command: freeze/unfreeze
    this.addCommand({
      id: "toggle-freeze",
      name: "Pin/Unpin annotations sidebar",
      callback: () => {
        const view = this.getView();
        if (view) view.toggleFreeze();
      },
    });

    // Command: refresh current
    this.addCommand({
      id: "refresh-annotations",
      name: "Refresh current annotations",
      callback: () => {
        const view = this.getView();
        if (view) {
          const key = view.getCurrentItemKey();
          if (key) {
            this.cache.delete(key);
            this.loadAnnotations(key);
          }
        }
      },
    });
  }

  onunload(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.originalWindowOpen) {
      window.open = this.originalWindowOpen;
      this.originalWindowOpen = null;
    }
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  private onItemKeyChanged(itemKey: string | null): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(async () => {
      if (itemKey) {
        await this.ensureSidebarOpen();
        await this.loadAnnotations(itemKey);
      } else {
        const view = this.getView();
        if (view && !view.isFrozen()) {
          view.showEmpty();
        }
      }
    }, 300);
  }

  private async loadAnnotations(itemKey: string): Promise<void> {
    const view = this.getView();
    if (!view || view.isFrozen()) return;

    if (view.getCurrentItemKey() === itemKey && this.cache.has(itemKey)) {
      return;
    }

    const cached = this.cache.get(itemKey);
    if (cached) {
      view.setAnnotations(itemKey, cached.info, cached.annotations);
      return;
    }

    view.showLoading(itemKey);

    const running = await isZoteroRunning();
    if (!running) {
      view.showError("Cannot reach Zotero. Make sure Zotero is running and the local API is enabled in Settings \u2192 Advanced.");
      return;
    }

    try {
      const [info, annotations] = await Promise.all([
        fetchItemInfo(itemKey),
        fetchAnnotations(itemKey),
      ]);

      this.cache.set(itemKey, { info, annotations });

      if (view.getCurrentItemKey() === itemKey || !view.isFrozen()) {
        view.setAnnotations(itemKey, info, annotations);
      }
    } catch (e) {
      console.error("Zotero Annotations: error loading annotations", e);
      view.showError(`Failed to load annotations: ${(e as Error).message}`);
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
          .setPlaceholder(getDefaultZoteroDataDir())
          .setValue(this.plugin.settings.zoteroDataDir)
          .onChange(async (value) => {
            this.plugin.settings.zoteroDataDir = value;
            await this.plugin.saveSettings();
          })
      );
  }
}
