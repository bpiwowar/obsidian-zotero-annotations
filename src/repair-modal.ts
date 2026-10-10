/**
 * Report of a repair of links to dead Zotero items (see `item-recovery.ts`):
 * the items relinked to the item Zotero merged them into, then the others,
 * each with what is known of it (Zotero's trash, its literature note), the
 * notes linking to it, and a search of the library to pick the item its
 * links should point at. The search combines the queries the user selects
 * (title, first author and year, text of the links, or typed); it runs when
 * the report opens in automatic mode, otherwise with "Search all".
 */
import { App, Modal, Setting } from "obsidian";
import { DeadItem } from "./item-recovery";
import { Mention } from "./mention-index";
import { ZoteroItemSummary } from "./zotero-client";

/** What relinking an item changed */
export interface RelinkResult {
  /** Notes whose links changed */
  notes: number;
  /** The item's literature note: moved to the new item, or kept (the new item has one already) */
  literature: { path: string; moved: boolean } | null;
}

export interface RepairEntry {
  dead: DeadItem;
  /** Key of the item most like it, if any */
  guess: string | null;
  mentions: Mention[];
  /** Searches that may find it (see `searchQueries`) */
  queries: string[];
  /** The queries in use (all of the first ones by default) */
  selected?: string[];
  /** A query typed by hand */
  query?: string;
  /** Results of the last search (kept when the report is reopened) */
  results?: ZoteroItemSummary[];
  /** The item picked for it, once relinked */
  chosen?: { key: string; title: string; result: RelinkResult };
}

/** An item relinked for sure */
export interface RelinkedItem {
  dead: DeadItem;
  key: string;
  newTitle: string;
  result: RelinkResult;
}

/** What a repair did and what is left to review; kept to reopen the report as it was */
export interface RepairReport {
  relinked: RelinkedItem[];
  review: RepairEntry[];
  /** Scroll position when the report was closed */
  scroll?: number;
}

export interface RepairActions {
  search(query: string): Promise<ZoteroItemSummary[]>;
  /** Points the links of `oldKey` at `newKey` */
  relink(oldKey: string, newKey: string): Promise<RelinkResult>;
  openMention(mention: Mention): void;
  openNote(path: string): void;
  showInZotero(key: string): void;
  /** Opens a web page (a search) in the browser */
  openUrl(url: string): void;
  /** Whether items are searched when the report opens (remembered) */
  autoSearch: boolean;
  setAutoSearch(on: boolean): void;
}

/** Notes listed per item */
const MAX_MENTIONS = 5;

/** Search results listed per query */
const MAX_RESULTS = 6;

/** Queries selected by default */
const DEFAULT_QUERIES = 3;

