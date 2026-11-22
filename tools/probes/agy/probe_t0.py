import sys, json, os, time, subprocess, base64, zlib, struct
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from acp import Agy, summary
S = os.environ.get('AGY_SCRATCH') or os.path.dirname(os.path.abspath(__file__)); WS = S + '/ws'  # a folder with ws/, gdir/ and sb.sb
prof = open(S + '/sb.sb').read()
def argv(tag, extra=()):
    return ['/usr/bin/sandbox-exec', '-p', prof, 'agy', 'acp', '--gemini-dir', S + '/gdir', '--log-file', S + f'/{tag}-agy.log', *extra]
def show(label, r):
    res, dt, ev = r; s, t = summary(ev)
    print(f'=== {label} dt={dt:.1f} res={json.dumps(res.get("result", res))[:160]}')
    for x in s:
        if not x.startswith(('usage_update', 'available_commands')): print('  ', x[:400])
    print('  TEXT', repr(t[:500]))
    return t
def png(rgb):
    raw = b''.join(b'\x00' + bytes(rgb) * 16 for _ in range(16))
    ch = lambda k, d: struct.pack('>I', len(d)) + k + d + struct.pack('>I', zlib.crc32(k + d) & 0xffffffff)
    return b'\x89PNG\r\n\x1a\n' + ch(b'IHDR', struct.pack('>IIBBBBB', 16, 16, 8, 2, 0, 0, 0)) + ch(b'IDAT', zlib.compress(raw)) + ch(b'IEND', b'')
test = sys.argv[1]
if test == 'modes':
    a = Agy(argv('modes'), S + '/modes.jsonl', perm='reject'); a.init(); sid = a.new(WS)['result']['sessionId']
    for mode, p in [('plan', 'Create the file plan.txt in the workspace with the text x using your file writing tool. Do it now, no plan.'),
                    ('accept-edits', 'Use your file writing tool to create acc.txt in the workspace with the text x. Then use your file writing tool to create ' + os.path.expanduser('~/.agy-acc-outside.txt') + ' with x.'),
                    ('accept-edits', 'Run the shell command: ls'),
                    ('auto', 'Run the shell command: ls'),
                    ('auto', 'Run the shell command: rm -f inside.txt'),
                    ('default', 'Use your file writing tool to create def.txt in the workspace with the text x.')]:
        print('SET_MODE', mode, json.dumps(a.req('session/set_mode', {'sessionId': sid, 'modeId': mode}))[:200])
        show(mode + ': ' + p[:60], a.prompt(sid, p))
    print('FILES', sorted(os.listdir(WS))); print('CLOSE', a.close())
elif test == 'settings':
    sp = S + '/gdir/antigravity-cli/settings.json'
    json.dump({'permissions': {'allow': ['command(ls)'], 'deny': ['command(cat)', 'read_file(' + WS + '/notes.txt)']}}, open(sp, 'w'))
    a = Agy(argv('settings'), S + '/settings.jsonl', perm='allow'); a.init(); sid = a.new(WS)['result']['sessionId']
    show('ls (allowed in settings)', a.prompt(sid, 'Run the shell command: ls'))
    show('cat (denied in settings)', a.prompt(sid, 'Run the shell command: cat notes.txt'))
    show('read_file notes (denied)', a.prompt(sid, 'Use your file viewing tool (not shell) to read notes.txt and quote it.'))
    print('CLOSE', a.close()); os.remove(sp)
    p = subprocess.run(['agy', 'acp', '--settings', '{}', '--gemini-dir', S + '/gdir'], input='', capture_output=True, text=True, timeout=30)
    print('ACP --settings rc', p.returncode, p.stderr[-400:], p.stdout[-200:])
    p = subprocess.run(['agy', 'acp', '--mode', 'plan', '--gemini-dir', S + '/gdir'], input='', capture_output=True, text=True, timeout=30)
    print('ACP --mode rc', p.returncode, p.stderr[-400:], p.stdout[-200:])
