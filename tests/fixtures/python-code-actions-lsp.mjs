#!/usr/bin/env node
// Protocol-only ty stand-in. No source edit, command or resolve is performed.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
if (process.argv.includes('--version')) { console.log('ty 0.0.109'); process.exit(0); }
const mode = readFileSync(path.join(process.cwd(), 'preview-mode'), 'utf8');
const audit = { mode, methods: [], forbidden: [], applyEditResult: null };
const auditFile = path.join(process.cwd(), 'preview-audit.json');
let buffer = Buffer.alloc(0), uri;
const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
function save() { writeFileSync(auditFile, JSON.stringify(audit)); }
function send(message) { const body = JSON.stringify(message); process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`); }
function handle(message) {
  if (message.method) audit.methods.push(message.method);
  if (message.id === 'server-edit') audit.applyEditResult = message.result;
  if (message.method === 'initialize') send({ jsonrpc: '2.0', id: message.id, result: { capabilities: {
    definitionProvider: true, referencesProvider: true, hoverProvider: true,
    codeActionProvider: mode === 'unsupported' ? false : { codeActionKinds: mode === 'not-quickfix' ? ['source.organizeImports'] : ['quickfix'], resolveProvider: true },
  } } });
  else if (['textDocument/didOpen', 'textDocument/didChange'].includes(message.method)) {
    uri = message.params.textDocument.uri;
    if (mode !== 'incomplete') send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri, version: message.params.textDocument.version,
      diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } }, severity: 1, source: 'fixture', code: 'unresolved-reference', message: 'fixture missing' }],
    } });
  } else if (message.method === 'textDocument/codeAction') {
    audit.context = message.params.context;
    if (mode === 'error') send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'codeAction unavailable' } });
    else if (mode === 'invalid') send({ jsonrpc: '2.0', id: message.id, result: { invalid: true } });
    else if (mode === 'empty') send({ jsonrpc: '2.0', id: message.id, result: [] });
    else {
      const edit = { changes: { [uri]: [{ range, newText: 'from utils import missing\n' }] } };
      send({ jsonrpc: '2.0', id: 'server-edit', method: 'workspace/applyEdit', params: { edit } });
      send({ jsonrpc: '2.0', id: message.id, result: [
        { title: 'Import edit', kind: 'quickfix', edit },
        { title: 'Disabled', kind: 'quickfix', disabled: { reason: 'not allowed' }, edit },
        { title: 'Deferred partial edit', kind: 'quickfix', data: { selection: 1 }, edit },
        { title: 'Command only', command: 'fixture.command', arguments: [1] },
        { title: 'Command and edit', edit, command: { command: 'fixture.command', arguments: [2] } },
        { title: 'Resource create', edit: { documentChanges: [{ kind: 'create', uri: new URL('new.py', uri).href }] } },
      ] });
    }
  } else if (['workspace/executeCommand', 'codeAction/resolve'].includes(message.method)) {
    audit.forbidden.push(message.method); send({ jsonrpc: '2.0', id: message.id, result: null });
  } else if (message.method === 'shutdown') send({ jsonrpc: '2.0', id: message.id, result: null });
  else if (message.method === 'exit') { save(); process.exit(0); }
  save();
}
process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const end = buffer.indexOf('\r\n\r\n'); if (end < 0) return;
    const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, end).toString())[1]);
    if (buffer.length < end + 4 + length) return;
    const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length)); buffer = buffer.subarray(end + 4 + length); handle(message);
  }
});
