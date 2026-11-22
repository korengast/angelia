"""Tiny stdio MCP server for probes: one tool `<name>_echo` that returns its text. Usage: mcp_echo.py <name> <logfile>"""
import json, sys
name, log = sys.argv[1], sys.argv[2]
def out(m): sys.stdout.write(json.dumps(m) + '\n'); sys.stdout.flush()
open(log, 'a').write(f'start {name}\n')
for line in sys.stdin:
    m = json.loads(line); open(log, 'a').write(f'{name} <- {m.get("method")}\n')
    if 'id' not in m: continue
    meth = m.get('method')
    if meth == 'initialize':
        out({'jsonrpc': '2.0', 'id': m['id'], 'result': {'protocolVersion': m['params'].get('protocolVersion', '2025-06-18'), 'capabilities': {'tools': {}}, 'serverInfo': {'name': name, 'version': '0'}}})
    elif meth == 'tools/list':
        out({'jsonrpc': '2.0', 'id': m['id'], 'result': {'tools': [{'name': f'{name}_echo', 'description': 'Echo the text back.', 'inputSchema': {'type': 'object', 'properties': {'text': {'type': 'string'}}, 'required': ['text']}}]}})
    elif meth == 'tools/call':
        out({'jsonrpc': '2.0', 'id': m['id'], 'result': {'content': [{'type': 'text', 'text': f'{name} says: ' + m['params']['arguments'].get('text', '')}]}})
    else:
        out({'jsonrpc': '2.0', 'id': m['id'], 'result': {}})
