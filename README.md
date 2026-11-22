# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/ukyo9k/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/ukyo9k/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend applies an edit that an AI model wrote to a tree of text files. Models write edits in four formats — a unified diff (often with wrong line numbers), SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool calls as JSON — and mend reads each one the way the specification says. Every file is changed or nothing is: a failed edit is reported, the edits after it still run, and when any edit failed no file is written at all.

## Run it

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

Node 22 and its standard library alone; no dependencies to install. `PATCH` is the path of the patch file, relative to the working directory; when it is absent or `-`, the patch is read from standard input. The working directory is the root of the tree.

- `--format=NAME` reads the patch in one format: `unified`, `search-replace`, `v4a` or `json`; `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code as without it, and no file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

## What it does

- **Unified diffs** — sections from `diff --git` lines or `---`/`+++` pairs, including creations, deletions and renames. Hunks match by content at three tiers (exact, trailing whitespace ignored, leading and trailing whitespace ignored with re-indentation), taking the occurrence nearest the hunk's (often wrong) line number, so wrong line numbers, drifted indentation, CRLF files, files without a final line break, and `\ No newline at end of file` all come out right.
- **SEARCH/REPLACE blocks** — a path line, a `<<<<<<< SEARCH` block and a `>>>>>>> REPLACE` block; an empty old block creates the file, and an old block that occurs more than once is ambiguous.
- **V4A patches** — `*** Begin Patch` … `*** End Patch`, with Add / Delete / Update File sections, `*** Move to:`, `@@` anchors and `*** End of File` chunks applied in order with a cursor.
- **JSON edits** — one JSON array of edit objects, or one edit object per line: `create`, `str_replace` (exact, exactly once) and `insert` (by line number), with CRLF files normalised for the match and written back as CRLF.
- **Safety and atomicity** — every path an edit names is checked (no absolute paths, no `..`, no empty segments) before anything else about it; edits apply in patch order to the tree as earlier edits left it; unsafe, missing, existing, ambiguous and no-match failures are reported per edit.

Exit 0 lists the changed files (`A`, `D`, `M`, or `R old -> new`) and `ok: <n> files`. Exit 1 lists one `error: <code> <path>` line per failed edit and `failed: <k> of <n> edits`. Exit 2 is a single line: `error: usage`, `error: no-patch`, `error: format`, or `error: parse <N>`.

`runner.ts` is the kit's trial harness (kept unchanged): when `MAKEFUN_ENV_URL` is set, `main.ts` hands the trial over to it instead of acting as the CLI.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
