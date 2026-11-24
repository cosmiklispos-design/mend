# SPEC.md — mend, one patch tool for every AI edit format

`mend` applies a patch, written in any of the four formats AI tools emit, to a tree of files, and reports
exactly what changed. It is deterministic, reads nothing but the patch and the tree, and writes nothing
when any edit fails. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.

## 1. Invocation

`node main.ts [--format=NAME] [--check] [--strict] [PATCH]`

- `PATCH` absent or `-` means the patch is read from standard input; otherwise it is the path of the patch
  file. Options and `PATCH` may come in any order; `--` ends the options, and what follows it is positional.
- `--format=NAME` names the format the patch is read as: `unified`, `search-replace`, `v4a`, `json`, or
  `auto` (the default), which detects it from the text (§4). A named format is read as that format whatever
  the text holds.
- `--check` is a dry run: the output and exit code are the same, but no file is written.
- `--strict` means tier 0 matching only (§5).
- A usage error is an unknown `-` argument (before `--`), a duplicate option, a bad `--format` value, or
  more than one positional argument. It exits 2 with the one line `error: usage`.

## 2. Output and exit codes

Standard output holds lines terminated by `\n`, and nothing else.

- Exit 2, one line, for a patch that cannot be read or parsed at all:
  `error: usage`, `error: no-patch` (the `PATCH` file cannot be read), `error: format` (auto-detection
  finds no format), or `error: parse <N>` (`<N>` is the 1-based patch line; a patch with no edit at all is
  `error: parse 1`). These are tried in that order, and a parse error is reported before any file is
  looked at.
- Exit 1, nothing written, when one or more edits fail: one `error: <code> <path>` line per failed edit,
  in patch order, then `failed: <k> of <n> edits`. The codes are `no-match`, `ambiguous`, `missing`,
  `exists`, and `unsafe`. The line names the path as the patch wrote it, after the §6 prefix removal.
- Exit 0, every change written (or, with `--check`, none): one line per changed path, in byte order
  (UTF-8), then `ok: <n> files`, or `ok: 1 file` for one:
  - `A <path>` — a file was created.
  - `D <path>` — a file was deleted.
  - `M <path>` — a file was changed.
  - `R <old> -> <new>` — a file was moved (a successful move replaces that pair's `D` and `A` lines,
    and sorts by `<new>`).
  - A file whose bytes are unchanged is not listed; a patch that changes nothing prints only
    `ok: 0 files`.

## 3. Files, lines, and paths

