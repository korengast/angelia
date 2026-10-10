#!/usr/bin/env python3
"""Talk to a running Angelia daemon over its local API. Standard library only; copy it freely.

  python3 angelia_api.py health
  python3 angelia_api.py send telegram:123456 "The backup finished."
  python3 angelia_api.py ask  telegram:123456 "What is on my list today?"
  python3 angelia_api.py turn telegram:123456 "Summarise today's mail."   # prints the answer as it comes

The socket and the owner token are in ~/.angelia (ANGELIA_STATE_DIR moves it). Inside a chat's
agent, ANGELIA_API_TOKEN is that agent's own token: it works for send, ask and turn into its own
chat, but it cannot read the event stream, so `turn` here needs the owner's token.
Contract: GET /openapi.json on the same socket, or https://useangelia.com/docs/api.md
"""
import http.client
import json
import os
import socket
import sys
import urllib.parse

STATE = os.environ.get('ANGELIA_STATE_DIR') or os.path.expanduser('~/.angelia')
SOCKET = os.path.join(STATE, 'api.sock')


def token():
    t = os.environ.get('ANGELIA_API_TOKEN')
    if t:
        return t
    with open(os.path.join(STATE, 'api.token')) as f:
        return f.read().strip()


class UnixConnection(http.client.HTTPConnection):
    """HTTP over the daemon's Unix socket."""

    def __init__(self, path, timeout=None):
        super().__init__('localhost', timeout=timeout)
        self.socket_path = path

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        if self.timeout is not None:
            self.sock.settimeout(self.timeout)
        self.sock.connect(self.socket_path)


def call(method, path, body=None, timeout=660):
    """One request; returns the JSON answer, or raises with the daemon's own error text."""
    conn = UnixConnection(SOCKET, timeout)
    headers = {'Authorization': f'Bearer {token()}'}
    data = None
    if body is not None:
        headers['Content-Type'] = 'application/json'
        data = json.dumps(body)
    conn.request(method, path, data, headers)
    res = conn.getresponse()
    out = json.loads(res.read() or b'null')
    if res.status >= 400:
        raise RuntimeError(f'{res.status}: {out.get("error") if isinstance(out, dict) else out}')
    return out


def open_events(key):
    """Open a chat's event stream. Returns a function that yields each event as a dict."""
    conn = UnixConnection(SOCKET)
    conn.request('GET', '/events?key=' + urllib.parse.quote(key), headers={'Authorization': f'Bearer {token()}'})
    res = conn.getresponse()  # returns once the stream is open: nothing after this is missed
    if res.status != 200:
        raise RuntimeError(f'{res.status}: {json.loads(res.read()).get("error")}')

    def events():
        while True:
            line = res.readline()
            if not line:
                return
            if line.startswith(b'data: '):
                yield json.loads(line[6:])
    return events


def turn(key, text):
    """Give the chat's agent a task and print what the chat gets, until the turn ends."""
    events = open_events(key)  # before the turn, so its first event is not missed
    turn_id = call('POST', '/turn', {'key': key, 'text': text})['turn']
    mine = False
    for e in events():
        if e['type'] == 'turn':
            mine = e['turn'] == turn_id
        elif e['type'] == 'out' and mine:
            print(e['text'], flush=True)
        elif e['type'] == 'turn-end' and e['turn'] == turn_id:
            if not e['ok']:
                sys.exit(f'the turn failed: {e.get("reason", "no reason given")}')
            return


def main(argv):
    if len(argv) >= 1 and argv[0] == 'health':
        print(json.dumps(call('GET', '/healthz')))
    elif len(argv) >= 3 and argv[0] == 'send':
        call('POST', '/send', {'key': argv[1], 'text': ' '.join(argv[2:])})
        print('sent')
    elif len(argv) >= 3 and argv[0] == 'ask':
        print(call('POST', '/ask', {'key': argv[1], 'text': ' '.join(argv[2:])})['answer'])
    elif len(argv) >= 3 and argv[0] == 'turn':
        turn(argv[1], ' '.join(argv[2:]))
    else:
        sys.exit(__doc__)


if __name__ == '__main__':
    main(sys.argv[1:])
