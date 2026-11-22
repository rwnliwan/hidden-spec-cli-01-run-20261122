# Trial log — hidden-spec-cli-01-run-20261122 ("Build mend")

- Bounty slug: `hidden-spec-cli-01-run-20261122`
- Deadline: Tue 24 Nov 2026 22:00 WITA (14:00 UTC). Final phase starts 24 Nov 14:10 UTC (drand round 34242012).
- Prize: $100 total, $10 x 10 places. Must beat the house entry (strict applier, tier-0 exact matching only) — strictly higher mean score on 3 scored instances AND 90% paired t-interval above 0.
- Entry: `main.ts` (Node 22, stdlib only) in repo root, with kit `runner.ts` beside it. Max 1 MiB per file, 4 MiB total source. OSI license (MIT).
- Scoring: 100 checks x 3 scored instances (pool 300: 90 unified, 60 search_replace, 60 v4a, 45 json, 45 cli). Check passes when exit code, stdout and files match exactly. Trial score = round(1000 x passed/100). Final score = mean of 3 instances. Top 750 practice scores go to the final. Current leader @airdropreal02 at 1000.
- Practice: 100 checks in `program/generator/practice.json` (unified 30, search_replace 20, v4a 20, json 15, cli 15). Run with `node check.ts ../program/generator/practice.json` (from the repo dir; starter check.ts path is kit-relative, adjust as needed).
- Kit: `~/workspace/make-fun/hidden-spec-cli-01-run-20261122-kit/`. Spec: `starter/SPEC.md` (v1). Starter `main.ts` implements sections 1-4, 9, 10 (CLI, output, safe paths, format detection, JSON, all-or-nothing). Missing (mine to write): unified (sec 6), SEARCH/REPLACE (sec 7), V4A (sec 8), tiered line matching (sec 5), and `R` move output rows.
- Limits: 1 CPU, 512 MB, 10 s per check run, 180 s wall per trial.

## Trials

| version | main.ts bytes | repo bytes | practice score | passed/100 | by group (u/s/v/j/c) | what changed |
|---|---|---|---|---|---|---|
| v1 | 38,743 | 47,724 | 990 | 99/100 | u 30/30, s 20/20, v 20/20, j 14/15, c 15/15 | first full implementation: unified + search-replace + v4a + tiers + R rows |
| v1.1 | 38,966 | 50,987 | 1000 | 100/100 | u 30/30, s 20/20, v 20/20, j 15/15, c 15/15 | fix j-array: JSON array form detected when first non-blank line *starts with* `[`, not only when it is exactly `[` (array may be one line `[{...},...]`). Re-run confirms 100/100, deterministic (second run also 100/100). |
| v1.2 | 40,395 | 52,416 | 1000 | 100/100 | u 30/30, s 20/20, v 20/20, j 15/15, c 15/15 | reviser: 7 komentar dokumentasi baru saja (exit codes + atomicity, tier per-edit, occurrences per caller, CRLF str_replace, insert_line 0-based, cursor V4A maju saja, write loop), 23 insertions, 0 deletions, logika tidak berubah. Re-run confirms 100/100, deterministik (run ke-2 juga 100/100). |

Notes:
- v1 only miss was j-array (JSON array on a single line). Everything else passed first try, including all unified (u-offset/u-nearest wrong line numbers, u-rename move/R row, u-noeol), all search-replace (s-ambiguous, s-whitespace tier 2), all v4a (v-cursor, v-eof, v-move), and all cli (c-strict, c-check, c-usage, c-unsafe).
- Preflight: main.ts 38,999 B (< 1 MiB), repo 47,980 B (< 4 MiB), imports stdlib only (node:fs, node:path), erasable TypeScript only (no enum/namespace/parameter properties) — safe for Node 22 type stripping. Local node is v24.22.1; grader uses Node 22.
- Hardest format in practice: JSON (the array-form detection edge) — the three line formats were all clean on first run. Unified is the most code-heavy (section/header/hunk parsing, nearest-occurrence, no-EOL handling), but it passed 30/30 immediately.
