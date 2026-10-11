import { App, Modal, Notice, Setting, TFile } from "obsidian";
import { LiteratureNotes, ZotlitMigration, ZotlitScan } from "./literature-notes";

/**
 * Migration of ZotLit literature notes (`zotero-key`) to notes of this
 * plugin (`zotero-item`): what will be done, the options, then a progress
 * notice. `only`: just this note (from the sidebar or the note's command).
 */
export class ZotlitMigrationModal extends Modal {
  private options: ZotlitMigration = { zotlitSection: "text", move: false };

  constructor(
    app: App,
    private literature: LiteratureNotes,
    private notesFolder: string,
    private only: TFile | null = null,
    /** Called once notes were migrated */
    private onDone: () => void = () => undefined
  ) {
    super(app);
  }

  onOpen(): void {
    void this.render();
  }

  private async render(): Promise<void> {
    const scan = await this.literature.scanZotlit();
    const notes = this.only ? scan.notes.filter((f) => f === this.only) : scan.notes;
    this.setTitle(this.only ? "Migrate this ZotLit literature note" : "Migrate ZotLit literature notes");
    const el = this.contentEl;
    if (notes.length === 0) {
      el.createEl("p", { text: this.only ? "This note cannot be migrated." : "No ZotLit literature note to migrate." });
      this.describeLeftOut(scan);
      return;
    }
    el.createEl("p", {
      text:
        `${notes.length} note(s) identified by zotero-key (ZotLit) become notes of this plugin (zotero-item): ` +
        "ZotLit no longer manages them, this plugin keeps them in sync with Zotero (properties, Zotero notes, " +
        "offline copy of the annotations). Their own text is only sent to Zotero if you say so.",
    });
    this.describeLeftOut(scan);

    new Setting(el)
      .setName("ZotLit's generated section")
      .setDesc("The part ZotLit re-renders from its template (between %%zt-managed%% markers).")
      .addDropdown((d) =>
        d
          .addOption("text", "Keep its text (no longer updated)")
          .addOption("remove", "Remove it (the sidebar shows the annotations)")
          .setValue(this.options.zotlitSection)
          .onChange((v) => (this.options.zotlitSection = v as ZotlitMigration["zotlitSection"]))
      );
    new Setting(el)
      .setName("Move and rename")
      .setDesc(`Move to "${this.notesFolder || "/"}", named "short title – KEY" as this plugin names notes (links are updated).`)
      .addToggle((t) => t.setValue(this.options.move).onChange((v) => (this.options.move = v)));

    new Setting(el)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) =>
        b
          .setButtonText(notes.length === 1 ? "Migrate" : `Migrate ${notes.length} notes`)
          .setCta()
          .onClick(() => {
            this.close();
            void this.migrate(notes);
          })
      );
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private describeLeftOut(scan: ZotlitScan): void {
    const lines: string[] = [];
    if (scan.existing.length > 0 && !this.only) {
      lines.push(`${scan.existing.length} note(s) of papers that already have a note of this plugin are left as they are.`);
    }
    if (this.only && scan.existing.includes(this.only)) {
      lines.push("Its paper already has a note of this plugin: this one is left as it is.");
    }
    if (scan.groups.length > 0 && !this.only) {
      lines.push(`${scan.groups.length} note(s) of group libraries are left as they are (not supported).`);
    }
    if (scan.imported.length > 0 && !this.only) {
      lines.push(
        `${scan.imported.length} Zotero note(s) imported by ZotLit as notes of their own (zotero-note-key) are left as ` +
          "they are: the Zotero notes also appear in the migrated literature notes, where edits go back to Zotero."
      );
    }
    if (lines.length === 0) return;
    const ul = this.contentEl.createEl("ul");
    for (const line of lines) ul.createEl("li", { text: line });
  }

  private async migrate(notes: TFile[]): Promise<void> {
    const notice = new Notice("Migrating ZotLit literature notes…", 0);
    let migrated = 0;
    let skipped = 0;
    const failed: string[] = [];
    for (const [i, file] of notes.entries()) {
      notice.setMessage(`Migrating ZotLit literature notes… ${i + 1}/${notes.length}`);
      try {
        if (await this.literature.migrateZotlit(file, this.options)) migrated++;
        else skipped++;
      } catch (e) {
        console.warn(`Zotero Annotations: could not migrate ${file.path}`, e);
        failed.push(file.basename);
      }
    }
    notice.hide();
    new Notice(
      `${migrated} ZotLit note(s) migrated` +
        (skipped > 0 ? `, ${skipped} left (their paper has a note of this plugin)` : "") +
        (failed.length > 0 ? `, ${failed.length} failed (details in the developer console): ${failed.join(", ")}` : "."),
      failed.length > 0 ? 15_000 : 5_000
    );
    if (migrated > 0) this.onDone();
  }
}
