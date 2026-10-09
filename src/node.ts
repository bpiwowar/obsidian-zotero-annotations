import { Platform } from "obsidian";

/*
 * Node.js modules, loaded on first use. They exist only in the desktop app: a
 * top-level import would keep the plugin from loading on mobile, where only
 * the parts that do not need Zotero run.
 */
/* eslint-disable @typescript-eslint/no-require-imports -- loaded lazily on purpose, see above */

export function fs(): typeof import("fs/promises") {
  if (!Platform.isDesktop) throw new Error("No file system access on mobile");
  return require("fs/promises") as typeof import("fs/promises");
}

export function crypto(): typeof import("crypto") {
  if (!Platform.isDesktop) throw new Error("No crypto module on mobile");
  return require("crypto") as typeof import("crypto");
}

export function os(): typeof import("os") {
  if (!Platform.isDesktop) throw new Error("No os module on mobile");
  return require("os") as typeof import("os");
}
/* eslint-enable @typescript-eslint/no-require-imports -- end of the lazy loaders */
