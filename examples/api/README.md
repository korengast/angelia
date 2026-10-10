# Example clients for the local API

Three small clients for a running Angelia daemon. Each one checks health, posts a line, asks a
question, and gives the chat's agent a task. The Python and Node clients also print the task's answer
as it comes. A test runs all three against a real daemon, so they work with the version they ship with.

| File | Needs | Run |
| --- | --- | --- |
| `angelia_api.py` | Python 3, standard library only | `python3 angelia_api.py turn telegram:123456 "Summarise today's mail."` |
| `angelia-api.mjs` | Node 18 or newer, no packages | `node angelia-api.mjs ask telegram:123456 "What is on my list today?"` |
| `curl.sh` | curl and jq | `sh curl.sh send telegram:123456 "The backup finished."` |

They find the socket and the owner's token in `~/.angelia` (`ANGELIA_STATE_DIR` moves it). Inside a
chat's agent, `ANGELIA_API_TOKEN` is used instead. It works for that agent's own chat, but it cannot
read the event stream.

The contract: [docs/api.md](../../docs/api.md), and the OpenAPI document that a running daemon serves at
`GET /openapi.json`.
