# Tool Surface Discriminator, Thin Screen

Date: 2026-07-19

This is a provisional architecture screen, not the final compatibility evaluation.

## Valid lane

The first evaluation model completed all six frozen jobs against all three candidate surfaces.

| Candidate | Passed | Advertised tools | Advertised tokens | Average turns | Average dynamic result tokens |
| --- | ---: | ---: | ---: | ---: | ---: |
| `registry-3` | 6/6 | 3 | 345 | 3.00 | 964 |
| `hybrid-10` | 6/6 | 10 | 2,034 | 2.67 | 489 |
| `domains-8` | 6/6 | 8 | 1,378 | 2.50 | 2,248 |

The token figures are character-based estimates using four characters per token. Dynamic result cost includes discovery and schema results returned during tool use.

## Blocked lane

The second evaluation model was not run in this cut for infrastructure reasons unrelated to the candidates; those cells were completed in the later production screens recorded below.

The runner accepts `EVAL_MODELS`, so a single lane can be rerun without repeating the others:

```sh
EVAL_MODELS=<model> LOG_LEVEL=error node evals/run-tool-surface-discriminator.mjs
```

## Historical provisional cut

This section records the July 19 first-screen decision. It was superseded by the actual Claude finalist screen and the two-tool control documented below.

At this checkpoint, advance `registry-3` and `hybrid-10`.

Drop `domains-8`. It passed the jobs, but returned the most runtime schema material, induced redundant discovery in the cross-domain job, and depends on clients handling schema discovery through an ordinary tool call. Its small turn-count advantage did not offset those costs.

`registry-3` was the lead at this checkpoint. Its advertised surface was about 1,689 tokens smaller than `hybrid-10`, and its average advertised-plus-dynamic cost in this screen was about 1,309 tokens versus 2,523. `hybrid-10` remained a finalist because direct common operations could avoid discovery and completed the parameter-dense search in one turn.

## Scope caveat

The harness stops once the required capability and key arguments have been reached. It measures tool selection, argument construction, chaining, and safe refusal. It does not score prose answer quality. One trial per cell is directional evidence only.

## Final two-tool control

Date: 2026-07-21

A `registry-2` control merged search and schema inspection. Its `search_tools` result included complete input schemas, followed by the same generic `call_tool` execution path used by `registry-3`. The same six frozen jobs ran through the actual Claude stdio MCP client.

| Candidate | Search result cap | Passed | Advertised tools | Advertised tokens | Average turns | Average dynamic result tokens | Advertised plus dynamic |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `registry-2` | 3 full schemas | 5/6 | 2 | 238 | 5.50 | 3,005 | 3,243 |
| `registry-2` | 5 full schemas | 6/6 | 2 | 238 | 3.17 | 2,089 | 2,327 |
| `registry-3` preserved Claude baseline | 8 summaries, selected schemas loaded separately | 6/6 | 3 | 345 | not preserved | 875 | 1,220 |

The three-result control missed `getConversation`, which ranked fourth or fifth for ordinary conversation wording. The five-result control corrected that retrieval-recall problem and passed all six jobs. It also returned enough schema material to use about 91 percent more advertised-plus-dynamic context than the preserved `registry-3` Claude baseline.

The control supports retaining `registry-3`. The separate schema-inspection step costs one additional advertised tool and about 107 advertised tokens, but avoids returning several unselected schemas on every search. This is still a directional six-job screen, not release certification.

## Production gateway validation

Date: 2026-07-28

The selected `registry-3` shape now ships as production code: `search_help_scout`, `describe_help_scout`, and `read_help_scout` in `src/tools/gateway.ts`, advertised by default over the internal 55-operation registry. The same six frozen jobs ran through the actual Claude stdio MCP client against the compiled production gateway (candidate `production-gateway`, fixture-backed execution).

| Candidate | Passed | Advertised tools | Average turns | Average dynamic result tokens |
| --- | ---: | ---: | ---: | ---: |
| `production-gateway` | 6/6 | 3 | 4.33 | 998 |

All six jobs passed, including the safe refusal of the unsupported write and the cross-domain organization chain. Average dynamic result cost is in line with the preserved `registry-3` prototype baseline (875 tokens). Operation names in the current 55-entry registry remain directly dispatchable for compatibility; names removed in the v2.0.0 consolidation do not dispatch.
