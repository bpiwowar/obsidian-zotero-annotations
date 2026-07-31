import {
  ItemView,
  WorkspaceLeaf,
  setIcon,
  sanitizeHTMLToDom,
  renderMath,
  finishRenderMath,
} from "obsidian";
import { ZoteroAnnotation, ZoteroItemInfo, ZoteroRelatedItem } from "./zotero-client";
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
  /** Items visited by following Related links, oldest first */
  private history: Array<{ key: string; title: string }> = [];
  /** Opens a URL in the OS, bypassing any window.open intercepts */
  openExternal: (url: string) => void = (url) => window.open(url);
  /** Loads another item into this view (used by the Related section) */
  onNavigate: (itemKey: string) => void = () => undefined;
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

  /** Follows a Related link, remembering the current item so Back can return to it. */
  private navigateTo(itemKey: string): void {
    if (this.currentItemKey) {
      this.history.push({
        key: this.currentItemKey,
        title: this.itemInfo?.title || this.currentItemKey,
      });
    }
    this.onNavigate(itemKey);
  }

  private goBack(): void {
    const previous = this.history.pop();
    if (previous) this.onNavigate(previous.key);
  }

  /**
   * A cursor-driven move to a different item ends the Related browsing trail;
   * explicit navigation (force) keeps it.
   */
  private resetHistoryIfNeeded(itemKey: string | null, force: boolean): void {
    if (!force && itemKey !== this.currentItemKey) this.history = [];
  }

  setAnnotations(
    itemKey: string,
    itemInfo: ZoteroItemInfo | null,
    annotations: ZoteroAnnotation[],
    force = false
  ): void {
    if (this.frozen && !force) return;
    this.resetHistoryIfNeeded(itemKey, force);
    this.currentItemKey = itemKey;
    this.itemInfo = itemInfo;
    this.annotations = annotations;
    void this.render();
  }

  showLoading(itemKey: string, force = false): void {
    if (this.frozen && !force) return;
    this.resetHistoryIfNeeded(itemKey, force);
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
    this.history = [];
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

  showError(message: string, force = false): void {
    if (this.frozen && !force) return;
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

    const previous = this.history[this.history.length - 1];
    if (previous) {
      const backBtn = toolbar.createEl("button", {
        cls: "zotero-annot-back-btn",
        attr: { "aria-label": `Back to "${previous.title}"` },
      });
      setIcon(backBtn, "arrow-left");
      backBtn.createSpan({ cls: "zotero-annot-back-label", text: previous.title });
      backBtn.addEventListener("click", () => this.goBack());
    }

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

  /** Creates a labelled toggle + content div; returns the content div to fill in. */
  private createSection(
    parent: HTMLElement,
    label: string,
    contentCls: string,
    expanded: boolean
  ): HTMLElement {
    const wrapper = parent.createDiv({ cls: "zotero-annot-section" });
    const toggleBtn = wrapper.createEl("button", { cls: "zotero-annot-section-toggle" });
    const iconEl = toggleBtn.createSpan({ cls: "zotero-annot-section-icon" });
    setIcon(iconEl, expanded ? "chevron-down" : "chevron-right");
    toggleBtn.createSpan({ cls: "zotero-annot-section-label", text: label });
    const content = wrapper.createDiv({ cls: contentCls });
    content.toggleClass("is-collapsed", !expanded);
    toggleBtn.addEventListener("click", () => {
      const collapsed = content.hasClass("is-collapsed");
      content.toggleClass("is-collapsed", !collapsed);
      iconEl.empty();
      setIcon(iconEl, collapsed ? "chevron-down" : "chevron-right");
    });
    return content;
  }

  private renderRelated(parent: HTMLElement, related: ZoteroRelatedItem[]): void {
    const content = this.createSection(
      parent,
      `Related (${related.length})`,
      "zotero-annot-related",
      false
    );

    for (const rel of related) {
      const row = content.createDiv({
        cls: "zotero-annot-related-item",
        attr: { "aria-label": "Show annotations for this item" },
      });
      const main = row.createDiv({ cls: "zotero-annot-related-main" });
      main.createDiv({ cls: "zotero-annot-related-title", text: rel.title });
      const meta = [rel.creators, rel.year].filter(Boolean).join(" · ");
      if (meta) {
        main.createDiv({ cls: "zotero-annot-related-meta", text: meta });
      }
      row.addEventListener("click", () => this.navigateTo(rel.key));

      const openBtn = row.createSpan({
        cls: "zotero-annot-related-open",
        attr: { "aria-label": "Open in Zotero" },
      });
      setIcon(openBtn, "external-link");
      openBtn.addEventListener("click", (evt) => {
        evt.stopPropagation();
        this.openExternal(`zotero://select/library/items/${rel.key}`);
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
        const abstractText = this.createSection(
          header,
          "Abstract",
          "zotero-annot-abstract",
          false
        );
        abstractText.setText(this.itemInfo.abstractNote);
      }

      // Related items with toggle (collapsed by default)
      if (this.itemInfo.related.length > 0) {
        this.renderRelated(header, this.itemInfo.related);
      }

      // Notes with toggle (expanded by default)
      if (this.itemInfo.notes.length > 0) {
        const notesContent = this.createSection(
          header,
          `Notes (${this.itemInfo.notes.length})`,
          "zotero-annot-notes",
          true
        );
        let anyMath = false;
        for (const note of this.itemInfo.notes) {
          const noteEl = notesContent.createDiv({ cls: "zotero-annot-note" });
          noteEl.appendChild(sanitizeHTMLToDom(note.html));
          await this.resolveNoteImages(noteEl);
          if (renderMathInElement(noteEl)) anyMath = true;
        }
        if (anyMath) await finishRenderMath();
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
