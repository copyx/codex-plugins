#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
if (process.argv.includes('--version')) { console.log('ty 0.0.109'); process.exit(0); }
const mode = readFileSync(path.join(process.cwd(), 'rename-mode'), 'utf8');
const audit = { mode, methods: [], forbidden: [], applyEditResult: null }, file = path.join(process.cwd(), 'rename-audit.json');
const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } };
let buffer = Buffer.alloc(0), uri;
function send(message) { const body = JSON.stringify(message); process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`); }
function save() { writeFileSync(file, JSON.stringify(audit)); }
function handle(message) {
  if (message.method) audit.methods.push(message.method);
  if (message.id === 'server-edit') audit.applyEditResult = message.result;
  if (message.method === 'initialize') send({ jsonrpc: '2.0', id: message.id, result: { capabilities: {
    definitionProvider: true, referencesProvider: true, hoverProvider: true,
    renameProvider: mode === 'unsupported' ? false : mode === 'no-prepare' ? true : { prepareProvider: true },
  } } });
  else if (message.method === 'textDocument/didOpen') uri = message.params.textDocument.uri;
  else if (message.method === 'textDocument/prepareRename') {
    if (mode === 'prepare-error') send({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'prepare fixture failure' } });
    else send({ jsonrpc: '2.0', id: message.id, result: mode === 'no-symbol' ? null : mode === 'bad-prepare' ? { invalid: true } : mode === 'default' ? { defaultBehavior: true } : mode === 'false-default' ? { defaultBehavior: false } : mode === 'range' ? range : { range, placeholder: 'old' } });
  } else if (message.method === 'textDocument/rename') {
    if (mode === 'error') send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'rename fixture failure' } });
    else {
      const edit = { changes: { [uri]: [{ range, newText: message.params.newName }] } };
      send({ jsonrpc: '2.0', id: 'server-edit', method: 'workspace/applyEdit', params: { edit } });
      const result = mode === 'null-edit' ? null : mode === 'empty-edit' ? {} : mode === 'invalid-result' ? []
        : mode === 'command' ? { ...edit, command: 'unsafe.command' }
        : mode === 'document' ? { documentChanges: [{ textDocument: { uri, version: 1 }, edits: [{ range, newText: message.params.newName }] }] }
        : mode === 'external' ? { changes: { 'file:///outside/secret.py': [{ range, newText: message.params.newName }] } }
        : mode === 'resource' ? { documentChanges: [{ kind: 'rename', oldUri: uri, newUri: new URL('renamed.py', uri).href }] } : edit;
      send({ jsonrpc: '2.0', id: message.id, result });
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
