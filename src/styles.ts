/**
 * Inline styles injected into the document. Keeping them here
 * avoids the need for a separate styles.css build step.
 */
export const STYLES = `
.zotero-annot-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--background-modifier-border);
  background: var(--background-secondary);
}

.zotero-annot-freeze-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 4px;
  border: 1px solid var(--background-modifier-border);
  background: var(--background-primary);
  color: var(--text-muted);
  font-size: 12px;
}

.zotero-annot-freeze-btn.is-active {
  background: var(--interactive-accent);
  color: var(--text-on-accent);
  border-color: var(--interactive-accent);
}

.zotero-annot-freeze-label {
  font-size: 12px;
}

.zotero-annot-open-link {
  margin-left: auto;
  font-size: 12px;
  color: var(--text-accent);
  text-decoration: none;
  cursor: pointer;
}

.zotero-annot-open-link:hover {
  text-decoration: underline;
}

.zotero-annot-header {
  padding: 10px 12px;
  border-bottom: 1px solid var(--background-modifier-border);
}

.zotero-annot-title {
  font-weight: 600;
  font-size: 14px;
  margin-bottom: 4px;
  color: var(--text-normal);
}

.zotero-annot-creators {
  font-size: 12px;
  color: var(--text-muted);
  margin-bottom: 2px;
}

.zotero-annot-date {
  font-size: 11px;
  color: var(--text-faint);
}

.zotero-annot-count {
  padding: 6px 12px;
  font-size: 11px;
  color: var(--text-muted);
  border-bottom: 1px solid var(--background-modifier-border);
}

.zotero-annot-loading,
.zotero-annot-empty,
.zotero-annot-error {
  padding: 20px 12px;
  text-align: center;
  color: var(--text-muted);
  font-size: 13px;
}

.zotero-annot-error {
  color: var(--text-error);
}

.zotero-annot-list {
  padding: 8px 0;
  overflow-y: auto;
}

.zotero-annot-page-header {
  padding: 8px 12px 4px;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.zotero-annot-card {
  margin: 4px 10px;
  padding: 8px 10px;
  border-left: 3px solid #ffd400;
  border-radius: 4px;
  background: var(--background-secondary);
  position: relative;
}

.zotero-annot-card:hover {
  background: var(--background-secondary-alt);
}

.zotero-annot-type-badge {
  display: inline-block;
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 3px;
  background: var(--background-modifier-border);
  color: var(--text-muted);
  margin-bottom: 4px;
  text-transform: capitalize;
}

.zotero-annot-text {
  font-size: 13px;
  line-height: 1.4;
  color: var(--text-normal);
  margin-bottom: 4px;
}

.zotero-annot-comment {
  font-size: 12px;
  color: var(--text-muted);
  margin-bottom: 4px;
  padding-left: 8px;
  border-left: 2px solid var(--background-modifier-border);
}

.zotero-annot-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: 4px;
}

.zotero-annot-tag {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 8px;
  background: var(--background-modifier-border);
  color: var(--text-muted);
}

.zotero-annot-pdf-link {
  font-size: 11px;
  color: var(--text-accent);
  text-decoration: none;
  cursor: pointer;
}

.zotero-annot-pdf-link:hover {
  text-decoration: underline;
}

.zotero-annot-notes {
  padding: 6px 0 2px 4px;
}

.zotero-annot-note {
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-normal);
  padding: 6px 8px;
  border-left: 2px solid var(--interactive-accent);
  margin-bottom: 6px;
}

.zotero-annot-note img {
  max-width: 100%;
  border-radius: 4px;
  margin: 4px 0;
}

.zotero-annot-image {
  max-width: 100%;
  border-radius: 4px;
  margin: 4px 0;
}

.zotero-annot-image-placeholder {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-muted);
  font-style: italic;
  padding: 4px 0;
}

.zotero-annot-abstract-wrapper {
  margin-top: 6px;
}

.zotero-annot-abstract-toggle {
  display: flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
  background: none;
  border: none;
  padding: 2px 0;
  font-size: 12px;
  color: var(--text-accent);
}

.zotero-annot-abstract-toggle:hover {
  text-decoration: underline;
}

.zotero-annot-abstract {
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-muted);
  padding: 6px 0 2px 4px;
}
`;