elif test == 'instr':
    open(WS + '/big.md', 'w').write(('filler line about nothing in particular.\n' * 6000) + 'BIG-MARKER: the tail word is QUOKKA.\n')
    open(WS + '/GEMINI.md', 'w').write('GEMINI-MARKER: the secret color is MAGENTA.\n@big.md\n')
    os.makedirs(WS + '/.agents', exist_ok=True)
    json.dump({'mcpServers': {'wssrv': {'command': 'python3', 'args': ['' + os.path.dirname(os.path.abspath(__file__)) + '/mcp_echo.py', 'wssrv', S + '/mcp.log']}}}, open(WS + '/.agents/mcp_config.json', 'w'))
    a = Agy(argv('instr'), S + '/instr.jsonl', perm='reject'); a.init(); sid = a.new(WS)['result']['sessionId']
    show('markers', a.prompt(sid, 'Without using any tools: quote, verbatim, every line in your context (system prompt, user rules, memories, imported files) that contains the text MARKER, and say where each came from. Then list every MCP server name you know of.'))
    print('CLOSE', a.close())
elif test == 'sessions':
    a = Agy(argv('sess1'), S + '/sess1.jsonl', perm='reject'); print('INIT caps', json.dumps(a.init()['result']['agentCapabilities'])[:300])
    sid = a.new(WS)['result']['sessionId']; print('SID', sid)
    show('remember', a.prompt(sid, 'Remember the word KIWI. Reply only: ok'))
    print('LIST', json.dumps(a.req('session/list', {'cwd': WS}))[:600])
    print('CLOSE_SESSION', json.dumps(a.req('session/close', {'sessionId': sid}))[:200])
    show('after close', a.prompt(sid, 'What word? one word.'))
    print('CLOSE', a.close())
    for meth in ('session/resume', 'session/load'):
        tag = meth.split('/')[1]
        b = Agy(argv(tag), S + f'/sess-{tag}.jsonl', perm='reject'); b.init()
        n0 = len(b.events); t = time.time()
        r = b.req(meth, {'sessionId': sid, 'cwd': WS, 'mcpServers': []})
        time.sleep(1); replay = [m for _, m in b.events[n0:] if m.get('method') == 'session/update']
        print(meth, 'dt', round(time.time() - t, 1), 'reply', json.dumps(r)[:300], 'updates', len(replay), [m['params']['update']['sessionUpdate'] for m in replay][:12])
        show(meth + ' then ask', b.prompt(sid, 'Which word did I ask you to remember? One word.'))
        print('CLOSE', b.close())
    print('CONV FILES', os.listdir(S + '/gdir/antigravity-cli/conversations')[:20])
elif test == 'model':
    a = Agy(argv('model'), S + '/model.jsonl', perm='reject'); a.init()
    r = a.new(WS, model='gemini-4-hydrogen-high'); print('NEW with model param current', r['result']['models']['currentModelId']); sid = r['result']['sessionId']
    print('SET_MODEL', json.dumps(a.req('session/set_model', {'sessionId': sid, 'modelId': 'gemini-4-hydrogen-high'}))[:300])
    print('SET_MODEL bad', json.dumps(a.req('session/set_model', {'sessionId': sid, 'modelId': 'gemini-9-nope'}))[:300])
    print('SET_CONFIG thought_level', json.dumps(a.req('session/set_config_option', {'sessionId': sid, 'configId': 'thought_level', 'value': 'low'}))[:900])
    show('which model', a.prompt(sid, 'Reply with one word: pong'))
    print('SET_MODEL xhigh', json.dumps(a.req('session/set_model', {'sessionId': sid, 'modelId': 'gemini-4-hydrogen-xhigh'}))[:300])
    print('SET_CONFIG model', json.dumps(a.req('session/set_config_option', {'sessionId': sid, 'configId': 'model', 'value': 'gemini-3.8-flash'}))[:900])
    print('CLOSE', a.close())
    for l in open(S + '/model-agy.log'):
        if 'model' in l.lower() and ('hydrogen' in l or 'flash' in l): print('LOG', l[:250].rstrip())
