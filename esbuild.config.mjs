import esbuild from "esbuild";
import process from "process";
import builtins from "builtin-modules";

import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

const prod = process.argv[2] === "production";
const watch = process.argv.includes("--watch");

// Determine output path: OBSIDIAN_PLUGIN_DIR env var, or .obsidian-plugin-dir file, or default "main.js"
let outfile = "main.js";
if (process.env.OBSIDIAN_PLUGIN_DIR) {
  outfile = resolve(process.env.OBSIDIAN_PLUGIN_DIR, "main.js");
} else if (existsSync(".obsidian-plugin-dir")) {
  const dir = readFileSync(".obsidian-plugin-dir", "utf-8").trim();
  if (dir) outfile = resolve(dir, "main.js");
}

const buildOptions = {
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    ...builtins,
  ],
  format: "cjs",
  target: "es2018",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile,
  minify: prod,
};

if (watch) {
  const ctx = await esbuild.context(buildOptions);
  await ctx.watch();
  console.log("Watching for changes...");
} else {
  esbuild.build(buildOptions).catch(() => process.exit(1));
}
