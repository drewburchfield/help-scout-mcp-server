# NAS-1308 Phase 4b — Tail-Walk Eval

Generated: 2026-06-17T19:39:29.113Z

Agentic multi-turn walk over the **10-tool discovery surface** (7 core + `search_tools`/`get_tool_schema`/`call_tool`). Each task targets a **non-core (tail) tool** reachable only via the meta-tools. Success = the model issues `call_tool({name: <target>, arguments: ...})` with the expected key args within 6 turns. 2 trials per task; success if either trial succeeds.

## Per-model summary

| Model | Tail-reach success | Avg turns-to-success | Notes |
|---|---|---|---|
| gemini-3-flash | 8/8 (100%) | 3.9 |  |
| gemini-3.1-pro-low | 8/8 (100%) | 3.4 |  |
| glm-4.7 | 8/8 (100%) | 3.1 |  |
| gpt-5.5 | n/a | — | quota/cooldown — unavailable |

## Per-task breakdown

| Task target | Models reaching it | Common failure trace |
|---|---|---|
| `getChannelReport` | gemini-3-flash(5t), gemini-3.1-pro-low(3t), glm-4.7(3t) | — |
| `getProductivityReport` | gemini-3-flash(4t), gemini-3.1-pro-low(3t), glm-4.7(3t) | — |
| `getUserReport` | gemini-3-flash(5t), gemini-3.1-pro-low(6t), glm-4.7(3t) | — |
| `getHappinessReport` | gemini-3-flash(5t), gemini-3.1-pro-low(3t), glm-4.7(4t) | — |
| `listTags` | gemini-3-flash(3t), gemini-3.1-pro-low(3t), glm-4.7(3t) | — |
| `getInbox` | gemini-3-flash(3t), gemini-3.1-pro-low(3t), glm-4.7(3t) | — |
| `listWebhooks` | gemini-3-flash(3t), gemini-3.1-pro-low(3t), glm-4.7(3t) | — |
| `getOriginalSource` | gemini-3-flash(3t), gemini-3.1-pro-low(3t), glm-4.7(3t) | — |

## Verdict

**YES** — across available models, 24/24 tail-reach attempts (100%) drove the discovery surface to the correct non-core tool with the right key args (models: gemini-3-flash, gemini-3.1-pro-low, glm-4.7).
