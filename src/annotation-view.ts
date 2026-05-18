import {
  ItemView,
  WorkspaceLeaf,
  setIcon,
  sanitizeHTMLToDom,
  renderMath,
  finishRenderMath,
} from "obsidian";
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

// Zotero wraps math in <span class="math">$...$</span> (inline) or <pre class="math">$$...$$</pre> (display).
function stripMathDelimiters(raw: string): { expr: string; display: boolean } {
  const trimmed = raw.trim();
  if (trimmed.startsWith("$$") && trimmed.endsWith("$$")) {
    return { expr: trimmed.slice(2, -2).trim(), display: true };
  }
  if (trimmed.startsWith("\\[") && trimmed.endsWith("\\]")) {
    return { expr: trimmed.slice(2, -2).trim(), display: true };
  }
  if (trimmed.startsWith("\\(") && trimmed.endsWith("\\)")) {
    return { expr: trimmed.slice(2, -2).trim(), display: false };
  }
  if (trimmed.startsWith("$") && trimmed.endsWith("$")) {
    return { expr: trimmed.slice(1, -1).trim(), display: false };
  }
  return { expr: trimmed, display: false };
}

function renderMathInElement(root: HTMLElement): boolean {
  const mathNodes = root.querySelectorAll(".math, pre.math, span.math");
  if (mathNodes.length === 0) return false;
  for (const node of Array.from(mathNodes)) {
    const raw = node.textContent || "";
    const { expr, display } = stripMathDelimiters(raw);
    // <pre class="math"> always renders as display math
    const isDisplay = display || node.tagName === "PRE";
    if (!expr) continue;
    const mathEl = renderMath(expr, isDisplay);
    if (isDisplay) {
      const wrapper = document.createElement("div");
      wrapper.addClass("zotero-annot-math-display");
      wrapper.appendChild(mathEl);
      node.replaceWith(wrapper);
    } else {
      node.replaceWith(mathEl);
    }
  }
  return true;
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
    container.createDiv({
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
    container.createDiv({
      cls: "zotero-annot-empty",
      text: "Place your cursor on a Zotero link to see annotations.",
    });
  }

  showError(message: string): void {
    if (this.frozen) return;
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    this.renderToolbar(container);
    container.createDiv({
      cls: "zotero-annot-error",
      text: message,
    });
  }

  async onOpen(): Promise<void> {
    this.showEmpty();
  }

  async onClose(): Promise<void> {
    // cleanup handled by Obsidian
  }

  private renderToolbar(container: HTMLElement): void {
    const toolbar = container.createDiv({ cls: "zotero-annot-toolbar" });

    const freezeBtn = toolbar.createEl("button", {
      cls: `zotero-annot-freeze-btn ${this.frozen ? "is-active" : ""}`,
      attr: { "aria-label": this.frozen ? "Unpin (auto-update)" : "Pin (freeze current)" },
    });
    setIcon(freezeBtn, this.frozen ? "pin-off" : "pin");
    freezeBtn.createSpan({
      text: this.frozen ? " Pinned" : " Auto",
      cls: "zotero-annot-freeze-label",
    });
    freezeBtn.addEventListener("click", () => this.toggleFreeze());

    if (this.currentItemKey) {
      const linkBtn = toolbar.createSpan({
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
      const header = container.createDiv({ cls: "zotero-annot-header" });
      header.createDiv({ cls: "zotero-annot-title", text: this.itemInfo.title });
      if (this.itemInfo.creators) {
        header.createDiv({
          cls: "zotero-annot-creators",
          text: this.itemInfo.creators,
        });
      }
      if (this.itemInfo.date) {
        header.createSpan({
          cls: "zotero-annot-date",
          text: this.itemInfo.date,
        });
      }

      // Abstract with toggle (collapsed by default)
      if (this.itemInfo.abstractNote) {
        const abstractWrapper = header.createDiv({ cls: "zotero-annot-section" });
        const toggleBtn = abstractWrapper.createEl("button", {
          cls: "zotero-annot-section-toggle",
        });
        const iconEl = toggleBtn.createSpan({ cls: "zotero-annot-section-icon" });
        setIcon(iconEl, "chevron-right");
        toggleBtn.createSpan({ cls: "zotero-annot-section-label", text: "Abstract" });
        const abstractText = abstractWrapper.createDiv({
          cls: "zotero-annot-abstract is-collapsed",
          text: this.itemInfo.abstractNote,
        });
        toggleBtn.addEventListener("click", () => {
          const collapsed = abstractText.hasClass("is-collapsed");
          abstractText.toggleClass("is-collapsed", !collapsed);
          iconEl.empty();
          setIcon(iconEl, collapsed ? "chevron-down" : "chevron-right");
        });
      }

      // Notes with toggle (expanded by default)
      if (this.itemInfo.notes.length > 0) {
        const notesWrapper = header.createDiv({ cls: "zotero-annot-section" });
        const toggleBtn = notesWrapper.createEl("button", {
          cls: "zotero-annot-section-toggle",
        });
        const iconEl = toggleBtn.createSpan({ cls: "zotero-annot-section-icon" });
        setIcon(iconEl, "chevron-down");
        toggleBtn.createSpan({
          cls: "zotero-annot-section-label",
          text: `Notes (${this.itemInfo.notes.length})`,
        });
        const notesContent = notesWrapper.createDiv({ cls: "zotero-annot-notes" });
        let anyMath = false;
        for (const note of this.itemInfo.notes) {
          const noteEl = notesContent.createDiv({ cls: "zotero-annot-note" });
          noteEl.appendChild(sanitizeHTMLToDom(note.html));
          await this.resolveNoteImages(noteEl);
          if (renderMathInElement(noteEl)) anyMath = true;
        }
        if (anyMath) await finishRenderMath();
        toggleBtn.addEventListener("click", () => {
          const collapsed = notesContent.hasClass("is-collapsed");
          notesContent.toggleClass("is-collapsed", !collapsed);
          iconEl.empty();
          setIcon(iconEl, collapsed ? "chevron-down" : "chevron-right");
        });
      }
    }

    if (this.annotations.length === 0) {
      container.createDiv({
        cls: "zotero-annot-empty",
        text: "No annotations found for this item.",
      });
      return;
    }

    container.createDiv({
      cls: "zotero-annot-count",
      text: `${this.annotations.length} annotation${this.annotations.length > 1 ? "s" : ""}`,
    });

    const list = container.createDiv({ cls: "zotero-annot-list" });

    let currentPage = "";
    for (const annot of this.annotations) {
      if (annot.pageLabel && annot.pageLabel !== currentPage) {
        currentPage = annot.pageLabel;
        list.createDiv({
          cls: "zotero-annot-page-header",
          text: `Page ${currentPage}`,
        });
      }

      const card = list.createDiv({
        cls: "zotero-annot-card",
        attr: { style: `border-left-color: ${annot.color}` },
      });

      if (annot.type !== "highlight") {
        card.createSpan({
          cls: "zotero-annot-type-badge",
          text: annot.type,
        });
      }

      // Image annotation from cache
      if (annot.type === "image") {
        const imgContainer = card.createDiv({ cls: "zotero-annot-image-container" });
        const base64 = await readFileAsBase64(this.getAnnotationImagePath(annot.key));
        if (base64) {
          imgContainer.createEl("img", {
            cls: "zotero-annot-image",
            attr: { src: `data:image/png;base64,${base64}` },
          });
        } else {
          const placeholder = imgContainer.createDiv({ cls: "zotero-annot-image-placeholder" });
          setIcon(placeholder, "image");
          placeholder.appendText(" Area highlight (image not cached)");
        }
      } else if (annot.text) {
        const textEl = card.createDiv({ cls: "zotero-annot-text" });
        textEl.createSpan({ text: annot.text });
      }

      if (annot.comment) {
        const commentEl = card.createDiv({ cls: "zotero-annot-comment" });
        commentEl.createEl("em", { text: annot.comment });
      }

      if (annot.tags.length > 0) {
        const tagsEl = card.createDiv({ cls: "zotero-annot-tags" });
        for (const tag of annot.tags) {
          tagsEl.createSpan({ cls: "zotero-annot-tag", text: `#${tag}` });
        }
      }

      const openLink = card.createSpan({
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
