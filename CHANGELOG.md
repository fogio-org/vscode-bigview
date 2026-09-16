# Changelog

## 0.1.1

### Changed

- Update icon

## 0.1.0

### Features

- **Files of any size** — the first page appears in tens of milliseconds while the file is indexed in a background worker; a 5 GB log is indexed in about a second
- **Low memory** — a sparse line index (at most 32 MB) instead of the file's contents; only the lines on screen are read and decoded
- **Instant reopen** — the line index is cached on disk and reused until the file changes
- **Smooth scrolling** — millions of lines with custom scrollbars, no browser height limits
- **Go to Line** — `Ctrl+G`, plus a status bar with the file size, line count and indexing progress
- **Whole-file search** — plain text, match case, whole word or regular expression; streaming results with progress, `F3` / `Shift+F3` navigation and match highlighting
- **Filter** — show only the matching lines, or invert to hide them; switching is instant
- **Export Filtered Lines** — writes the filtered lines to a new file, streamed without holding them in memory
- **Log format** — lines colored by level, timestamps recognized (ISO 8601, syslog, epoch, common log format) and a time range filter
- **JSON Lines format** — syntax highlighting in the active color theme's JSON colors (including `editor.tokenColorCustomizations`), a details panel with the fields and pretty-printed JSON of the selected line, field filters `field=value` and `field~regex`
- **CSV / TSV format** — delimiter detection, header from the first line, table view with resizable columns and matches highlighted inside cells
- **Format detection** — from the extension and the content; change it with **BigView: Change Format…**, remembered per file
- **Tail** — lines appended to the file show up immediately; the view follows them when scrolled to the end, and an active search or filter keeps up
- **Log rotation** — renamed, truncated, deleted and recreated files are detected and indexed again
- **Clear errors** — messages for missing files, permission problems, binary files and a full disk
- **Read-only** — the file is never modified
