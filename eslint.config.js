import tsparser from "@typescript-eslint/parser";
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";

export default defineConfig([
  ...obsidianmd.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsparser,
      parserOptions: { project: "./tsconfig.json" },
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    rules: {
      "obsidianmd/sample-names": "off",
    },
  },
  // @codemirror packages are provided by Obsidian at runtime, not direct dependencies
  {
    files: ["src/cursor-detector.ts"],
    rules: {
      "import/no-extraneous-dependencies": "off",
    },
  },
]);
