/**
 * Report of a repair of links to dead Zotero items (see `item-recovery.ts`):
 * the items relinked to the item Zotero merged them into, then the others,
 * each with the notes linking to it and a search of the library (from its
 * title and the text of its links) to pick the item its links should point at.
 */
import { App, Modal, Setting } from "obsidian";
import { DeadItem } from "./item-recovery";
import { Mention } from "./mention-index";
import { ZoteroItemSummary } from "./zotero-client";

export interface RepairEntry {
  dead: DeadItem;
  /** Its title, from Zotero or from its literature note */
  title: string | null;
  /** Key of an item with the same title, if any */
  guess: string | null;
  mentions: Mention[];
  /** Text of the links to it, as search queries (see `linkTexts`) */
  texts: string[];
  /** Last query searched by hand (kept when the report is reopened) */
  query?: string;
  /** The item picked for it, once relinked */
  chosen?: { key: string; title: string; notes: number };
}

/** An item relinked for sure */
export interface RelinkedItem {
  dead: DeadItem;
  title: string | null;
  key: string;
  newTitle: string;
  /** Notes changed */
  notes: number;
}

export interface RepairActions {
  search(query: string): Promise<ZoteroItemSummary[]>;
  /** Points the links of `oldKey` at `newKey` */
  relink(oldKey: string, newKey: string): Promise<number>;
  openMention(mention: Mention): void;
  showInZotero(key: string): void;
}

/** What a repair did and what is left to review; kept to reopen the report as it was */
export interface RepairReport {
  relinked: RelinkedItem[];
  review: RepairEntry[];
  /** Scroll position when the report was closed */
  scroll?: number;
}

/** Notes listed per item */
const MAX_MENTIONS = 5;

/** Search results listed per query */
const MAX_RESULTS = 6;

/** Queries searched when an item is shown */
const MAX_QUERIES = 3;

export class RepairModal extends Modal {
  constructor(
    app: App,
    private report: RepairReport,
    private actions: RepairActions
  ) {
    super(app);
  }

  private get relinked(): RelinkedItem[] {
    return this.report.relinked;
  }

  private get entries(): RepairEntry[] {
    return this.report.review;
  }

  onOpen(): void {
    const total = this.relinked.length + this.entries.length;
    this.setTitle(`Zotero link repair: ${total} item(s) no longer in Zotero`);
    this.contentEl.addClass("zotero-annot-repair");
    if (this.relinked.length > 0) {
      this.contentEl.createEl("h3", { text: `Relinked (${this.relinked.length})` });
      this.contentEl.createEl("p", {
        cls: "setting-item-description",
        text: "Merged in Zotero: their links now point at the item they were merged into.",
      });
      for (const item of this.relinked) {
        const el = this.contentEl.createDiv({ cls: "zotero-annot-repair-entry" });
        el.createEl("h4", { text: item.title ?? `Item ${item.dead.key}` });
        el.createDiv({
          cls: "zotero-annot-repair-done",
          text: `${item.dead.key} \u2192 \u201c${item.newTitle}\u201d (${item.key}), ${item.notes} note(s) updated`,
        });
      }
    }
    if (this.entries.length > 0) {
      this.contentEl.createEl("h3", { text: `To review (${this.entries.length})` });
      this.contentEl.createEl("p", {
        cls: "setting-item-description",
        text:
          "Zotero has no record of the item that replaced these. Look for it (from the title, or from the text of " +
          "the links), then choose it to update every link to the old item in the vault.",
      });
      for (const entry of this.entries) {
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

  private renderEntry(el: HTMLElement, entry: RepairEntry): void {
    const { dead } = entry;
    el.createEl("h4", { text: entry.title ?? `Item ${dead.key}` });
    if (entry.chosen) {
      this.renderChosen(el, entry);
      return;
    }
    el.createDiv({
      cls: "setting-item-description",
      text: `${dead.key} · ${dead.trashed ? "in the Zotero trash" : "no longer in Zotero"}`,
    });

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

    // Search of the library: its title and the text of its links
    const results = createDiv({ cls: "zotero-annot-repair-results" });
    const queries = [...new Set([entry.title, ...entry.texts].filter((q): q is string => !!q))];
    let input: HTMLInputElement | null = null;
    const byHand = (query: string) => {
      entry.query = query;
      void search([query]);
    };
    const search = async (list: string[]) => {
      results.empty();
      if (list.length === 0) return;
      results.setText("Searching\u2026");
      try {
        const seen = new Set([dead.key]);
        const found: ZoteroItemSummary[] = [];
        for (const query of list) {
          for (const item of (await this.actions.search(query)).slice(0, MAX_RESULTS)) {
            if (!seen.has(item.key)) found.push(item);
            seen.add(item.key);
          }
        }
        // The guess first
        found.sort((a, b) => Number(b.key === entry.guess) - Number(a.key === entry.guess));
        results.empty();
        if (found.length === 0) results.setText("No item found.");
        for (const item of found) this.renderResult(results, el, entry, item);
      } catch (e) {
        results.setText(`Search failed: ${(e as Error).message}`);
      }
    };
    new Setting(el)
      .addSearch((s) => {
        s.setPlaceholder("Title, author, year\u2026").setValue(entry.query ?? queries[0] ?? "");
        input = s.inputEl;
        s.inputEl.addEventListener("keydown", (evt) => {
          if (evt.key === "Enter") byHand(s.getValue());
        });
      })
      .addButton((b) => b.setButtonText("Search").onClick(() => byHand(input?.value ?? "")));
    // Each query on its own
    if (queries.length > 1) {
      const chips = el.createDiv({ cls: "zotero-annot-repair-queries" });
      chips.createSpan({ text: "Search for: " });
      for (const query of queries) {
        const chip = chips.createEl("a", { cls: "zotero-annot-repair-query", text: query });
        chip.addEventListener("click", () => {
          if (input) input.value = query;
          byHand(query);
        });
      }
    }
    el.appendChild(results);
    void search(entry.query !== undefined ? [entry.query] : queries.slice(0, MAX_QUERIES));
  }

  private renderChosen(el: HTMLElement, entry: RepairEntry): void {
    const chosen = entry.chosen;
    if (!chosen) return;
    el.createDiv({
      cls: "zotero-annot-repair-done",
      text: `${entry.dead.key} \u2192 \u201c${chosen.title}\u201d (${chosen.key}), ${chosen.notes} note(s) updated`,
    });
  }

  private renderResult(parent: HTMLElement, entryEl: HTMLElement, entry: RepairEntry, item: ZoteroItemSummary): void {
    const setting = new Setting(parent)
      .setName(item.title)
      .setDesc([item.creators, item.year, item.key].filter(Boolean).join(" · "));
    if (item.key === entry.guess) setting.nameEl.createSpan({ cls: "zotero-annot-repair-guess", text: "same title" });
    setting
      .addButton((b) => b.setButtonText("Show in Zotero").onClick(() => this.actions.showInZotero(item.key)))
      .addButton((b) =>
        b
          .setButtonText("Use this item")
          .setCta()
          .onClick(async () => {
            b.setDisabled(true);
            const notes = await this.actions.relink(entry.dead.key, item.key);
            entry.chosen = { key: item.key, title: item.title, notes };
            entryEl.empty();
            entryEl.createEl("h4", { text: entry.title ?? `Item ${entry.dead.key}` });
            this.renderChosen(entryEl, entry);
          })
      );
  }
}
