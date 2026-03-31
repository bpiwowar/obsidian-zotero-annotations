import { ItemView, WorkspaceLeaf, setIcon } from "obsidian";
import { ZoteroAnnotation, ZoteroItemInfo } from "./zotero-client";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

export const VIEW_TYPE_ZOTERO_ANNOTATIONS = "zotero-annotations-view";

export class AnnotationView extends ItemView {
  private frozen = false;
  private currentItemKey: string | null = null;
  private itemInfo: ZoteroItemInfo | null = null;
  private annotations: ZoteroAnnotation[] = [];
  /** Opens a URL in the OS, bypassing any window.open intercepts */
  openExternal: (url: string) => void = (url) => window.open(url);
  /** Path to the Zotero data directory */
  zoteroDataDir: string = join(process.env.HOME || "", "Zotero");

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_ZOTERO_ANNOTATIONS;
  }

  getDisplayText(): string {
    return "Zotero Annotations";
  }

  getIcon(): string {
    return "book-open";
  }

  isFrozen(): boolean {
    return this.frozen;
  }

  getCurrentItemKey(): string | null {
    return this.currentItemKey;
  }

  toggleFreeze(): void {
    this.frozen = !this.frozen;
    this.render();
  }

  /**
   * Update the view with new data. If frozen, this is a no-op.
   */
  setAnnotations(
    itemKey: string,
    itemInfo: ZoteroItemInfo | null,
    annotations: ZoteroAnnotation[]
  ): void {
    if (this.frozen) return;
    this.currentItemKey = itemKey;
    this.itemInfo = itemInfo;
    this.annotations = annotations;
    this.render();
  }

  showLoading(itemKey: string): void {
    if (this.frozen) return;
    this.currentItemKey = itemKey;
    this.itemInfo = null;
    this.annotations = [];
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    this.renderToolbar(container);
    container.createEl("div", {
      cls: "zotero-annot-loading",
      text: "Loading annotations…",
    });
  }

  showEmpty(): void {
    if (this.frozen) return;
    this.currentItemKey = null;
    this.itemInfo = null;
    this.annotations = [];
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    this.renderToolbar(container);
    container.createEl("div", {
      cls: "zotero-annot-empty",
      text: "Place your cursor on a zotero:// link to see annotations.",
    });
  }

  showError(message: string): void {
    if (this.frozen) return;
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    this.renderToolbar(container);
    container.createEl("div", {
      cls: "zotero-annot-error",
      text: message,
    });
  }

  async onOpen(): Promise<void> {
    this.showEmpty();
  }

  async onClose(): Promise<void> {
    // cleanup
  }

  private renderToolbar(container: HTMLElement): void {
    const toolbar = container.createEl("div", { cls: "zotero-annot-toolbar" });

    // Freeze/pin button
    const freezeBtn = toolbar.createEl("button", {
      cls: `zotero-annot-freeze-btn ${this.frozen ? "is-active" : ""}`,
      attr: { "aria-label": this.frozen ? "Unpin (auto-update)" : "Pin (freeze current)" },
    });
    setIcon(freezeBtn, this.frozen ? "pin-off" : "pin");
    freezeBtn.createEl("span", {
      text: this.frozen ? " Pinned" : " Auto",
      cls: "zotero-annot-freeze-label",
    });
    freezeBtn.addEventListener("click", () => this.toggleFreeze());

    // Zotero link
    if (this.currentItemKey) {
      const linkBtn = toolbar.createEl("span", {
        cls: "zotero-annot-open-link",
        text: "Open in Zotero",
      });
      const itemKey = this.currentItemKey;
      linkBtn.addEventListener("click", () => {
        this.openExternal(`zotero://select/library/items/${itemKey}`);
      });
    }
  }

  private render(): void {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();

    this.renderToolbar(container);

    // Item header
    if (this.itemInfo) {
      const header = container.createEl("div", { cls: "zotero-annot-header" });
      header.createEl("div", { cls: "zotero-annot-title", text: this.itemInfo.title });
      if (this.itemInfo.creators) {
        header.createEl("div", {
          cls: "zotero-annot-creators",
          text: this.itemInfo.creators,
        });
      }
      if (this.itemInfo.date) {
        header.createEl("span", {
          cls: "zotero-annot-date",
          text: this.itemInfo.date,
        });
      }

      // Abstract with toggle
      if (this.itemInfo.abstractNote) {
        const abstractWrapper = header.createEl("div", { cls: "zotero-annot-abstract-wrapper" });
        const toggleBtn = abstractWrapper.createEl("button", {
          cls: "zotero-annot-abstract-toggle",
          text: "Abstract",
        });
        setIcon(toggleBtn, "chevron-right");
        const abstractText = abstractWrapper.createEl("div", {
          cls: "zotero-annot-abstract",
          text: this.itemInfo.abstractNote,
        });
        abstractText.style.display = "none";
        toggleBtn.addEventListener("click", () => {
          const visible = abstractText.style.display !== "none";
          abstractText.style.display = visible ? "none" : "block";
          toggleBtn.empty();
          setIcon(toggleBtn, visible ? "chevron-right" : "chevron-down");
          toggleBtn.appendText(" Abstract");
        });
      }

      // Notes with toggle
      if (this.itemInfo.notes.length > 0) {
        const notesWrapper = header.createEl("div", { cls: "zotero-annot-abstract-wrapper" });
        const toggleBtn = notesWrapper.createEl("button", {
          cls: "zotero-annot-abstract-toggle",
        });
        setIcon(toggleBtn, "chevron-down");
        toggleBtn.appendText(` Notes (${this.itemInfo.notes.length})`);
        const notesContent = notesWrapper.createEl("div", { cls: "zotero-annot-notes" });
        for (const note of this.itemInfo.notes) {
          const noteEl = notesContent.createEl("div", { cls: "zotero-annot-note" });
          noteEl.innerHTML = note.html;
          // Resolve Zotero image references to cached PNGs
          noteEl.querySelectorAll("img[data-annotation]").forEach((img) => {
            try {
              const annotation = JSON.parse(
                decodeURIComponent(img.getAttribute("data-annotation") || "")
              );
              const annotKey = annotation?.annotationKey;
              if (annotKey) {
                const cachePath = join(this.zoteroDataDir, "cache", "library", `${annotKey}.png`);
                if (existsSync(cachePath)) {
                  const imgData = readFileSync(cachePath);
                  img.setAttribute("src", `data:image/png;base64,${imgData.toString("base64")}`);
                }
              }
            } catch {
              // ignore malformed annotation data
            }
          });
        }
        toggleBtn.addEventListener("click", () => {
          const visible = notesContent.style.display !== "none";
          notesContent.style.display = visible ? "none" : "block";
          toggleBtn.empty();
          setIcon(toggleBtn, visible ? "chevron-right" : "chevron-down");
          toggleBtn.appendText(` Notes (${this.itemInfo!.notes.length})`);
        });
      }
    }

    if (this.annotations.length === 0) {
      container.createEl("div", {
        cls: "zotero-annot-empty",
        text: "No annotations found for this item.",
      });
      return;
    }

    // Annotation count
    container.createEl("div", {
      cls: "zotero-annot-count",
      text: `${this.annotations.length} annotation${this.annotations.length > 1 ? "s" : ""}`,
    });

    // Annotation list
    const list = container.createEl("div", { cls: "zotero-annot-list" });

    let currentPage = "";
    for (const annot of this.annotations) {
      // Page separator
      if (annot.pageLabel && annot.pageLabel !== currentPage) {
        currentPage = annot.pageLabel;
        list.createEl("div", {
          cls: "zotero-annot-page-header",
          text: `Page ${currentPage}`,
        });
      }

      const card = list.createEl("div", { cls: "zotero-annot-card" });

      // Color bar on the left
      card.style.borderLeftColor = annot.color;

      // Annotation type badge
      if (annot.type !== "highlight") {
        card.createEl("span", {
          cls: "zotero-annot-type-badge",
          text: annot.type,
        });
      }

      // Highlighted text or image from cache
      if (annot.type === "image") {
        const cachePath = join(this.zoteroDataDir, "cache", "library", `${annot.key}.png`);
        if (existsSync(cachePath)) {
          const imgData = readFileSync(cachePath);
          const base64 = imgData.toString("base64");
          const img = card.createEl("img", {
            cls: "zotero-annot-image",
            attr: { src: `data:image/png;base64,${base64}` },
          });
          img.style.maxWidth = "100%";
        } else {
          const imgEl = card.createEl("div", { cls: "zotero-annot-image-placeholder" });
          setIcon(imgEl, "image");
          imgEl.appendText(" Area highlight (image not cached)");
        }
      } else if (annot.text) {
        const textEl = card.createEl("div", { cls: "zotero-annot-text" });
        textEl.createEl("span", { text: annot.text });
      }

      // Comment
      if (annot.comment) {
        const commentEl = card.createEl("div", { cls: "zotero-annot-comment" });
        commentEl.createEl("em", { text: annot.comment });
      }

      // Tags
      if (annot.tags.length > 0) {
        const tagsEl = card.createEl("div", { cls: "zotero-annot-tags" });
        for (const tag of annot.tags) {
          tagsEl.createEl("span", { cls: "zotero-annot-tag", text: `#${tag}` });
        }
      }

      // Open PDF at this annotation
      const openLink = card.createEl("span", {
        cls: "zotero-annot-pdf-link",
        text: `p. ${annot.pageLabel || "?"}`,
      });
      openLink.addEventListener("click", () => {
        this.openExternal(
          `zotero://open-pdf/library/items/${annot.attachmentKey}?page=${annot.pageLabel}`
        );
      });
    }
  }
}
