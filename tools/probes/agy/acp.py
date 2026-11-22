"""Minimal ACP client for probing `agy acp` (measurement only, not product code).

Usage as a library:
    a = Agy(['agy', 'acp', '--gemini-dir', gdir], log='run.jsonl', perm='allow')
    a.init(); sid = a.new(cwd); a.prompt(sid, 'text'); a.close()
`perm` is 'allow', 'reject', or a callable(params) -> optionId.
Every message in and out goes to the jsonl log with a timestamp.
"""
import json, subprocess, threading, time, os, sys

class Agy:
    def __init__(self, argv, log, perm='reject', cwd=None, stderr=None, env=None):
        self.logf = open(log, 'a')
        self.p = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  stderr=stderr or subprocess.PIPE, text=True, bufsize=1, cwd=cwd, env=env)
        self.perm = perm
        self.nid = 0
        self.resp = {}
        self.events = []  # (t, msg)
        self.perms = []
        self.lock = threading.Lock()
        self.t0 = time.time()
        threading.Thread(target=self._read, daemon=True).start()
        if not stderr:
            self.stderr = []
            threading.Thread(target=lambda: [self.stderr.append(l) for l in self.p.stderr], daemon=True).start()

    def _log(self, d, m):
        self.logf.write(json.dumps({'t': round(time.time() - self.t0, 3), 'dir': d, 'msg': m}) + '\n'); self.logf.flush()

    def _write(self, m):
        self._log('out', m)
        self.p.stdin.write(json.dumps(m) + '\n'); self.p.stdin.flush()

    def _read(self):
        for line in self.p.stdout:
            try: m = json.loads(line)
            except Exception: self._log('raw', line); continue
            self._log('in', m)
            with self.lock: self.events.append((time.time(), m))
            if m.get('method') == 'session/request_permission':
                self.perms.append(m['params'])
                opts = m['params']['options']
                if callable(self.perm): oid = self.perm(m['params'])
                else:
                    want = 'allow' if self.perm == 'allow' else 'reject'
                    o = [o for o in opts if o['kind'] == want + '_once'] or [o for o in opts if o['kind'].startswith(want)]
                    oid = o[0]['optionId'] if o else None
                if oid is None: self._write({'jsonrpc': '2.0', 'id': m['id'], 'result': {'outcome': {'outcome': 'cancelled'}}})
                else: self._write({'jsonrpc': '2.0', 'id': m['id'], 'result': {'outcome': {'outcome': 'selected', 'optionId': oid}}})
            elif 'method' in m and 'id' in m:
                # Any other client request (fs/*, terminal/*): answer method not found.
                self._write({'jsonrpc': '2.0', 'id': m['id'], 'error': {'code': -32601, 'message': 'not supported'}})
            elif 'id' in m:
                self.resp[m['id']] = m

    def req(self, method, params, timeout=240):
        self.nid += 1; i = self.nid
        self._write({'jsonrpc': '2.0', 'id': i, 'method': method, 'params': params})
        end = time.time() + timeout
        while i not in self.resp and time.time() < end and self.p.poll() is None: time.sleep(0.05)
        return self.resp.get(i, {'error': 'timeout or exit', 'rc': self.p.poll()})

    def notify(self, method, params): self._write({'jsonrpc': '2.0', 'method': method, 'params': params})

    def init(self):
        return self.req('initialize', {'protocolVersion': 1, 'clientCapabilities': {'fs': {'readTextFile': False, 'writeTextFile': False}, 'terminal': False}}, 60)

    def new(self, cwd, mcp=None, **kw):
        r = self.req('session/new', {'cwd': cwd, 'mcpServers': mcp or [], **kw}, 90)
        return r

    def prompt(self, sid, text, extra=None, timeout=300):
        n0 = len(self.events)
        blocks = [{'type': 'text', 'text': text}] + (extra or [])
        t = time.time(); r = self.req('session/prompt', {'sessionId': sid, 'prompt': blocks}, timeout)
        dt = time.time() - t
        with self.lock: ev = [m for _, m in self.events[n0:]]
        return r, dt, ev

    def close(self):
        try: self.p.stdin.close()
        except Exception: pass
        t = time.time()
        try: self.p.wait(10)
        except subprocess.TimeoutExpired: self.p.kill(); self.p.wait()
        return round(time.time() - t, 2), self.p.returncode

def summary(ev):
    """Text, tool calls and other updates of a turn, short."""
    out, text = [], ''
    for m in ev:
        if m.get('method') == 'session/update':
            u = m['params']['update']; k = u.get('sessionUpdate')
            if k == 'agent_message_chunk': text += u['content'].get('text', '')
            elif k == 'agent_thought_chunk': pass
            elif k in ('tool_call', 'tool_call_update'):
                out.append(f"{k} name={u.get('name')} title={u.get('title')!r} kind={u.get('kind')} status={u.get('status')} raw={json.dumps(u.get('rawInput'))[:200] if u.get('rawInput') is not None else ''}")
            else: out.append(f"{k} {json.dumps(u)[:200]}")
        elif m.get('method') == 'session/request_permission':
            tc = m['params']['toolCall']
            out.append(f"PERMISSION name={tc.get('name')} id={tc.get('toolCallId')} title={tc.get('title')!r} kind={tc.get('kind')} raw={json.dumps(tc.get('rawInput'))[:300]} options={[o['kind'] for o in m['params']['options']]}")
    return out, text
