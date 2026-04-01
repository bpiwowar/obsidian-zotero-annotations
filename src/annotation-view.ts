import { ItemView, WorkspaceLeaf, setIcon, sanitizeHTMLToDom } from "obsidian";
import { ZoteroAnnotation, ZoteroItemInfo } from "./zotero-client";
import { readFile, stat } from "fs/promises";

export const VIEW_TYPE_ZOTERO_ANNOTATIONS = "zotero-annotations-view";

async function readFileAsBase64(path: string): Promise<string | null> {
  try {
    await stat(path);
    const buffer = await readFile(path);
    return buffer.toString("base64");
  } catch {
    return null;
  }
}

export class AnnotationView extends ItemView {
  private frozen = false;
  private currentItemKey: string | null = null;
  private itemInfo: ZoteroItemInfo | null = null;
  private annotations: ZoteroAnnotation[] = [];
  /** Opens a URL in the OS, bypassing any window.open intercepts */
  openExternal: (url: string) => void = (url) => window.open(url);
  /** Path to the Zotero data directory */
  zoteroDataDir = "";

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_ZOTERO_ANNOTATIONS;
  }

  getDisplayText(): string {
    return "Zotero annotations";
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
    void this.render();
  }

  setAnnotations(
    itemKey: string,
    itemInfo: ZoteroItemInfo | null,
    annotations: ZoteroAnnotation[]
  ): void {
    if (this.frozen) return;
    this.currentItemKey = itemKey;
    this.itemInfo = itemInfo;
    this.annotations = annotations;
    void this.render();
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
      text: "Loading annotations\u2026",
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
      text: "Place your cursor on a Zotero link to see annotations.",
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

  // eslint-disable-next-line @typescript-eslint/require-await -- onOpen is required by ItemView to be async but this implementation has no async work
  async onOpen(): Promise<void> {
    this.showEmpty();
  }

  async onClose(): Promise<void> {
    // cleanup handled by Obsidian
  }

  private renderToolbar(container: HTMLElement): void {
    const toolbar = container.createEl("div", { cls: "zotero-annot-toolbar" });

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

  private getAnnotationImagePath(annotationKey: string): string {
    return `${this.zoteroDataDir}/cache/library/${annotationKey}.png`;
  }

  private async resolveNoteImages(noteEl: HTMLElement): Promise<void> {
    const imgs = noteEl.querySelectorAll("img[data-annotation]");
    for (const img of Array.from(imgs)) {
      try {
        const annotation = JSON.parse(
          decodeURIComponent(img.getAttribute("data-annotation") || "")
        ) as { annotationKey?: string } | null;
        const annotKey = annotation?.annotationKey;
        if (annotKey) {
          const base64 = await readFileAsBase64(this.getAnnotationImagePath(annotKey));
          if (base64) {
            img.setAttribute("src", `data:image/png;base64,${base64}`);
          }
        }
      } catch {
        // ignore malformed annotation data
      }
    }
  }

  private async render(): Promise<void> {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();

    this.renderToolbar(container);

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

      // Abstract with toggle (collapsed by default)
      if (this.itemInfo.abstractNote) {
        const abstractWrapper = header.createEl("div", { cls: "zotero-annot-abstract-wrapper" });
        const toggleBtn = abstractWrapper.createEl("button", {
          cls: "zotero-annot-abstract-toggle",
          text: "Abstract",
        });
        setIcon(toggleBtn, "chevron-right");
        const abstractText = abstractWrapper.createEl("div", {
          cls: "zotero-annot-abstract is-collapsed",
          text: this.itemInfo.abstractNote,
        });
        toggleBtn.addEventListener("click", () => {
          const collapsed = abstractText.hasClass("is-collapsed");
          abstractText.toggleClass("is-collapsed", !collapsed);
          toggleBtn.empty();
          setIcon(toggleBtn, collapsed ? "chevron-down" : "chevron-right");
          toggleBtn.appendText(" Abstract");
        });
      }

      // Notes with toggle (expanded by default)
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
          noteEl.appendChild(sanitizeHTMLToDom(note.html));
          await this.resolveNoteImages(noteEl);
        }
        toggleBtn.addEventListener("click", () => {
          const collapsed = notesContent.hasClass("is-collapsed");
          notesContent.toggleClass("is-collapsed", !collapsed);
          toggleBtn.empty();
          setIcon(toggleBtn, collapsed ? "chevron-down" : "chevron-right");
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

    container.createEl("div", {
      cls: "zotero-annot-count",
      text: `${this.annotations.length} annotation${this.annotations.length > 1 ? "s" : ""}`,
    });

    const list = container.createEl("div", { cls: "zotero-annot-list" });

    let currentPage = "";
    for (const annot of this.annotations) {
      if (annot.pageLabel && annot.pageLabel !== currentPage) {
        currentPage = annot.pageLabel;
        list.createEl("div", {
          cls: "zotero-annot-page-header",
          text: `Page ${currentPage}`,
        });
      }

      const card = list.createEl("div", {
        cls: "zotero-annot-card",
        attr: { style: `border-left-color: ${annot.color}` },
      });

      if (annot.type !== "highlight") {
        card.createEl("span", {
          cls: "zotero-annot-type-badge",
          text: annot.type,
        });
      }

      // Image annotation from cache
      if (annot.type === "image") {
        const imgContainer = card.createEl("div", { cls: "zotero-annot-image-container" });
        const base64 = await readFileAsBase64(this.getAnnotationImagePath(annot.key));
        if (base64) {
          imgContainer.createEl("img", {
            cls: "zotero-annot-image",
            attr: { src: `data:image/png;base64,${base64}` },
          });
        } else {
          const placeholder = imgContainer.createEl("div", { cls: "zotero-annot-image-placeholder" });
          setIcon(placeholder, "image");
          placeholder.appendText(" Area highlight (image not cached)");
        }
      } else if (annot.text) {
        const textEl = card.createEl("div", { cls: "zotero-annot-text" });
        textEl.createEl("span", { text: annot.text });
      }

      if (annot.comment) {
        const commentEl = card.createEl("div", { cls: "zotero-annot-comment" });
        commentEl.createEl("em", { text: annot.comment });
      }

      if (annot.tags.length > 0) {
        const tagsEl = card.createEl("div", { cls: "zotero-annot-tags" });
        for (const tag of annot.tags) {
          tagsEl.createEl("span", { cls: "zotero-annot-tag", text: `#${tag}` });
        }
      }

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
