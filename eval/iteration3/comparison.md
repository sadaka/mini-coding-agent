# Baseline (Iteration 2) vs Iteration 3

Source: `results/run-1.json`. 6 tasks x 5 runs x 2 versions = 60 runs, claude-haiku-5-5, cost $0.1934 of the $1 limit.
Success is the harness's independent verification (the manifest's command run in the workspace the agent left),
never the agent's own claim. Context tokens are the harness's estimate of what was sent, not billed tokens.

## Headline

| | Baseline | Iteration 3 |
|---|---|---|
| Verified | 30/30 | 30/30 |
| Agent claimed success | 30/30 | 30/30 |
| LLM calls per run | 7 | 7 |
| Context sent per run (tokens) | 4,147 | 4,386 |
| Peak context (tokens) | 952 | 955 |
| Wall time per run | 14.3 s | 13.7 s |
| Navigation calls per run | 0 | 1.50 |

Accuracy is tied at 100 percent, so this evaluation cannot separate the two. There is no evidence that
Iteration 3 is better or worse on success. There is no evidence it is cheaper either.

## What the agent did

| Per run | Baseline | Iteration 3 |
|---|---|---|
| `search` | 3.33 | 2.40 |
| `list_directory` | 0 | 0.97 |
| `find_symbol` | 0 | 0.17 |
| `find_tests` | 0 | 0.37 |
| Files read | 3.57 | 3.77 |
| Relevant files read | 1.33 | 1.33 |
| Irrelevant files read | 1.57 | 1.80 |
| Tool calls before first relevant read | 3.27 | 3.40 |
| Repeated searches | 0 | 0 |

Iteration 3 replaced about one `search` per run with about one `list_directory`. It did not reach a relevant file
sooner and did not read fewer irrelevant files.

## Per task (mean of 5 runs)

| Task | Source | Context tokens | LLM calls | search | list | find_symbol | find_tests | Irrelevant reads | Calls before relevant read |
|---|---|---|---|---|---|---|---|---|---|
| free-shipping-boundary | baseline | 3,839 | 7.8 | 4.2 | 0 | 0 | 0 | 2.0 | 2.8 |
| | current | 4,633 | 8.2 | 4.0 | 0.6 | 0 | 0.2 | 2.4 | 3.6 |
| tax-total-off-by-one-cent | baseline | 5,419 | 8.6 | 3.0 | 0 | 0 | 0 | 1.4 | 4.0 |
| | current | 7,706 | 9.8 | 2.8 | 1.2 | 0.8 | 0.4 | 2.0 | 4.8 |
| euro-price-rendering | baseline | 4,314 | 7.8 | 4.0 | 0 | 0 | 0 | 1.4 | 2.8 |
| | current | 3,080 | 5.2 | 1.0 | 1.0 | 0 | 0 | 1.0 | 3.0 |
| mobile-menu-never-opens | baseline | 3,767 | 6.6 | 3.4 | 0 | 0 | 0 | 2.4 | 4.6 |
| | current | 3,540 | 5.2 | 2.2 | 1.0 | 0 | 0 | 2.6 | 2.8 |
| week-starts-on-monday | baseline | 4,253 | 6.4 | 2.8 | 0 | 0 | 0 | 1.2 | 3.4 |
| | current | 4,280 | 6.4 | 2.6 | 1.0 | 0.2 | 0.4 | 1.4 | 4.2 |
| empty-the-account (unsupported language) | baseline | 3,288 | 6.4 | 2.6 | 0 | 0 | 0 | 1.0 | 2.0 |
| | current | 3,080 | 7.0 | 1.8 | 1.0 | 0 | 1.2 | 1.4 | 2.0 |

Iteration 3 sent more context on two tasks (`tax-total` +42 percent, `free-shipping` +21 percent), less on
`euro-price` (-29 percent), `mobile-menu` (-6 percent) and `empty-the-account` (-6 percent), and was level on
`week-starts` (+1 percent). With five runs per cell and no variance reported, treat only the large gaps as signal,
and treat even those as suggestive.

## Symbol discovery

`find_symbol` was called 5 times in 30 Iteration 3 runs (4 on `tax-total`, 1 on `week-starts`). Per run it
returned 0.17 tree-sitter matches and 0.33 text-search fallback matches, and no irrelevant matches. Too few calls to
compare tree-sitter with text search.

## Limits of this comparison

- Fixture repos have 3 to 13 files. The agent can read most of a repo, so navigation has little to save.
- Haiku 5.5 solves every task, which hides any effect on success (a ceiling).
- n=5 per cell; one provider and model; one run of the whole matrix.
- Context tokens are an estimate. Billed tokens per run were not recorded (only the total, $0.1934).
- The per-call trace (which paths were searched, what each returned) was not saved, so the "what it found" side
  can be summarised only through counts.
