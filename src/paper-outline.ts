import { HeadingCache } from "obsidian";

/** A Zotero paper as shown in the "papers in this note" list. */
export interface PaperInfo {
  /** Item key to open/select in Zotero (an attachment key is resolved to its parent) */
  key: string;
  title: string;
  /** Short form, e.g. "Doe et al." */
  creators: string;
  /** 4-digit year, or "" */
  year: string;
}

/** A paper together with the lines of the section that mention it. */
export interface PaperOccurrence {
  paper: PaperInfo;
  /** 0-based line numbers, ascending */
  lines: number[];
}

/**
 * One node of the note's heading tree. `heading` is null for the implicit root
 * section, which holds whatever comes before the first heading.
 */
export interface OutlineSection {
  heading: string | null;
  /** Markdown heading level (1-6); 0 for the root section */
  level: number;
  /** 0-based line of the heading, -1 for the root section */
  line: number;
  papers: PaperOccurrence[];
  children: OutlineSection[];
}

/** Where in the note a single zotero:// link was found. */
export interface PaperHit {
  line: number;
  paper: PaperInfo;
}

/**
 * Lays the papers of a note out along its heading structure: every hit lands in
 * the section of the last heading above it, and sections with nothing below
 * them are dropped, so the result is the outline of where papers are cited.
 */
export function buildPaperOutline(headings: HeadingCache[], hits: PaperHit[]): OutlineSection {
  const root: OutlineSection = { heading: null, level: 0, line: -1, papers: [], children: [] };
  const sections = headings
    .map((h) => ({
      heading: h.heading,
      level: h.level,
      line: h.position.start.line,
      papers: [] as PaperOccurrence[],
      children: [] as OutlineSection[],
    }))
    .sort((a, b) => a.line - b.line);

  // Each hit belongs to the last section starting before it
  const ordered = [...hits].sort((a, b) => a.line - b.line);
  let next = 0;
  let current: OutlineSection = root;
  for (const hit of ordered) {
    while (next < sections.length && sections[next].line <= hit.line) {
      current = sections[next];
      next++;
    }
    addPaper(current, hit.paper, hit.line);
  }

  // Nest sections by level; a heading deeper than the one before it becomes its child
  const stack: OutlineSection[] = [root];
  for (const section of sections) {
    while (stack.length > 1 && stack[stack.length - 1].level >= section.level) stack.pop();
    stack[stack.length - 1].children.push(section);
    stack.push(section);
  }

  prune(root);
  return root;
}

/** Adds an occurrence, merging it into the paper's existing entry in the section. */
function addPaper(section: OutlineSection, paper: PaperInfo, line: number): void {
  const existing = section.papers.find((p) => p.paper.key === paper.key);
  if (existing) {
    if (!existing.lines.includes(line)) existing.lines.push(line);
    return;
  }
  section.papers.push({ paper, lines: [line] });
}

/** Drops branches that hold no paper at all. Returns true if `section` kept anything. */
function prune(section: OutlineSection): boolean {
  section.children = section.children.filter((child) => prune(child));
  return section.papers.length > 0 || section.children.length > 0;
}

/** Number of distinct papers in a section tree. */
export function countPapers(section: OutlineSection): number {
  const keys = new Set<string>();
  const walk = (s: OutlineSection): void => {
    for (const p of s.papers) keys.add(p.paper.key);
    for (const c of s.children) walk(c);
  };
  walk(section);
  return keys.size;
}
