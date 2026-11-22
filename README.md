# mend — one patch tool for every AI edit format

`mend` applies an edit that an AI model wrote to a tree of text files.
Models write edits in four formats, and `mend` reads all of them:

- **unified diff** — often with wrong line numbers (`diff --git`, `---`/`+++`, `@@` hunks)
- **SEARCH/REPLACE blocks** — `<path>` then `<<<<<<< SEARCH` / `=======` / `>>>>>>> REPLACE`
- **V4A patch** — `*** Begin Patch` / `*** Add File:` / `*** Update File:` / `*** End Patch`
- **JSON tool calls** — one edit object per line, or a JSON array of edit objects

Every file is changed or nothing is: if any edit fails, no file is written
and every failure is reported. Matching is fuzzy at three tiers (exact,
trailing whitespace, leading+trailing whitespace) unless `--strict` is given.

## Run

Node 22, standard library only — no dependencies, no network.

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- The working directory is the root of the tree; every path in a patch is relative to it.
- `PATCH` is the patch file, relative to the working directory. When it is
  absent or `-`, the patch is read from standard input.
- `--format=NAME` forces one format: `unified`, `search-replace`, `v4a`,
  `json`, or `auto` (the default, which detects the format).
- `--check` does everything but write: same output and exit code, no file
  is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).
- Options and `PATCH` may come in any order. `--` ends the options.

## Output and exit codes

Stdout holds lines, each ended by `\n`, and nothing else.

- **Exit 2, one line, nothing written:** `error: usage`, `error: no-patch`,
  `error: format`, or `error: parse <N>` (N is the 1-based patch line).
- **Exit 1, nothing written:** one `error: <code> <path>` line per failed
  edit, in patch order, then `failed: <k> of <n> edits`.
  Codes: `no-match`, `ambiguous`, `missing`, `exists`, `unsafe`.
- **Exit 0:** one line per changed path, in byte order, then
  `ok: <n> files` (or `ok: 1 file`):
  `A <path>` created, `D <path>` deleted, `M <path>` modified,
  `R <old> -> <new>` moved. A file whose bytes did not change is not
  listed; a patch that changes nothing prints only `ok: 0 files`.

## Examples

```sh
# apply a unified diff from a file
node main.ts fix.patch

# apply SEARCH/REPLACE blocks from stdin, dry run
cat patch.txt | node main.ts --check -

# force the V4A format
node main.ts --format=v4a change.diff

# exact matching only
node main.ts --strict edit.patch
```

Unified diff example (`fix.patch`):

```diff
--- a/app.py
+++ b/app.py
@@ -1,3 +1,3 @@
 def greet(name):
-    return "hi " + name
+    return "hello " + name
     print("done")
```

SEARCH/REPLACE example:

```text
app.py
<<<<<<< SEARCH
    return "hi " + name
=======
    return "hello " + name
>>>>>>> REPLACE
```

V4A example:

```text
*** Begin Patch
*** Update File: app.py
@@ def greet(name):
-    return "hi " + name
+    return "hello " + name
*** End Patch
```

JSON example (JSON Lines):

```json
{"command": "str_replace", "path": "app.py", "old_str": "    return \"hi \" + name", "new_str": "    return \"hello \" + name"}
```

JSON commands: `create` (`file_text`), `str_replace` (`old_str`,
`new_str`), `insert` (`insert_line`, `new_str`).

## Files

- `main.ts` — the CLI (this is the entry the grader runs as `node main.ts`).
- `runner.ts` — the kit's trial runner; keep as is.
- `check.ts` — runs the practice set: `node check.ts <practice.json>`.
- `SPEC.md` — the full specification (in the kit, not shipped here).
- `LICENSE` — MIT, copyright yangyunkun318.

## Tests

Practice set (100 checks, kit's `program/generator/practice.json`):

```sh
node check.ts ../hidden-spec-cli-01-run-20261122-kit/program/generator/practice.json
# 100 of 100 passed: practice score 1000
```

Extra edge tests (60 cases: empty input, usage errors, unsafe paths,
create/delete/move, nearest-match, CRLF, no-final-newline, ambiguous,
V4A anchors/EOF, atomicity, R sorting, …) live outside this directory
in `~/workspace/makefun-mend/tests/edge.mjs`:

```sh
node ../tests/edge.mjs
# 60 of 60 edge tests passed
```

## License

MIT — see `LICENSE`.
