# Documentation style and linting

Two linters enforce the mechanical writing rules across every Markdown file in this repo, so nobody has to police them by hand or guess what is allowed. This page lists exactly what they check. The configs are the source of truth: `.markdownlint.json`, `.vale.ini`, and `styles/OpsCoach/`.

Errors fail the build. Warnings are reported but do not. Both linters run on every push and pull request through `.github/workflows/docs-lint.yml`.

## Run them locally

```bash
npx --yes markdownlint-cli2 "**/*.md"   # structure
brew install vale && vale .             # prose (install once)
```

## Vale: the prose rules

These encode the house style and live in `styles/OpsCoach/`. To add a rule, drop a `.yml` there and add a row here, so this table stays the clear, current list as the rules grow.

| Rule | Level | Flags | Do this instead |
| --- | --- | --- | --- |
| `Dashes` | error | the em dash `—` and en dash `–` | a comma, colon, period, or parentheses |
| `BannedWords` | error | `robust`, `scalable`, `seamless`, `comprehensive`, `cutting-edge`, `best-in-class`, `leverage` | cut the word, or show concrete evidence |
| `ThroatClearing` | warning | `in order to`, `it's worth noting`, `note that`, `needless to say` | delete the filler |
| `Hedges` | warning | `a handful of`, `a number of` | give the real number, or cut it |

## markdownlint: the structure rules

This uses markdownlint's default rule set with a few changes, set in `.markdownlint.json`. The full default list is the [markdownlint rules reference](https://github.com/DavidAnson/markdownlint/blob/v0.40.0/doc/Rules.md). What you will actually run into is below.

Turned off:

| Rule | Reason |
| --- | --- |
| `MD013` line length | prose lines wrap on their own |
| `MD033` inline HTML | the architecture doc uses `<details>` and `<br>` |
| `MD036` emphasis as heading | the bold status line at the top of each doc is deliberate |
| `MD060` table pipe style | cosmetic pipe spacing |

`MD024` is relaxed to `siblings_only`: a heading may repeat as long as it is not under the same parent.

Left on, the ones you will meet most:

- one top-level `#` per file, and heading levels go up one at a time
- a blank line around every heading, list, and fenced code block
- one consistent bullet character, no trailing spaces, no hard tabs
- every fenced code block names a language, for example `bash` or `mermaid`
- no bare URLs: wrap them in angle brackets or a `[link](url)`
- the file ends in a single newline

## What the linters cannot check

Part of the rubric is judgment, not mechanics: lead with the point, make each section stand alone, say what you rejected, state non-goals, and stop once you have made the point. No linter catches those. Careful writing and reading the result back are what catch them.
