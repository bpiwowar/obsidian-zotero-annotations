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

/** Asks to pick one of `options` (button labels); resolves to its index, or null when dismissed. */
export function choose(app: App, title: string, message: string, options: string[]): Promise<number | null> {
  return new Promise((resolve) => {
    let choice: number | null = null;
    const modal = new Modal(app);
    modal.setTitle(title);
    for (const paragraph of message.split("\n\n")) modal.contentEl.createEl("p", { text: paragraph });
    const setting = new Setting(modal.contentEl);
    options.forEach((label, i) => {
      setting.addButton((b) => {
        b.setButtonText(label).onClick(() => {
          choice = i;
          modal.close();
        });
        if (i === 0) b.setCta();
      });
    });
    modal.onClose = () => resolve(choice);
    modal.open();
  });
}
