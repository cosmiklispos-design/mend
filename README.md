[![Bounty](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![Rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/cosmiklispos-design/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![Reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/cosmiklispos-design/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

# mend

mend — one patch tool for every AI edit format. It applies a patch written in any of the four formats
AI tools emit — unified diffs, SEARCH/REPLACE blocks, V4A patches, and JSON edits — to a tree of files,
and reports exactly what changed. Matching is fuzzy where the spec allows it: exact, trailing
whitespace, then leading-and-trailing whitespace, with re-indentation at the loosest tier — so a patch
whose lines drifted a little still lands on the right place, and `--strict` turns that off. A failed
edit changes nothing, later edits still run, and when any edit fails nothing is written. See
[SPEC.md](SPEC.md) for the full contract.

## Run it

```sh
node main.ts [options] [PATCH]
```

`PATCH` absent or `-` reads the patch from standard input. `--format=NAME` picks the format
(`unified`, `search-replace`, `v4a`, `json`, or `auto`, the default); `--check` is a dry run;
`--strict` is tier-0 matching only. Try it:

```sh
printf -- '--- a/hello.txt\n+++ b/hello.txt\n@@ -1 +1 @@\n-hello\n+hello, world\n' | node main.ts --format=unified
```

The practice set in the kit scores it: `node check.ts <practice.json>` — 100 of 100 passed,
practice score 1000.

Built for the [make.fun bounty "Build mend, one patch tool for every AI edit format"](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?ref=fhhchmnw).