- Files hold UTF-8 text. A path is safe when it is non-empty, has no leading `/`, no `\`, and no empty,
  `.`, or `..` segment. Directories are created as needed.
- A file's line break is CRLF when its first `\n` follows a `\r`, else LF. Lines are the text split at
  that break; a file ends with a break when its text ends with one; the last empty piece is not a line;
  an empty file has no lines and no final break.
- A changed file is written back with its own break, its final break exactly as before, unless §6 says
  otherwise. A created file uses LF breaks and ends with a break, unless the format says otherwise; a
  JSON `create` writes `file_text` byte for byte.
- Patch lines are the text split at `\n`, one trailing `\r` removed from each, with no empty piece after
  a final `\n`.

## 4. Detection (auto)

The first of these that holds, reading the patch in order; blank means empty or only whitespace:

1. The first non-blank line, trimmed, is `*** Begin Patch` — v4a.
2. The first non-whitespace character of the first non-blank line is `[` or `{` — json.
3. Some line, trimmed of trailing whitespace, is `<<<<<<< SEARCH` — search-replace.
4. Some line starts with `diff --git `, or some line starts with `--- ` and the next starts with
   `+++ ` — unified.

Otherwise the patch has no format: `error: format`.

## 5. Matching

`O` is the old lines (at least one) and `N` the new lines. The first tier with at least one occurrence
of `O` in the file wins:

- Tier 0 — exact: the lines are equal.
- Tier 1 — trailing whitespace: trailing spaces and tabs are removed from both sides before comparing.
- Tier 2 — both ends: leading and trailing spaces and tabs are removed from both sides.

`--strict` allows tier 0 only. No tier means `no-match`. Occurrences may overlap. Each format says
which occurrence it takes. `N` replaces the `k` matched lines. A context line is written as the file's
own matched line, never the patch's. At tier 2, every other `N` line is re-indented: let `F` be the
leading spaces and tabs of the file's first matched line and `P` those of `O`'s first line; an `N` line
that is not empty or whitespace-only and starts with `P` has `P` replaced by `F`; any other line is
written as it is. At tiers 0 and 1, `N` lines are written as they are.

## 6. Unified diffs

A section starts at `diff --git a/<X> b/<Y>` or at a `--- ` + `+++ ` pair not already part of a header.
The header is everything before the first hunk:

- `--- <path>` / `+++ <path>`: the text after the first four characters, up to the first tab, surrounding
  spaces removed. `/dev/null` means no file. A leading `a/` or `b/` is removed from either.
- `rename from` / `rename to`: they name the old and new path when no `---` / `+++` pair does.
- `new file mode` means creation, `deleted file mode` means deletion.
- `diff --git` paths are used when nothing else names one.
- `index`, `old mode`, `new mode`, `similarity index`, `dissimilarity index`, `Index:`, and any other line
  are ignored.
- A `--- ` line not followed by a `+++ ` line inside a header is `error: parse <the line after it>`.
  A `diff --git` line not of the form above is `error: parse <its line>`.

A hunk starts at `@@ -A[,B] +C[,D] @@` (optional text may follow); any other `@@` line is a parse error
at its line, and a hunk before any section is a parse error. `B` and `D` are unused. The body is the
lines after the header starting with ` ` (context), `-` (old), `+` (new), `\`, or empty (an empty line
is an empty context line). The body ends at the first other line, at `diff --git `, at a `--- ` + `+++ `
pair, or at the end of the patch; trailing empty lines are not part of a body. Outside bodies,
non-header lines are ignored (prose, fences).

One section is one edit:

- Creation (the old path is `/dev/null`, or `new file mode`): the new path must not exist, else
  `exists`; the file is the `+` lines of all hunks, in order.
- Deletion (the new path is `/dev/null`, or `deleted file mode`): the old path must exist, else
  `missing`; it is deleted, and the hunks are not read.
- Move (old path ≠ new path): the old path must exist, else `missing`, and the new path must not,
  else `exists`; the hunks are applied to the old file's lines, the result is written at the new path,
  and the old path is deleted.
- Otherwise a change of the one path, which must exist, else `missing`.

Hunks apply in order to the result of the previous ones. `O` is the context + `-` lines, `N` the context
+ `+` lines, in body order. Let `d` be the sum over the hunks applied so far of (the length of `N` minus
the length of `O`). With a non-empty `O`, the occurrence taken is the one at the found tier nearest to
`A - 1 + d` (0-based; ties go to the earlier). With an empty `O`, `N` is inserted after the first
`A + d` lines (all of them, when there are fewer). A `\` line (for example `\ No newline at end of
file`) refers to the body line before it: when the matched lines run to the end of the file (or an
empty-`O` insertion is at the end), the result ends with a line break unless a `\` line follows the
hunk's last context or `+` line; otherwise the file's final break stays. A created file ends with a
line break unless a `\` line follows its last `+` line. Any hunk failure fails the section with that
hunk's code, and the section changes nothing.

## 7. SEARCH/REPLACE

A block is a `<path>` line, `<<<<<<< SEARCH`, old lines, `=======`, new lines, `>>>>>>> REPLACE`. The
three marker lines are matched with their trailing whitespace removed. The path is the nearest line
before `SEARCH`, after the previous block's `>>>>>>> REPLACE` (or the start of the patch), that is not
blank and, trimmed, does not start with three backticks; the path is that line, trimmed. With no such
line, the path is the previous block's path; a first block with none is `error: parse <its SEARCH
line>`. A `SEARCH` line with no `=======` and then `>>>>>>> REPLACE` after it is
`error: parse <the SEARCH line>`. Lines outside blocks are otherwise ignored.

Each block is one edit, in order: with empty old lines, the file is created with the new lines, else
`exists`; otherwise the file must exist, else `missing`, and the old lines must occur at their tier
exactly once, else `ambiguous`; the new lines replace them.

## 8. V4A

The first non-blank line must be `*** Begin Patch`, else `error: parse <that line>` (`error: parse 1`
when there is none); the last non-blank line must be `*** End Patch`, else
`error: parse <patch lines + 1>`; both are compared with their surrounding whitespace removed. Blank
lines at the end of a section (before the next section or `*** End Patch`) are not part of it. Sections
start at `*** Add File: `, `*** Delete File: `, or `*** Update File: ` (the path is the rest of the
line, surrounding spaces removed). Blank lines between sections are ignored. Any other line is
`error: parse <its line>`.

- Add File: the lines start with `+` (the rest is a file line) or are empty (an empty file line).
- Delete File: no lines.
- Update File: optionally `*** Move to: <path>` as its first line, then chunks. A chunk starts at an
  `@@` line (the text after `@@`, its surrounding spaces removed, is the chunk's anchor; an empty anchor
  means no anchor) or, for the first chunk, at a body line. Body lines start with ` `, `-`, `+`, or are
  empty (an empty context line). `*** End of File` ends a chunk and anchors it to the end of the file.
  An Update File section with no chunk and no `*** Move to:` is `error: parse <its Update File line>`.

Each section is one edit, in order: Add File — the path must not exist, else `exists`; the file is the
section's lines, ended by a line break. Delete File — the path must exist, else `missing`; it is
deleted. Update File — the path must exist, else `missing`; with `Move to`, the new path must not,
else `exists`. Chunks apply in order, the cursor starting at line 0. An anchored chunk finds the first
line at or after the cursor equal to the anchor, at the first tier where one is (a single line, §5),
else `no-match`; the cursor moves past it. `O` is the context + `-` lines, `N` the context + `+` lines.
The chunk takes the first occurrence of `O` at or after the cursor, at the first tier with one; an
end-of-file chunk takes only an occurrence ending at the file's last line. With an empty `O`, `N` is
inserted at the cursor, or at the end of the file for an end-of-file chunk. The cursor then moves to
just after the lines written. With `Move to`, the result is written at the new path and the old path
is deleted.

## 9. JSON edits

One JSON array of edit objects, or JSON Lines (one edit object a line, blank lines ignored). In array
form, any fault is `error: parse <the line where the array starts>`; in JSON Lines form, a line not
holding one valid edit object is `error: parse <that line>`. An edit object has a string `path` and a
string `command`; other keys are ignored.

- `create` (`file_text`): the file must not exist, else `exists`; it is written with `file_text`'s
  bytes.
- `str_replace` (`old_str` a non-empty string, `new_str` a string, absent meaning empty): the file
  must exist, else `missing`. In a CRLF file, the file text and both strings are read with every
  `\r\n` as `\n`, and the result is written back with `\r\n`. `old_str` must occur in the text exactly
  once (positions may overlap), else `no-match` or `ambiguous`; it is replaced by `new_str`. No tier:
  the match is exact.
- `insert` (`insert_line` an integer, `new_str` a string): the file must exist, else `missing`, and
  `insert_line` must be between 0 and the number of lines, else `no-match`. `new_str`'s lines (split
  at `\n`, one trailing `\r` removed from each, no empty piece after a final `\n`; an empty `new_str`
  has none) are inserted after line `insert_line` (0 is the top). The file's final break stays as it
  was.

A wrong command, or a missing or mistyped key, is a parse fault.

## 10. Order and atomicity

Edits apply in patch order, to the tree as the earlier edits left it. Every path an edit names is
checked for safety before anything else about it. A failed edit changes nothing, and later edits still
run, so every failure is reported. When any edit failed, no file is written (exit 1). When none failed,
every change is written (exit 0), or with `--check` none is.