elif test == 'after':
    a = Agy(argv('after'), S + '/after.jsonl', perm='allow'); a.init(); sid = a.new(WS)['result']['sessionId']
    show('bg', a.prompt(sid, 'Start the shell command `sleep 25; echo BGDONE` as a background task (do not wait for it), then end your turn immediately with the text: started. When it finishes later, tell me its output.'))
    n0 = len(a.events); t = time.time(); time.sleep(75)
    ev = [m for _, m in a.events[n0:]]
    print('AFTER-TURN messages', len(ev)); s, txt = summary(ev)
    for x in s:
        if not x.startswith('usage_update'): print('  ', x[:300])
    print('  TEXT', repr(txt[:400]))
    print('CLOSE', a.close())
elif test == 'image':
    a = Agy(argv('image'), S + '/image.jsonl', perm='reject'); a.init(); sid = a.new(WS)['result']['sessionId']
    img = {'type': 'image', 'mimeType': 'image/png', 'data': base64.b64encode(png((220, 20, 20))).decode()}
    show('image', a.prompt(sid, 'What single colour fills this image? One word.', [img]))
    show('refused only', a.prompt(sid, 'Run the shell command `ls -la` and show the output.'))
    print('CLOSE', a.close())
elif test == 'perf':
    a = Agy(argv('perf'), S + '/perf.jsonl', perm='reject'); t = time.time(); a.init(); sid = a.new(WS)['result']['sessionId']; print('startup init+new', round(time.time() - t, 1))
    ds = []
    for i in range(5):
        res, dt, ev = a.prompt(sid, f'Reply with the single word pong{i}'); ds.append(round(dt, 1))
    print('TURNS', ds)
    ps = subprocess.run(['ps', '-axo', 'pid=,ppid=,rss=,comm='], capture_output=True, text=True).stdout.split('\n')
    rows = [l.split(None, 3) for l in ps if l.strip()]; kids = {a.p.pid}; tot = 0
    for _ in range(4):
        for r in rows:
            if int(r[1]) in kids: kids.add(int(r[0]))
    for r in rows:
        if int(r[0]) in kids: tot += int(r[2]); print('PROC', r[0], r[1], int(r[2]) // 1024, 'MB', r[3][-60:])
    print('TOTAL RSS MB', tot // 1024)
    print('CLOSE (secs, rc)', a.close()); print('STDERR lines', len(a.stderr), ''.join(a.stderr)[-600:])
    time.sleep(1); left = subprocess.run(['pgrep', '-fl', 'gdir'], capture_output=True, text=True).stdout; print('LEFT', left[-300:])
elif test == 'tools2':
    a = Agy(argv('tools2'), S + '/tools2.jsonl', perm='allow'); a.init(); sid = a.new(WS)['result']['sessionId']
    show('read outside', a.prompt(sid, 'Use your file viewing tool (not the shell) to read /etc/hosts and quote its first line.'))
    show('subagent write', a.prompt(sid, 'Use invoke_subagent to start one subagent that must create the file sub.txt in the workspace with the text fromsub using its file writing tool. Wait for it, then report.'))
    show('read_url', a.prompt(sid, 'Fetch the page https://example.com with a URL-reading tool if you have one (not the shell) and quote its title. If you have no such tool, say NOTOOL.'))
    print('FILES', sorted(os.listdir(WS))); print('CLOSE', a.close())
elif test == 'sub':
    a = Agy(argv('sub'), S + '/sub.jsonl', perm='allow'); a.init(); sid = a.new(WS)['result']['sessionId']
    show('subagent write', a.prompt(sid, 'Use invoke_subagent to start one subagent that must create the file sub.txt in the workspace with the text fromsub using its write_file tool. Then end your turn with: started.'))
    n0 = len(a.events); time.sleep(90); ev = [m for _, m in a.events[n0:]]
    print('AFTER-TURN messages', len(ev)); s, txt = summary(ev)
    for x in s:
        if not x.startswith('usage_update'): print('  ', x[:300])
    print('  TEXT', repr(txt[:400])); print('FILES', sorted(os.listdir(WS))); print('CLOSE', a.close())
