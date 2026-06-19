# NAS-1308 Phase 4b — Tail-Walk Eval

Generated: 2026-06-19T00:01:20.387Z

Agentic multi-turn walk over the **10-tool compact discovery surface** (7 core + `search_tools`/`get_tool_schema`/`call_tool`). Each task targets a **non-core (tail) tool** reachable only via the meta-tools. Success = the model issues `call_tool({name: <target>, arguments: ...})` with the expected key args within 6 turns. 2 trials per task; success if either trial succeeds.

## Per-model summary

| Model | Tail-reach success | Avg turns-to-success | Notes |
|---|---|---|---|
| gemini-3-flash | 8/9 (89%) | 3.4 |  |
| gemini-3.1-pro-low | 9/9 (100%) | 3.4 |  |
| glm-4.7 | 9/9 (100%) | 3.2 |  |
| gpt-5.5 | 8/9 (89%) | 3.1 |  |

## Discovery mechanism (search vs hint)

For `searchOnly` targets the model MUST use `search_tools` (not reachable via a hint). `pivot` = followed the empty-result guidance to a second tool.

| Task target | type | reached | via mechanism |
|---|---|---|---|
| getChannelReport | search-only | 4/4 | search 4/4 ✓ |
| getProductivityReport | search-only | 4/4 | search 4/4 ✓ |
| getUserReport | search-only | 4/4 | search 4/4 ✓ |
| getHappinessReport | search-only | 4/4 | search 4/4 ✓ |
| listTags | search-only | 4/4 | search 4/4 ✓ |
| listWebhooks | search-only | 4/4 | search 4/4 ✓ |
| getInbox | hint-ok | 4/4 | search,search,search,search |
| getOriginalSource | hint-ok | 3/4 | search,search,search |
| searchCustomersByEmail | pivot | 3/4 | search,search,search |

## Per-task breakdown

| Task target | Models reaching it | Common failure trace |
|---|---|---|
| `getChannelReport` | gemini-3-flash(3t), gemini-3.1-pro-low(3t), glm-4.7(3t), gpt-5.5(3t) | — |
| `getProductivityReport` | gemini-3-flash(4t), gemini-3.1-pro-low(3t), glm-4.7(3t), gpt-5.5(4t) | — |
| `getUserReport` | gemini-3-flash(4t), gemini-3.1-pro-low(6t), glm-4.7(4t), gpt-5.5(3t) | — |
| `getHappinessReport` | gemini-3-flash(3t), gemini-3.1-pro-low(3t), glm-4.7(3t), gpt-5.5(3t) | — |
| `listTags` | gemini-3-flash(3t), gemini-3.1-pro-low(3t), glm-4.7(3t), gpt-5.5(3t) | — |
| `listWebhooks` | gemini-3-flash(3t), gemini-3.1-pro-low(3t), glm-4.7(3t), gpt-5.5(3t) | — |
| `getInbox` | gemini-3-flash(3t), gemini-3.1-pro-low(3t), glm-4.7(3t), gpt-5.5(3t) | — |
| `getOriginalSource` | gemini-3.1-pro-low(3t), glm-4.7(3t), gpt-5.5(3t) | gemini-3-flash: budget [search_tools→get_tool_schema→getThreads→searchConversations→] |
| `searchCustomersByEmail` | gemini-3-flash(4t), gemini-3.1-pro-low(4t), glm-4.7(4t) | gpt-5.5: budget [searchConversations→searchConversations→searchConversations→] |

## Verdict

**YES** — across available models, 34/36 tail-reach attempts (94%) drove the discovery surface to the correct non-core tool with the right key args (models: gemini-3-flash, gemini-3.1-pro-low, glm-4.7, gpt-5.5).
