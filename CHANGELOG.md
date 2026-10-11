# Changelog

All notable changes to this project will be documented in this file.

## [1.1.0] - 2026-10-11

### Features
- Ask what to do when a note's text and Zotero's notes diverge ([738f963](https://github.com/bpiwowar/obsidian-zotero-annotations/commit/738f9633ae578fa987ff137b9f91f981edf3057f))

## [1.0.0] - 2026-10-11

### Documentation
- New screenshots, with search and link repair ([0223ba5](https://github.com/bpiwowar/obsidian-zotero-annotations/commit/0223ba5262917a3664cbcbf2fbb2f4a7b7f6f418))

### Features
- Search Zotero and insert a link ([a3a73ab](https://github.com/bpiwowar/obsidian-zotero-annotations/commit/a3a73ab5a8d056f7c0633a7e9c34ea78f1085780))
- Separate identity from ZotLit, and migrate ZotLit notes ([d1a2061](https://github.com/bpiwowar/obsidian-zotero-annotations/commit/d1a2061aa73582c0b6e73d4a264a6b93cb1da906))

### Performance
- Store less in the cache files ([8ce9e93](https://github.com/bpiwowar/obsidian-zotero-annotations/commit/8ce9e93e0b340b7dd1cc750eacfb35ec59c1a0bc))

## [0.6.1] - 2026-10-10

### Bug Fixes
- Tell when edited authors wait for confirmation ([2e76a3b](https://github.com/bpiwowar/obsidian-zotero-annotations/commit/2e76a3b9e12ffe05e225e4e7e4b40e0db8aa7cc3))
- Ask with a dialog as soon as edited authors are pushed ([5f325a0](https://github.com/bpiwowar/obsidian-zotero-annotations/commit/5f325a0cc4361bff0144295dea3a8193bd52183b))

## [0.6.0] - 2026-10-10

### Bug Fixes
- Text of the link repair report can be selected and copied ([8bfd85e](https://github.com/bpiwowar/obsidian-zotero-annotations/commit/8bfd85e6575da26bc2453392b19f3044ac1c909e))

### Features
- Authors as a list property of literature notes, synced with Zotero ([d424363](https://github.com/bpiwowar/obsidian-zotero-annotations/commit/d424363757e9cdbc3fe0847ada5d515915528b4b))
- Keywords (Zotero tags) as a list property of literature notes ([587513f](https://github.com/bpiwowar/obsidian-zotero-annotations/commit/587513f0c9f9dacd9e08bc16c5d6764ea2532bdd))
- Wikilinks to literature notes are Zotero citations of their papers ([96ad657](https://github.com/bpiwowar/obsidian-zotero-annotations/commit/96ad657d259e70de1b267e8af78c0a4e788c2101))
- Repair links to Zotero items merged into others or deleted ([9f1bdef](https://github.com/bpiwowar/obsidian-zotero-annotations/commit/9f1bdef8d930e8258758d4cc439cc38d9e0af851))
- Reopen the link repair report as it was, with cached lookups ([e790c55](https://github.com/bpiwowar/obsidian-zotero-annotations/commit/e790c55f8d54e892e35595b79493b298c1a3c9b6))
- Link repair searches with what is known of an item, and malformed keys ([bf06159](https://github.com/bpiwowar/obsidian-zotero-annotations/commit/bf06159303ba9d927aa1771b0f6caac900b9a0eb))

## [0.5.1] - 2026-10-09

### Changes
- New README screenshots: link, literature note, papers list, mobile ([d2b83af](https://github.com/bpiwowar/obsidian-zotero-annotations/commit/d2b83af11a1f91b0fa03c4a1441b9af980ff1be3))

## [0.5.0] - 2026-10-09

### Changes
- Links open the sidebar, settings tab; soften Zotero 404s ([b4c9691](https://github.com/bpiwowar/obsidian-zotero-annotations/commit/b4c9691c9faaa9f067e91c89d23cc55a56f2f36a))

## [0.4.0] - 2026-10-09

### Changes
- Add Actions & Tags examples, follow open-pdf links, icon toolbar ([4b7903f](https://github.com/bpiwowar/obsidian-zotero-annotations/commit/4b7903ffb443e8a5e7dda2e465a072fb149f9190))

## [0.3.0] - 2026-10-09

### Changes
- Caption the README screenshots ([14ecc08](https://github.com/bpiwowar/obsidian-zotero-annotations/commit/14ecc08a27e9d5255a685a14c273a48ad7747680))
- Explain file access and vault scanning in the README ([88d3c41](https://github.com/bpiwowar/obsidian-zotero-annotations/commit/88d3c417cd96b694845c668246f17f801f0e069c))
- Keep an offline copy of the annotations in literature notes, and run on mobile ([ee32f5d](https://github.com/bpiwowar/obsidian-zotero-annotations/commit/ee32f5d208d9ce0213eed5471b1bf70b10dabbe8))
- Back to version 0.2.0: no release yet ([1544648](https://github.com/bpiwowar/obsidian-zotero-annotations/commit/1544648f2aa5d5af21d532f530fca7d6969eb2d4))
- Add commands to refresh, send and sync all literature notes ([56fcd89](https://github.com/bpiwowar/obsidian-zotero-annotations/commit/56fcd8932b49c12e6efcdaaaf1c63b9943eb1e88))

## [0.2.0] - 2026-10-09

### Changes
- Fix linting issues from Obsidian plugin review ([116ce97](https://github.com/bpiwowar/obsidian-zotero-annotations/commit/116ce978afc5bad730da1ed4904ba47df6fe750b))
- Fix remaining lint issues from Obsidian review bot ([9826627](https://github.com/bpiwowar/obsidian-zotero-annotations/commit/982662753b7bf3d831676f15eac946f36669b104))
- Scope CSS to plugin view and restyle section toggles ([e9bda34](https://github.com/bpiwowar/obsidian-zotero-annotations/commit/e9bda34e2fd0b9ba6c489f8445089e10e0c45b35))
- Render math formulas in sidebar notes ([45a0f95](https://github.com/bpiwowar/obsidian-zotero-annotations/commit/45a0f9519b89e7db708789b2b1f83da40be20cd1))
- Add pre-commit config for ESLint and TypeScript checks ([332dc1b](https://github.com/bpiwowar/obsidian-zotero-annotations/commit/332dc1b20482dc4cc189c2cd99ee352e4584c0ed))
- Differentiate single vs double click on zotero:// links ([4b0df22](https://github.com/bpiwowar/obsidian-zotero-annotations/commit/4b0df223cd8a7ff1c839008f02d05f4bfe9e302b))
- Fix Obsidian scorecard issues ([ffaf218](https://github.com/bpiwowar/obsidian-zotero-annotations/commit/ffaf218cfaffd32a842c61bbafc1e363e135eb50))
- Show related items in the sidebar ([cb6b7de](https://github.com/bpiwowar/obsidian-zotero-annotations/commit/cb6b7deb60b68c463daa05bec7b99dea28345f65))
- Show vault locations mentioning a paper ([b8f5167](https://github.com/bpiwowar/obsidian-zotero-annotations/commit/b8f51671ad1b56ed5cd04f45284d0fb43131350d))
- Ignore .codegraph/ ([b90e295](https://github.com/bpiwowar/obsidian-zotero-annotations/commit/b90e2954c0016256f7138f74a0225045b65e4181))
- List the papers of a note along its heading structure ([d658a6c](https://github.com/bpiwowar/obsidian-zotero-annotations/commit/d658a6ce9cec4fd1d2538627393a5575cd58228d))
- Upgrade dependencies and fix new lint warnings ([f5cecaa](https://github.com/bpiwowar/obsidian-zotero-annotations/commit/f5cecaab68531327b39d46b5fcd8c3ebf2bca9d2))
- Refresh package-lock.json ([b33377e](https://github.com/bpiwowar/obsidian-zotero-annotations/commit/b33377e054d923e27cf3628e4831c3d4f654af04))
- Add literature notes synced with Zotero, and annotation drag and drop ([2f6681a](https://github.com/bpiwowar/obsidian-zotero-annotations/commit/2f6681aa16d67302a8402f16d5cc722099c11db1))
- Leave the paper's own literature note out of "Mentioned in" ([19229bf](https://github.com/bpiwowar/obsidian-zotero-annotations/commit/19229bf24e25aed3d1afdf9e3eec8e5989a8e4cb))
- Send literature note edits back to Zotero ([8ca5a81](https://github.com/bpiwowar/obsidian-zotero-annotations/commit/8ca5a81b32dd77347317974c08725d628ad7b00c))
- Check conversions before sending them to Zotero ([e6d7222](https://github.com/bpiwowar/obsidian-zotero-annotations/commit/e6d72223a8071e579ce4244dc5f35b46b667c099))
- Add screenshots of the sidebar to the README ([ea72119](https://github.com/bpiwowar/obsidian-zotero-annotations/commit/ea721197dda05b64a4c3bfad6416975722d2c417))
- Prepare 0.2.0 for the community plugin directory ([1c90ec6](https://github.com/bpiwowar/obsidian-zotero-annotations/commit/1c90ec68400b0da49cc494f25ef21b597c296f2e))

## [0.1.0] - 2026-03-31

### Changes
- Initial release: Zotero Annotations sidebar plugin for Obsidian ([917171e](https://github.com/bpiwowar/obsidian-zotero-annotations/commit/917171ea031ecfc57604c45d585dd78ad6fa290f))
- Add versions.json, LICENSE, and release workflow ([c0c6c10](https://github.com/bpiwowar/obsidian-zotero-annotations/commit/c0c6c1096ceb94465f2f3bee4bc30490a5e57645))
- Fix build: disable importHelpers to remove tslib dependency ([f3b9d30](https://github.com/bpiwowar/obsidian-zotero-annotations/commit/f3b9d3021b28c9d5770cbe5fdf979fb85639d729))
- Fix guideline violations and add settings tab ([14a15b2](https://github.com/bpiwowar/obsidian-zotero-annotations/commit/14a15b27252c29c0eb0d4c46b40c1c0efcb3fb4c))
- Replace .then() with async/await in render method ([154876a](https://github.com/bpiwowar/obsidian-zotero-annotations/commit/154876a82d2cfba3e4d85e4397f1f27cd864a6af))

