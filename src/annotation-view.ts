import {
  ItemView,
  WorkspaceLeaf,
  setIcon,
  sanitizeHTMLToDom,
  renderMath,
  finishRenderMath,
} from "obsidian";
import { ZoteroAnnotation, ZoteroItemInfo, ZoteroItemSummary } from "./zotero-client";
import { Mention } from "./mention-index";
import { OutlineSection, countPapers } from "./paper-outline";
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

/** "folder/sub/Note.md" -> "Note (folder/sub)" */
function displayPath(path: string): string {
  const name = path.split("/").pop() || path;
  const base = name.replace(/\.md$/i, "");
  const folder = path.slice(0, path.length - name.length).replace(/\/$/, "");
  return folder ? `${base}  \u00b7  ${folder}` : base;
}

/** The papers of one note, laid out along its heading structure. */
export interface PaperList {
  /** Vault-relative path of the note */
  path: string;
  /** Note name, for the header */
  name: string;
  /** Root of the heading tree; its own papers are the ones before any heading */
  root: OutlineSection;
}

/**
 * A place the Back button can return to: either an item whose annotations get
 * re-loaded, or the paper list of a note, which is kept as-is.
 */
type HistoryEntry =
  | { kind: "item"; title: string; key: string }
  | { kind: "papers"; title: string; list: PaperList };

export class AnnotationView extends ItemView {
  private frozen = false;
  /** "papers" while the note's paper list is on screen instead of an item */
  private mode: "item" | "papers" = "item";
  private paperList: PaperList | null = null;
  private currentItemKey: string | null = null;
  private itemInfo: ZoteroItemInfo | null = null;
  private annotations: ZoteroAnnotation[] = [];
  /** Incremented on every render, so async section fills can detect being stale */
  private renderToken = 0;
  /** Elements of the Mentions section of the current render, for in-place refresh */
  private mentionEls: { content: HTMLElement; label: HTMLElement; itemKey: string } | null = null;
  /** Views visited by following Related/paper links, oldest first */
  private history: HistoryEntry[] = [];
  /** Opens a URL in the OS, bypassing any window.open intercepts */
  openExternal: (url: string) => void = (url) => window.open(url);
  /** Loads another item into this view (used by the Related section) */
  onNavigate: (itemKey: string) => void = () => undefined;
  /** Looks up the vault notes linking to an item (used by the Mentions section) */
  mentionProvider: ((itemKey: string) => Promise<Mention[]>) | null = null;
  /** Opens a vault note at the line of a mention */
  openMention: (mention: Mention) => void = () => undefined;
  /** Builds the paper list of the note currently being edited */
  onListPapers: () => void = () => undefined;
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

  /** True when the view must not follow the cursor: pinned, or showing a paper list. */
  ignoresCursor(): boolean {
    return this.frozen || this.mode === "papers";
  }

  isShowingPapers(): boolean {
    return this.mode === "papers";
  }

  getCurrentItemKey(): string | null {
    return this.currentItemKey;
  }

  toggleFreeze(): void {
    this.frozen = !this.frozen;
    void this.render();
  }

  /** Follows a Related/paper link, remembering the current view so Back returns to it. */
  private navigateTo(itemKey: string): void {
    const current = this.snapshot();
    if (current) this.history.push(current);
    this.onNavigate(itemKey);
  }

  /** The current view as a history entry, or null if there is nothing to return to. */
  private snapshot(): HistoryEntry | null {
    if (this.mode === "papers" && this.paperList) {
      return { kind: "papers", title: this.paperList.name, list: this.paperList };
    }
    if (this.mode === "item" && this.currentItemKey) {
      return {
        kind: "item",
        key: this.currentItemKey,
        title: this.itemInfo?.title || this.currentItemKey,
      };
    }
    return null;
  }

  private goBack(): void {
    const previous = this.history.pop();
    if (!previous) return;
    if (previous.kind === "papers") {
      this.setPaperList(previous.list);
    } else {
      this.mode = "item";
      this.onNavigate(previous.key);
    }
  }

  /**
   * True when an unforced (cursor-driven) update must be ignored: either the
   * sidebar is pinned, or the paper list is on screen.
   */
  private holds(force: boolean): boolean {
    return !force && this.ignoresCursor();
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
    if (this.holds(force)) return;
    this.mode = "item";
    this.resetHistoryIfNeeded(itemKey, force);
    this.currentItemKey = itemKey;
    this.itemInfo = itemInfo;
    this.annotations = annotations;
    void this.render();
  }

  showLoading(itemKey: string, force = false): void {
    if (this.holds(force)) return;
    this.mode = "item";
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
    if (this.holds(false)) return;
    this.mode = "item";
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
    if (this.holds(force)) return;
    this.mode = "item";
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    this.renderToolbar(container);
    container.createDiv({
      cls: "zotero-annot-error",
      text: message,
    });
  }

