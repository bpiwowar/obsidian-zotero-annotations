import { App, Modal, Setting } from "obsidian";

/** Asks a yes/no question; resolves to true when the action is confirmed. */
export function confirm(app: App, title: string, message: string, action: string): Promise<boolean> {
  return new Promise((resolve) => {
    let confirmed = false;
    const modal = new Modal(app);
    modal.setTitle(title);
    modal.contentEl.createEl("p", { text: message });
    new Setting(modal.contentEl)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => modal.close()))
      .addButton((b) =>
        b
          .setButtonText(action)
          .setDestructive()
          .onClick(() => {
            confirmed = true;
            modal.close();
          })
      );
    modal.onClose = () => resolve(confirmed);
    modal.open();
  });
}
