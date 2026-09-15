# Changelog

## 0.1.0

First release.

### Viewing
- Opens files of any size: the first page appears in tens of milliseconds while the file is indexed in a background worker.
- Smooth scrolling through millions of lines with its own scrollbars (no browser height limits).
- Sparse line index (at most 32 MB) cached on disk: reopening a file is instant.
- Go to Line (`Ctrl+G`), file size / line count / index state in the status bar.
- Read-only: the file is never modified.

### Search and filter
- Search the whole file, not just what is loaded: literal, case-insensitive, whole word or regular expression; streaming results with progress, `F3` / `Shift+F3` navigation and match highlighting.
- Filter mode: show only matching lines, or invert to hide them; switching is instant.
- Export the filtered lines to a new file, streamed without holding them in memory.

### Formats
- Log: lines colored by level, timestamps recognized (ISO 8601, syslog, epoch, common log format) and a time range filter.
- JSON Lines: syntax highlighting with the active color theme's JSON token colors (including `editor.tokenColorCustomizations`), details panel with the fields and pretty-printed JSON of the selected line; field filters `field=value` and `field~regex`.
- CSV / TSV: delimiter detection, header from the first line, table view with resizable columns.
- Formats are detected from the extension and the content, and can be changed with **BigView: Change Format…**.

### Live files
- Tail: lines appended to the file show up immediately; the view follows them when scrolled to the end, and an active search or filter keeps up.
- Log rotation, truncation and deleted files are detected; the file is re-indexed when it changes underneath.
- Clear messages for missing files, permission problems, binary files and a full disk.