/** Web searches offered for an item: name → URL of a query */
const WEB_SEARCHES: [string, (q: string) => string][] = [
  ["Google Scholar", (q) => `https://scholar.google.com/scholar?q=${encodeURIComponent(q)}`],
  ["Semantic Scholar", (q) => `https://www.semanticscholar.org/search?q=${encodeURIComponent(q)}`],
  ["Google", (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`],
];

/** Authors shown per item */
const MAX_AUTHORS = 3;

function describe(result: RelinkResult): string {
  let text = `${result.notes} note(s) updated`;
  const lit = result.literature;
  if (lit?.moved) text += `; literature note moved: ${lit.path}`;
  else if (lit) text += `; literature note ${lit.path} kept: the new item has one already`;
  return text;
}

export class RepairModal extends Modal {
  /** Searches of the items shown, for "Search all" */
  private searches: (() => Promise<void>)[] = [];

  constructor(
    app: App,
    private report: RepairReport,
    private actions: RepairActions
  ) {
    super(app);
  }

  onOpen(): void {
    const { relinked, review } = this.report;
    this.setTitle(`Zotero link repair: ${relinked.length + review.length} item(s) no longer in Zotero`);
    this.modalEl.addClass("zotero-annot-repair");
    this.searches = [];
    if (relinked.length > 0) {
      this.contentEl.createEl("h3", { text: `Relinked (${relinked.length})` });
      this.contentEl.createEl("p", {
        cls: "setting-item-description",
        text: "Merged in Zotero: their links now point at the item they were merged into.",
      });
      for (const item of relinked) {
        const el = this.contentEl.createDiv({ cls: "zotero-annot-repair-entry" });
        el.createEl("h4", { text: item.dead.title ?? `Item ${item.dead.key}` });
        this.renderDone(el, item.dead.key, item.newTitle, item.key, item.result);
      }
    }
    if (review.length > 0) {
      this.contentEl.createEl("h3", { text: `To review (${review.length})` });
      this.contentEl.createEl("p", {
        cls: "setting-item-description",
        text:
          "Zotero has no record of the item that replaced these. Search for it with what is known of the item " +
          "(select the queries to combine, or type one), then choose it to update every link to the old item in the vault.",
      });
      new Setting(this.contentEl)
        .setName("Search automatically")
        .setDesc("Search for every item when the report opens.")
        .addToggle((t) => t.setValue(this.actions.autoSearch).onChange((on) => this.actions.setAutoSearch(on)))
        .addButton((b) =>
          b.setButtonText("Search all").onClick(async () => {
            b.setDisabled(true);
            for (const search of this.searches) await search();
            b.setDisabled(false);
          })
        );
      for (const entry of review) {
        this.renderEntry(this.contentEl.createDiv({ cls: "zotero-annot-repair-entry" }), entry);
      }
    }
    // Back where it was (results come from the cache, laid out at once)
    const scroll = this.report.scroll;
    if (scroll) window.setTimeout(() => (this.modalEl.scrollTop = scroll), 50);
  }

  onClose(): void {
    this.report.scroll = this.modalEl.scrollTop;
    this.contentEl.empty();
  }

  private renderDone(el: HTMLElement, oldKey: string, title: string, key: string, result: RelinkResult): void {
    el.createDiv({ cls: "zotero-annot-repair-done", text: `${oldKey} → “${title}” (${key})` });
    el.createDiv({ cls: "setting-item-description", text: describe(result) });
  }

  private renderEntry(el: HTMLElement, entry: RepairEntry): void {
    const { dead } = entry;
    el.createEl("h4", { text: dead.title ?? `Item ${dead.key}` });
    if (entry.chosen) {
      this.renderDone(el, dead.key, entry.chosen.title, entry.chosen.key, entry.chosen.result);
      return;
    }

    // What is known of it
    const authors =
      dead.authors.slice(0, MAX_AUTHORS).join(", ") + (dead.authors.length > MAX_AUTHORS ? ", et al." : "");
    const status = dead.trashed ? "in the Zotero trash" : "no longer in Zotero";
    el.createDiv({
      cls: "setting-item-description",
      text: [authors, dead.year, dead.key, status].filter(Boolean).join(" · "),
    });
    const notePath = dead.note;
    if (notePath) {
      const line = el.createDiv({ cls: "setting-item-description" });
      line.appendText("Literature note: ");
      line.createEl("a", { text: notePath.split("/").pop()?.replace(/\.md$/, "") ?? notePath }).addEventListener(
        "click",
        () => {
          this.close();
          this.actions.openNote(notePath);
        }
      );
    }

    // Where it is linked from
    const mentions = el.createEl("ul", { cls: "zotero-annot-repair-mentions" });
    for (const mention of entry.mentions.slice(0, MAX_MENTIONS)) {
      const li = mentions.createEl("li");
      const link = li.createEl("a", { text: `${mention.path.split("/").pop()?.replace(/\.md$/, "")}:${mention.line + 1}` });
      link.addEventListener("click", () => {
        this.close();
        this.actions.openMention(mention);
      });
      li.createSpan({ cls: "zotero-annot-repair-line", text: ` ${mention.text}` });
    }
    if (entry.mentions.length > MAX_MENTIONS) {
      mentions.createEl("li", { text: `… and ${entry.mentions.length - MAX_MENTIONS} more` });
    }

    // The search: the selected queries, or the one typed
    const results = createDiv({ cls: "zotero-annot-repair-results" });
    entry.selected ??= entry.queries.slice(0, DEFAULT_QUERIES);
    const search = async () => {
      const list = entry.query ? [entry.query] : (entry.selected ?? []);
      if (list.length === 0) {
        results.setText("Select or type a query to search.");
        return;
      }
      results.setText("Searching…");
      try {
        const seen = new Set([dead.key]);
        const found: ZoteroItemSummary[] = [];
        for (const query of list) {
          for (const item of (await this.actions.search(query)).slice(0, MAX_RESULTS)) {
            if (!seen.has(item.key)) found.push(item);
            seen.add(item.key);
          }
        }
        // The best match first
        found.sort((a, b) => Number(b.key === entry.guess) - Number(a.key === entry.guess));
        entry.results = found;
        this.renderResults(results, el, entry);
      } catch (e) {
        results.setText(`Search failed: ${(e as Error).message}`);
      }
    };
    this.searches.push(search);

    let input: HTMLInputElement | null = null;
    if (entry.queries.length > 0) {
      const chips = el.createDiv({ cls: "zotero-annot-repair-queries" });
      chips.createSpan({ text: "Search with: " });
      for (const query of entry.queries) {
        const chip = chips.createEl("a", { cls: "zotero-annot-repair-query", text: query });
        chip.toggleClass("is-active", entry.selected.includes(query));
        chip.addEventListener("click", () => {
          const selected = entry.selected ?? [];
          entry.selected = selected.includes(query) ? selected.filter((q) => q !== query) : [...selected, query];
          chip.toggleClass("is-active", entry.selected.includes(query));
          entry.query = undefined;
          if (input) input.value = "";
          void search();
        });
      }
    }
    const typed = (value: string) => {
      entry.query = value.trim() || undefined;
      void search();
    };
    new Setting(el)
      .addSearch((s) => {
        s.setPlaceholder("Or type: title, author, year…").setValue(entry.query ?? "");
        input = s.inputEl;
        s.inputEl.addEventListener("keydown", (evt) => {
          if (evt.key === "Enter") typed(s.getValue());
        });
      })
      .addButton((b) => b.setButtonText("Search").onClick(() => typed(input?.value ?? "")));
    // The web, with the typed query, else the title, first author and year
    const web = el.createDiv({ cls: "zotero-annot-repair-queries" });
    web.createSpan({ text: "Search the web: " });
    for (const [name, url] of WEB_SEARCHES) {
      web.createEl("a", { cls: "zotero-annot-repair-query", text: name }).addEventListener("click", () => {
        const first = dead.authors[0]?.split(/[\s,]+/).filter(Boolean);
        const fallback = [dead.title && `"${dead.title}"`, first && (dead.authors[0].includes(",") ? first[0] : first.pop()), dead.year];
        const query = entry.query ?? fallback.filter(Boolean).join(" ");
        if (query) this.actions.openUrl(url(query));
      });
    }
    el.appendChild(results);

    if (entry.results) this.renderResults(results, el, entry);
    else if (this.actions.autoSearch) void search();
    else results.setText("Not searched yet.");
  }

  private renderResults(parent: HTMLElement, entryEl: HTMLElement, entry: RepairEntry): void {
    parent.empty();
    const found = entry.results ?? [];
    if (found.length === 0) parent.setText("No item found.");
    for (const item of found) this.renderResult(parent, entryEl, entry, item);
  }

  private renderResult(parent: HTMLElement, entryEl: HTMLElement, entry: RepairEntry, item: ZoteroItemSummary): void {
    const setting = new Setting(parent)
      .setName(item.title)
      .setDesc([item.creators, item.year, item.key].filter(Boolean).join(" · "));
    if (item.key === entry.guess) setting.nameEl.createSpan({ cls: "zotero-annot-repair-guess", text: "best match" });
    setting
      .addButton((b) => b.setButtonText("Show in Zotero").onClick(() => this.actions.showInZotero(item.key)))
      .addButton((b) =>
        b
          .setButtonText("Use this item")
          .setCta()
          .onClick(async () => {
            b.setDisabled(true);
            const result = await this.actions.relink(entry.dead.key, item.key);
            entry.chosen = { key: item.key, title: item.title, result };
            entryEl.empty();
            entryEl.createEl("h4", { text: entry.dead.title ?? `Item ${entry.dead.key}` });
            this.renderDone(entryEl, entry.dead.key, item.title, item.key, result);
          })
      );
  }
}
