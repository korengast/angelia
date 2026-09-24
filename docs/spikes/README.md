# Spike logs (2026-09-13, Claude Code 2.1.270, haiku-4-5, OAuth seat)

## A1 — spawn per message with --resume
```
turn 1 wall=5.6s in 10 cache_read 12391 cache_create 12789 apiKeySource None
turn 2 wall=5.4s in 10 cache_read 25180 cache_create 683
turn 3 wall=5.0s in 10 cache_read 25863 cache_create 104
```
## A2 — one process, --input-format stream-json
```
t1 {'wall': 4.91, 'ttft': 4.85, 'cache_read': 16411, 'cache_create': 9152}
t2 {'wall': 1.92, 'ttft': 1.87, 'cache_read': 25563, 'cache_create': 186}   # Hebrew, 3 lines
t3 {'wall': 1.24, 'ttft': 1.20, 'cache_read': 25749, 'cache_create': 266}
```
## A2 — 10.5-minute idle gap (a2-gap.log, kept locally and not in the repo; the numbers below are its summary)
```
t3 after 10.5min gap {'wall': 2.0, 'cache_read': 25815, 'cache_create': 99}
```
## Envelope placement (3 turns each, --resume)
```
--append-system-prompt "envelope: chat=N ts=…"  turn2 cache_create 103  turn3 92
"[chat=N ts=…] say ok" in user text            turn2 cache_create 243  turn3 102
```
## A2 permission relay
```
argv: claude -p --input-format stream-json --output-format stream-json --verbose
      --permission-mode default --permission-prompt-tool stdio --session-id <uuid>
stdout: {"type":"control_request","request_id":"6b48…","request":{"subtype":"can_use_tool",
         "tool_name":"Bash","input":{"command":"mkdir -p permtest && date > permtest/stamp.txt …"},
         "permission_suggestions":[{"type":"addRules","rules":[{"toolName":"Bash","ruleContent":"mkdir -p permtest"}…]}]}}
stdin:  {"type":"control_response","response":{"subtype":"success","request_id":"6b48…",
         "response":{"behavior":"allow","updatedInput":{…}}}}
result: "Created the directory, wrote the timestamp…" is_error False
```
## Billing / version check (system init event)
```
apiKeySource= none  permissionMode= acceptEdits  claude_code_version present
```
