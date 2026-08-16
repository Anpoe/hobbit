# Hobbit

A warm, private archive for daily Markdown diaries in Obsidian.

## Install with BRAT

1. Install and enable [BRAT](https://github.com/TfTHacker/obsidian42-brat) in Obsidian.
2. Add `Anpoe/hobbit` as a beta plugin.
3. Enable **Hobbit** in Community plugins.

Hobbit uses Obsidian's core **Daily notes** plugin as the source of truth.
Enable Daily notes and configure its new-file location, date format, and
template. Hobbit recognizes every Markdown file that matches that core-plugin
configuration, regardless of its template or frontmatter. When a user
favorites a note or adds a tag, Hobbit adds only the corresponding property
on demand.

## Included files

- `manifest.json` — Obsidian plugin manifest
- `main.js` — plugin logic
- `styles.css` — archive, reader, editor, and mobile styles
