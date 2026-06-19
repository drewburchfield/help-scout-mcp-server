# NAS-1300 — Tool Consolidation Eval (102 → 55 tools)

Generated: 2026-06-17T18:02:52.152Z

Surfaces: **control = 102 tools** (pre-consolidation `a1ab3bb`), **treatment = 55 tools** (current `dev`).
Each cell = mean of 3 trials at temperature 0 against the local OpenAI-compatible proxy. Cells where all 3 trials returned an upstream error (cooldown / capacity / timeout) are excluded as "no data" rather than scored 0, so proxy flakiness is not counted against a model.

## Model availability

| Model | Status | Paired tasks scored | Notes |
|---|---|---|---|
| gemini-3-flash | UNAVAILABLE | 0 | all cells errored (cooldown/capacity during run) |
| gemini-3.1-pro-low | UNAVAILABLE | 0 | all cells errored (cooldown/capacity during run) |
| gpt-5.5 | UNAVAILABLE | 0 | The usage limit has been reached |
| gpt-5.4-mini | UNAVAILABLE | 0 | The usage limit has been reached |
| glm-4.7 | PARTIAL | 17 | 17/20 tasks have both surfaces clean |
| glm-4-plus | UNAVAILABLE | 0 | missing provider baseURL |

## Per-model accuracy (paired tasks only)

| Model | control sel% | treatment sel% | control param% | treatment param% | Δ sel | Δ param |
|---|---|---|---|---|---|---|
| glm-4.7 | 80% | 86% | 80% | 86% | +6pp | +6pp |
| **OVERALL (mean)** | **80%** | **86%** | **80%** | **86%** | **+6pp** | **+6pp** |

## Gate (ideal targets: selection 100%, param 100%; treatment ≥ control on both at ≤ token cost)

Token cost is identical-or-lower for treatment by construction (fewer tools), so the gate reduces to: treatment selection% ≥ control AND treatment param% ≥ control.

| Model | treatment ≥ control sel? | treatment ≥ control param? | token cost ok? | Verdict |
|---|---|---|---|---|
| glm-4.7 | yes | yes | yes | **PASS** |

## Token cost (full tools-list JSON, ≈ chars/4)

- control (102 tools): **17,071 tokens**
- treatment (55 tools): **9,301 tokens**
- savings: **7,770 tokens (46% smaller)** per request

## Per-task breakdown (averaged across scored models; param accuracy)

| # | Task | ctrl sel | trt sel | ctrl param | trt param | Δ param | Result |
|---|---|---|---|---|---|---|---|
| 1 | Find all conversations belonging to customer ID … | 100% | 100% | 100% | 100% | 0pp | equal |
| 2 | Show me support tickets that mention the word 'r… | 100% | 100% | 100% | 100% | 0pp | equal |
| 3 | Which conversations are currently assigned to us… | 100% | 100% | 100% | 100% | 0pp | equal |
| 4 | Get the team's average first response time repor… | n/a | n/a | n/a | n/a | n/a | no data |
| 5 | How many conversations came in, broken down by c… | 0% | 33% | 0% | 33% | +33pp | IMPROVED |
| 6 | Show the company happiness ratings list.… | 0% | 0% | 0% | 0% | 0pp | equal |
| 7 | Get the email channel report.… | n/a | n/a | n/a | n/a | n/a | no data |
| 8 | Get all contact details (emails, phones, address… | 100% | 100% | 100% | 100% | 0pp | equal |
| 9 | Show the custom fields and folders configured on… | 100% | 100% | 100% | 100% | 0pp | equal |
| 10 | Get the raw RFC 822 email source of thread 7 in … | 67% | 100% | 67% | 100% | +33pp | IMPROVED |
| 11 | List the inboxes whose name contains 'Sales'.… | 100% | 100% | 100% | 100% | 0pp | equal |
| 12 | Get conversation 900, preserving the distinction… | 100% | 100% | 100% | 100% | 0pp | equal |
| 13 | What is user 12's current availability status?… | 100% | 100% | 100% | 100% | 0pp | equal |
| 14 | Find conversations that have attachments in inbo… | 100% | 100% | 100% | 100% | 0pp | equal |
| 15 | Show the productivity resolution time report.… | 0% | 33% | 0% | 33% | +33pp | IMPROVED |
| 16 | Get all conversations for organization 33911683.… | 100% | 100% | 100% | 100% | 0pp | equal |
| 17 | Search the knowledge base articles about 'billin… | 100% | 100% | 100% | 100% | 0pp | equal |
| 18 | Get docs site 5 along with its access restrictio… | 100% | 100% | 100% | 100% | 0pp | equal |
| 19 | Get user 7's replies-sent report.… | n/a | n/a | n/a | n/a | n/a | no data |
| 20 | List conversations in 'closed' status from inbox… | 100% | 100% | 100% | 100% | 0pp | equal |

## Verdict

**YES** — across 1 available model(s), treatment (55 tools) beats or matches control (102 tools): selection 80%→86% (+6pp), param 80%→86% (+6pp), at 7,770 fewer tokens/request (46% smaller surface).