  /** Shows the papers of a note, grouped by its headings. */
  setPaperList(list: PaperList): void {
    this.mode = "papers";
    this.paperList = list;
    void this.render();
  }

  /** Placeholder shown while the papers of `name` are being resolved in Zotero. */
  showPaperListLoading(name: string): void {
    this.mode = "papers";
    this.paperList = null;
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    this.renderToken++;
    this.mentionEls = null;
    this.renderToolbar(container);
    container.createDiv({
      cls: "zotero-annot-loading",
      text: `Looking up the papers of "${name}"\u2026`,
    });
  }

  /** Leaves the paper list and goes back to following the cursor. */
  private closePaperList(): void {
    this.mode = "item";
    this.paperList = null;
    this.history = [];
    if (this.currentItemKey) void this.render();
    else this.showEmpty();
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

    const papersBtn = toolbar.createEl("button", {
      cls: `zotero-annot-papers-btn ${this.mode === "papers" ? "is-active" : ""}`,
      attr: {
        "aria-label":
          this.mode === "papers"
            ? "Back to the annotations of the item under the cursor"
            : "List the papers cited in the current note",
      },
    });
    setIcon(papersBtn, "list");
    papersBtn.createSpan({ text: " Papers", cls: "zotero-annot-papers-label" });
    papersBtn.addEventListener("click", () => {
      if (this.mode === "papers") this.closePaperList();
      else this.onListPapers();
    });

    if (this.mode === "item" && this.currentItemKey) {
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

  /**
   * Creates a labelled toggle + content div.
   * Returns the content div to fill in, and the label span (so sections whose
   * count is only known asynchronously can update their title).
   */
  private createSection(
    parent: HTMLElement,
    label: string,
    contentCls: string,
    expanded: boolean
  ): { content: HTMLElement; label: HTMLElement } {
    const wrapper = parent.createDiv({ cls: "zotero-annot-section" });
    const toggleBtn = wrapper.createEl("button", { cls: "zotero-annot-section-toggle" });
    const iconEl = toggleBtn.createSpan({ cls: "zotero-annot-section-icon" });
    setIcon(iconEl, expanded ? "chevron-down" : "chevron-right");
    const labelEl = toggleBtn.createSpan({ cls: "zotero-annot-section-label", text: label });
    const content = wrapper.createDiv({ cls: contentCls });
    content.toggleClass("is-collapsed", !expanded);
    toggleBtn.addEventListener("click", () => {
      const collapsed = content.hasClass("is-collapsed");
      content.toggleClass("is-collapsed", !collapsed);
      iconEl.empty();
      setIcon(iconEl, collapsed ? "chevron-down" : "chevron-right");
    });
    return { content, label: labelEl };
  }

  private renderRelated(parent: HTMLElement, related: ZoteroItemSummary[]): void {
    const { content } = this.createSection(
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

  /**
   * Vault notes linking to this item. The list comes from an index that may
   * still be building, so the section renders a placeholder and fills in later.
   */
  private renderMentions(parent: HTMLElement, itemKey: string): void {
    const { content, label } = this.createSection(
      parent,
      "Mentioned in\u2026",
      "zotero-annot-mentions",
      false
    );
    this.mentionEls = { content, label, itemKey };
    void this.fillMentions(content, label, itemKey, this.renderToken);
  }

  /** Re-reads the mention index for the item on screen (used when the vault changes). */
  refreshMentions(): void {
    const els = this.mentionEls;
    if (!els) return;
    void this.fillMentions(els.content, els.label, els.itemKey, this.renderToken);
  }

  private async fillMentions(
    content: HTMLElement,
    label: HTMLElement,
    itemKey: string,
    token: number
  ): Promise<void> {
    const provider = this.mentionProvider;
    if (!provider) return;

    if (content.childElementCount === 0) {
      content.createDiv({ cls: "zotero-annot-mentions-loading", text: "Searching vault\u2026" });
    }

    const mentions = await provider(itemKey);
    // The view may have moved on to another item while the index was building
    if (token !== this.renderToken) return;

    content.empty();
    label.setText(`Mentioned in (${mentions.length})`);

    if (mentions.length === 0) {
      content.createDiv({
        cls: "zotero-annot-mentions-empty",
        text: "No note in this vault links to this item.",
      });
      return;
    }

    let currentPath: string | null = null;
    let group: HTMLElement | null = null;
    for (const mention of mentions) {
      if (mention.path !== currentPath) {
        currentPath = mention.path;
        group = content.createDiv({ cls: "zotero-annot-mention-file" });
        const pathEl = group.createDiv({
          cls: "zotero-annot-mention-path",
          text: displayPath(mention.path),
          attr: { "aria-label": mention.path },
        });
        const first = mention;
        pathEl.addEventListener("click", () => this.openMention(first));
      }
      const row = (group as HTMLElement).createDiv({
        cls: "zotero-annot-mention-line",
        attr: { "aria-label": `Line ${mention.line + 1}` },
      });
      row.createSpan({ cls: "zotero-annot-mention-lineno", text: `${mention.line + 1}` });
      row.createSpan({ cls: "zotero-annot-mention-text", text: mention.text });
      row.addEventListener("click", () => this.openMention(mention));
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

  /**
   * The papers of a note, following its heading structure: each section shows
   * the papers cited under it, then its sub-sections.
   */
  private renderPaperList(container: HTMLElement, list: PaperList): void {
    const header = container.createDiv({ cls: "zotero-annot-header" });
    header.createDiv({ cls: "zotero-annot-title", text: `Papers in "${list.name}"` });
    const total = countPapers(list.root);
    header.createDiv({
      cls: "zotero-annot-creators",
      text: total === 0 ? "No Zotero link in this note" : `${total} paper${total > 1 ? "s" : ""}`,
    });

    if (total === 0) return;
    const outline = container.createDiv({ cls: "zotero-annot-paper-outline" });
    this.renderOutlineSection(outline, list, list.root);
  }

  private renderOutlineSection(parent: HTMLElement, list: PaperList, section: OutlineSection): void {
    let body = parent;
    if (section.heading !== null) {
      const headingEl = parent.createDiv({
        cls: `zotero-annot-paper-heading zotero-annot-paper-heading-h${section.level}`,
        attr: { "aria-label": "Go to this heading" },
      });
      headingEl.createSpan({ cls: "zotero-annot-paper-hash", text: "#".repeat(section.level) });
      headingEl.createSpan({ text: section.heading });
      headingEl.addEventListener("click", () =>
        this.openMention({ path: list.path, line: section.line, text: section.heading || "" })
      );
      body = parent.createDiv({ cls: "zotero-annot-paper-group" });
    }

    for (const { paper, lines } of section.papers) {
      const row = body.createDiv({
        cls: "zotero-annot-paper-item",
        attr: { "aria-label": "Show annotations for this paper" },
      });
      const main = row.createDiv({ cls: "zotero-annot-paper-main" });
      main.createDiv({ cls: "zotero-annot-paper-title", text: paper.title });
      const meta = [paper.creators, paper.year].filter(Boolean).join(" \u00b7 ");
      if (meta) main.createDiv({ cls: "zotero-annot-paper-meta", text: meta });

      const linesEl = main.createDiv({ cls: "zotero-annot-paper-lines" });
      for (const line of lines) {
        const lineEl = linesEl.createSpan({
          cls: "zotero-annot-paper-line",
          text: `l. ${line + 1}`,
          attr: { "aria-label": `Go to line ${line + 1}` },
        });
        lineEl.addEventListener("click", (evt) => {
          evt.stopPropagation();
          this.openMention({ path: list.path, line, text: "" });
        });
      }

      row.addEventListener("click", () => this.navigateTo(paper.key));

      const openBtn = row.createSpan({
        cls: "zotero-annot-paper-open",
        attr: { "aria-label": "Open in Zotero" },
      });
      setIcon(openBtn, "external-link");
      openBtn.addEventListener("click", (evt) => {
        evt.stopPropagation();
        this.openExternal(`zotero://select/library/items/${paper.key}`);
      });
    }

    for (const child of section.children) this.renderOutlineSection(body, list, child);
  }

  private async render(): Promise<void> {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    this.renderToken++;
    this.mentionEls = null;

    this.renderToolbar(container);

    if (this.mode === "papers") {
      if (this.paperList) this.renderPaperList(container, this.paperList);
      return;
    }

    if (this.itemInfo || this.currentItemKey) {
      const header = container.createDiv({ cls: "zotero-annot-header" });
      if (this.itemInfo) {
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
          const { content: abstractText } = this.createSection(
            header,
            "Abstract",
            "zotero-annot-abstract",
            false
          );
          abstractText.setText(this.itemInfo.abstractNote);
        }
      }

      // Vault locations linking to this item
      if (this.currentItemKey) {
        this.renderMentions(header, this.currentItemKey);
      }

      if (this.itemInfo) {
        // Related items with toggle (collapsed by default)
        if (this.itemInfo.related.length > 0) {
          this.renderRelated(header, this.itemInfo.related);
        }

        // Notes with toggle (expanded by default)
        if (this.itemInfo.notes.length > 0) {
          const { content: notesContent } = this.createSection(
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
