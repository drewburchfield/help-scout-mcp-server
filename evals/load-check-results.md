# NAS-1308 — Per-model tool-surface LOAD check

Does each surface load without a provider schema-400? `LOAD`=ok, `FAIL`=schema rejection, `n/a`=quota/config (not a schema issue).

| Surface | tools | gemini-3-flash | gemini-3.1-pro-low | glm-4.7 | gpt-5.5 | gpt-5.4-mini |
|---|---|---|---|---|---|---|
| control-102 (unsanitized) | 102 | **FAIL** | **FAIL** | LOAD | LOAD | LOAD |
| control-102 (sanitized) | 102 | LOAD | LOAD | LOAD | LOAD | LOAD |
| flat-55 (unsanitized) | 55 | LOAD | LOAD | LOAD | LOAD | LOAD |
| flat-55 (sanitized) | 55 | LOAD | LOAD | LOAD | LOAD | LOAD |
| discovery-10 | 10 | LOAD | LOAD | LOAD | LOAD | LOAD |

## Verdict

- control-102 unsanitized fails on Gemini (the `anyOf` 400); sanitized loads → **the sanitizer fixes the cross-model load bug**.
- discovery-10 loads on every reachable model at the smallest footprint.
