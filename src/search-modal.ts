/**
 * Searches the Zotero library from Obsidian and inserts a link to an item in
 * one click: each result offers every link label of the settings.
 * Fields narrow the search: `author:`, `title:`, `year:` (`2017`, `2017-2019`),
 * `tag:`, `type:`; `-` before a field excludes what it matches.
 */
import { App, Modal, Setting, debounce } from "obsidian";
import { ZoteroApiItem, itemSummary, searchLibrary } from "./zotero-client";
import { fillTemplate, isEmptyQuery, parseLibraryQuery, templateValues } from "./zotero-search";
import { itemBacklink } from "./note-format";

export interface SearchActions {
  /** Label templates of the links, the first used by Enter */
  labels: string[];
  /** Inserts the text of an item where the cursor is (false: no editor) */
  insert(text: string): boolean;
  /** Shows the item in the sidebar */
  show(key: string): void;
  /** Selects the item in Zotero */
  openInZotero(key: string): void;
}

/** Search results are asked once typing pauses this long */
const SEARCH_DELAY_MS = 300;

const HELP =
  'Words match titles, authors and years. Narrow with author:, title:, year:2017-2019, tag:"to read", type:book; ' +
  "- before a field excludes. Enter inserts the first result.";

export class ZoteroSearchModal extends Modal {
  private resultsEl!: HTMLElement;
  /** The query of the results shown, and the results */
  private shown: { input: string; items: ZoteroApiItem[] } | null = null;
  private searchId = 0;

  constructor(
    app: App,
    private actions: SearchActions,
    private initialQuery = ""
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle("Search Zotero");
    this.modalEl.addClass("zotero-annot-search");
    const { contentEl } = this;
    contentEl.createEl("p", { cls: "setting-item-description", text: HELP });

    let input!: HTMLInputElement;
    const later = debounce((value: string) => void this.search(value), SEARCH_DELAY_MS, true);
    new Setting(contentEl).setClass("zotero-annot-search-input").addSearch((s) => {
      s.setPlaceholder("attention author:vaswani year:2017").setValue(this.initialQuery);
      input = s.inputEl;
      s.onChange((value) => later(value));
      s.inputEl.addEventListener("keydown", (evt) => {
        if (evt.key !== "Enter" || evt.isComposing) return;
        evt.preventDefault();
        const value = s.getValue();
        const first = this.shown?.input === value ? this.shown.items[0] : undefined;
        if (first) this.insert(first, this.actions.labels[0]);
        else void this.search(value);
      });
    });

    this.resultsEl = contentEl.createDiv({ cls: "zotero-annot-search-results" });
    window.setTimeout(() => {
      input.focus();
      input.select();
    }, 0);
    if (this.initialQuery) void this.search(this.initialQuery);
  }

  onClose(): void {
    this.searchId++;
    this.contentEl.empty();
  }

  private async search(input: string): Promise<void> {
    const id = ++this.searchId;
    const query = parseLibraryQuery(input);
    if (isEmptyQuery(query)) {
      this.shown = null;
      this.resultsEl.empty();
      return;
    }
    this.resultsEl.setText("Searching…");
    try {
      const items = (await searchLibrary(query)).filter((item) => query.checks.every((check) => check(item)));
      if (id !== this.searchId) return;
      this.shown = { input, items };
      this.renderResults(items);
    } catch (e) {
      if (id === this.searchId) this.resultsEl.setText(`Could not search Zotero (is it running?): ${(e as Error).message}`);
    }
  }

  private renderResults(items: ZoteroApiItem[]): void {
    this.resultsEl.empty();
    if (items.length === 0) {
      this.resultsEl.setText("No item matches.");
      return;
    }
    for (const item of items) {
      const summary = itemSummary(item);
      const tags = Array.isArray(item.data.tags) ? (item.data.tags as { tag: string }[]).map((t) => t.tag) : [];
      const details = [summary.creators, summary.year, summary.itemType, tags.length ? `#${tags.join(" #")}` : ""];
      const setting = new Setting(this.resultsEl).setName(summary.title).setDesc(details.filter(Boolean).join(" · "));
      // Each label the link can have
      const labels = setting.descEl.createDiv({ cls: "zotero-annot-search-labels" });
      for (const template of this.actions.labels) {
        const text = fillTemplate(template, templateValues(item));
        labels
          .createEl("button", { cls: "zotero-annot-search-label", text, attr: { "aria-label": `Insert [${text}]` } })
          .addEventListener("click", () => this.insert(item, template));
      }
      setting
        .addExtraButton((b) =>
          b
            .setIcon("panel-right")
            .setTooltip("Show in the sidebar")
            .onClick(() => {
              this.close();
              this.actions.show(item.key);
            })
        )
        .addExtraButton((b) =>
          b
            .setIcon("external-link")
            .setTooltip("Select in Zotero")
            .onClick(() => this.actions.openInZotero(item.key))
        );
    }
  }

  /** Inserts a link to the item labelled with a template, else shows it in the sidebar (no editor, no template) */
  private insert(item: ZoteroApiItem, template: string | undefined): void {
    this.close();
    const label = template && fillTemplate(template, templateValues(item));
    if (!label || !this.actions.insert(`[${label}](${itemBacklink(item.key)})`)) this.actions.show(item.key);
  }
}
