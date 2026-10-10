# Build on Angelia: the local API

A running Angelia daemon has an HTTP API for scripts and apps on the same machine. The `angelia send`,
`turn`, `ask` and `send-media` commands use it, and so does the desktop app. You can use it too: post
from a cron job, give a chat a task when a build finishes, show a chat's answers in your own tool, or
answer permission requests from somewhere else.

The full contract is an OpenAPI 3.1 document: [`api/openapi.json`](api/openapi.json). A running daemon
serves its own copy at `GET /openapi.json`, and `angelia api spec` prints it. Both match the version you
have installed.

## For agents

If you are an AI agent that writes code against Angelia, read these, in this order:

1. `GET /openapi.json` on the socket (no token), or `angelia api spec`: every route, field, error and
   example of the installed version. Routes tagged `stable` are the ones to use.
2. `angelia guide api`: the same in one screen, with the token rules.
3. The tested clients in [`examples/api`](https://github.com/korengast/angelia/tree/main/examples/api):
   Python with the standard library only, Node with no packages, and curl. Each one sends a line,
   asks a question, and gives a task and prints its answer. Copy one rather than start from nothing.

If you run inside an Angelia chat, use `angelia send`, `send-media`, `ask` and `turn`. They find the
socket and your token (`ANGELIA_API_TOKEN`) for you. Your token works for your own chat. It cannot
read anything, the event stream included, so a script that waits for a task's answer needs the
owner's token.

On the web: [useangelia.com/llms.txt](https://useangelia.com/llms.txt) lists these pages, and
[useangelia.com/llms-full.txt](https://useangelia.com/llms-full.txt) has them all in one file.

## Where it listens

The API listens on a Unix socket, `~/.angelia/api.sock` (mode 600). If `ANGELIA_STATE_DIR` is set, the
socket and the token are in that folder instead of `~/.angelia`. It never opens a network port, so
no web page and no other machine can reach it. Only your user can reach it, and only on this machine.

```sh
curl --unix-socket ~/.angelia/api.sock http://localhost/healthz
# {"ok":true,"api":1,"features":["command","files","views"]}
```

Most HTTP clients can use a Unix socket: `curl --unix-socket`, Node's `http.request({ socketPath })`,
Python's `requests-unixsocket` or `httpx` with a `uds` transport, Go's `net.Dial("unix", …)`.

## Tokens

Send the token in the `Authorization: Bearer <token>` header.

- The owner token is in `~/.angelia/api.token` (mode 600). It works for every routed chat and every route.
- An agent gets its own token in `ANGELIA_API_TOKEN`. It works for that agent's own chat. With the
  agent's own chat in `from`, it also works for another profile's chat when neither profile is isolated:
  `/send` always, `/ask` when the target lists the agent's profile in `answer_from`, and `/turn` when the
  target lists it in `accept_from`. It never attaches files to another profile's chat, and it cannot
  read anything.

Every route says which token it takes. A wrong token gets `403`.

## Quick start

```sh
T=$(cat ~/.angelia/api.token)
S=~/.angelia/api.sock

# Post a line into a chat. No agent runs.
curl -s --unix-socket $S -H "Authorization: Bearer $T" -H 'content-type: application/json' \
  -d '{"key":"telegram:123456","text":"The backup finished."}' http://localhost/send

# Give the chat's agent a task. The answer goes to the chat.
curl -s --unix-socket $S -H "Authorization: Bearer $T" -H 'content-type: application/json' \
  -d '{"key":"telegram:123456","text":"Summarise today'"'"'s mail."}' http://localhost/turn
# {"ok":true,"queued":true,"turn":"7f0c…"}

# Ask the chat's agent a question and get the answer here. A read-only copy of the session answers.
curl -s --unix-socket $S -H "Authorization: Bearer $T" -H 'content-type: application/json' \
  -d '{"key":"telegram:123456","text":"What is on my list for today?"}' http://localhost/ask

# Watch everything that happens, live.
curl -sN --unix-socket $S -H "Authorization: Bearer $T" 'http://localhost/events?key=telegram:123456'
```

To get the answer to a task in a script:

1. Open `GET /events?key=<chat>` first, so that you miss no event.
2. Send `POST /turn`. Keep the `turn` id from its answer.
3. Read the events. A `turn` event starts a turn: if its `turn` is your id, the `out` events after it
   are your answer. Turns in one chat run one after the other, so this holds until the next `turn`
   event.
4. Stop at the `turn-end` event whose `turn` is your id. `ok: false` comes with a `reason`.

By default the answer also goes to the chat, as if the owner had written there. With
`"reply": "caller"` (owner's token only), the answer goes only to the event stream and the chat sees
nothing. For a question rather than a task, `POST /ask` is simpler: the answer is the response.

The same in Python, with the standard library only (`examples/api/angelia_api.py` is the full client):

```python
import http.client, json, os, socket

STATE = os.environ.get('ANGELIA_STATE_DIR') or os.path.expanduser('~/.angelia')
TOKEN = open(os.path.join(STATE, 'api.token')).read().strip()

class Unix(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX)
        self.sock.connect(os.path.join(STATE, 'api.sock'))

def call(method, path, body=None):
    c = Unix('localhost', timeout=660)
    c.request(method, path, json.dumps(body) if body else None,
              {'Authorization': f'Bearer {TOKEN}', 'Content-Type': 'application/json'})
    r = c.getresponse(); out = json.loads(r.read())
    if r.status >= 400: raise RuntimeError(out['error'])
    return out

key = 'telegram:123456'
stream = Unix('localhost'); stream.request('GET', f'/events?key={key}', headers={'Authorization': f'Bearer {TOKEN}'})
events = stream.getresponse()                       # 1. the stream is open
turn = call('POST', '/turn', {'key': key, 'text': 'Summarise today.'})['turn']   # 2.
mine = False
for line in events:                                 # 3.
    if not line.startswith(b'data: '): continue
    e = json.loads(line[6:])
    if e['type'] == 'turn': mine = e['turn'] == turn
    elif e['type'] == 'out' and mine: print(e['text'])
    elif e['type'] == 'turn-end' and e['turn'] == turn: break   # 4.
```

A chat key is `platform:chat`, such as `telegram:123456` or `whatsapp:1203630000…@g.us` for a WhatsApp
group. `angelia profiles --json` lists the keys of your chats.

## The stable routes

| Route | What it does |
| --- | --- |
| `GET /healthz` | The daemon is up; the API version (`api`) and the `features` it has. No token. |
| `GET /openapi.json` | The full contract of this daemon, as OpenAPI 3.1. No token. |
| `POST /send` | Post a line into a chat. A `MEDIA:<absolute path>` line in the text attaches that file. |
| `POST /send-media` | Attach a file to a chat, with an optional caption. |
| `POST /turn` | Type a prompt into a chat's session. With `reply: "caller"`, the answer goes to the event stream only, not to the chat. |
| `POST /ask` | Ask a chat's agent a question and wait for the answer (up to ten minutes). The chat does not get the answer. |
| `GET /events` | Server-sent events: turns, progress, answers, permission requests. |
| `GET /profiles` | Profiles, their chats and their sessions. |
| `GET /sessions` | One chat's sessions. |
| `GET /history` | One chat's conversation, read from the CLI's own session files. Newest page first, items oldest first in a page; `before=<cursor>` for older. |
| `GET /permissions` | Permission requests that wait for an answer now, in every chat (each has its `key`). |
| `POST /permission` | Answer one: `{ "key", "id", "allow": true }`. |
| `GET /jobs` | A profile's scheduled jobs and their last runs. |

Errors come back as `{ "error": "…" }` with an HTTP status. The text is safe to show to a person.
A request body is a JSON object of at most 256 KB: other bodies get `400` or `413`. A chat that already
holds 10 turns, running and waiting, answers `/turn` with `429`.

## What "stable" means

The document tags each route `stable` or `internal`.

- **Stable** routes are version 1 of the contract. In version 1 they only grow: a new optional field
  in a request, a new field or a new event type in an answer, a new route. A change that could break a
  client (a field removed or renamed, a different meaning, a stricter rule on what is sent) makes
  version 2. `GET /healthz` gives the version as `api`.
- **Internal** routes serve Angelia's own clients: the desktop app and the CLI. They can change in
  any release. Do not build on them.

To stay compatible:

- Check `api` in `/healthz` and refuse a version you do not know.
- Ignore fields and event types you do not know.
- Use `features` in `/healthz` to find out if this daemon has something newer than version 1 started with.

## Events

`GET /events` is a server-sent event stream. Each `data:` line is one JSON event with `type`, `key`
(the chat) and `at` (ISO time):

- `turn`: a turn started (`turn` id, `text`, `sender`, `surface`: `chat` or `app`, `queued`).
- `progress`: a line the agent said along the way.
- `out`: a line the chat got.
- `permission`: the agent waits for a yes or a no (`id`, `tool`, `preview`).
- `permission-answered`: someone answered it (`by`: `chat`, `app`, `timeout` or `terminal`).
- `turn-end`: the turn finished (`turn` id, `ok`, `reason` when it failed, `queued`: turns still waiting).

Every event also has `key` and `at`. The OpenAPI document has the full shape of each.

`POST /turn` returns the turn's id, so you can find its events in the stream. A client that stops
reading is disconnected. Connect again, and read what you missed from `/history`.

## Not in the API

- No network port, and no remote access. Angelia does not run a server for you on the internet.
- No way to change the routing table, profiles or capabilities. Edit `routing.yaml` and run
  `angelia compile`, as the guide says (`angelia guide`).
- No copy of your messages. `/history` reads each CLI's own record.

## For contributors

The route table in `src/daemon/api/routes.ts` is the one source. The server answers only the routes
in it, and `npm run openapi` writes `docs/api/openapi.json` from it. The tests fail when the document
is out of date, when an example in it does not work against a real daemon, when an answer (or a
documented example answer) does not have the documented shape, when `angelia guide api` leaves out a
stable route, or when a client in `examples/api` stops working. The build fails when a schema and the
TypeScript type it describes differ.
