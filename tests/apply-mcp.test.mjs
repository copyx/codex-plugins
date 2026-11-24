import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, realpath, symlink, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mcp, value } from './helpers/mcp.mjs';

const ts = process.env.TEST_TYPESCRIPT_DIR;
async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'typescript-lsp-apply-mcp-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'node_modules')); await symlink(path.resolve(ts), path.join(root, 'node_modules/typescript'));
  const files = {
    'tsconfig.json': '{"compilerOptions":{"strict":true},"include":["*.ts"]}',
    'main.ts': 'export const answer = square(2);\n',
    'utils.ts': 'export function square(value: number) { return value * value; }\n',
    'model.ts': 'export class Greeter { value = 1; }\n',
    'consumer.ts': 'import { Greeter } from "./model";\nexport const instance = new Greeter();\n',
    'unrelated.ts': 'export function local() { class Greeter { value = 2; } return new Greeter(); }\n',
    'empty.ts': '// no symbol\n',
  };
  for (const [file, text] of Object.entries(files)) await writeFile(path.join(root, file), text);
  return { root, files };
}
const quickfix = root => ({ workspace_root: root, file: 'main.ts', range: { start: { line: 1, character: 23 }, end: { line: 1, character: 29 } } });
const rename = root => ({ workspace_root: root, file: 'model.ts', line: 1, character: 14, new_name: 'NamedGreeter' });

test('#29 real MCP selected import fix applies edit-only no-op command proof and returns fresh diagnostics', { skip: !ts && 'set TEST_TYPESCRIPT_DIR', timeout: 30000 }, async t => {
  const { root } = await fixture(t); const args = quickfix(root);
  const first = await mcp(root, [{ name: 'code_actions_preview', arguments: args }]);
  const selected = value(first.calls[0]).result.find(a => a.title.includes('Add import'));
  assert.ok(selected); assert.equal(selected.status, 'requires_command');
  const applied = await mcp(root, [{ name: 'code_action_apply', arguments: { ...args, selection_id: selected.selection_id } }]);
  const tool = applied.tools.find(t => t.name === 'code_action_apply'); assert.equal(tool?.annotations.readOnlyHint, false);
  const result = value(applied.calls[0]); assert.equal(result.status, 'applied', JSON.stringify(result));
  assert.equal(result.command_effect.status, 'proven_noop'); assert.equal(result.command_effect.server_version, '6.0.3');
  assert.match(await readFile(path.join(root, 'main.ts'), 'utf8'), /import \{ square \} from/);
  assert.equal(result.diagnostics_status, 'received'); assert.equal(result.diagnostics.length, result.files.length);
  assert.ok(result.diagnostics.every(r => r.status === 'received' && !r.diagnostics.some(d => d.code === 2304)));
  const second = await mcp(root, [{ name: 'code_action_apply', arguments: { ...args, selection_id: selected.selection_id } }]);
  assert.equal(second.calls[0].isError, true); assert.match(second.calls[0].content[0].text, /selection|stale/i);
});

test('#30 real MCP rename changes multiple files without changing a same-spelling unrelated symbol', { skip: !ts && 'set TEST_TYPESCRIPT_DIR', timeout: 30000 }, async t => {
  const { root, files } = await fixture(t); const args = rename(root);
  const selected = value((await mcp(root, [{ name: 'rename_preview', arguments: args }])).calls[0]).result;
  const response = await mcp(root, [{ name: 'rename_apply', arguments: { ...args, selection_id: selected.selection_id } }]);
  assert.equal(response.tools.find(t => t.name === 'rename_apply')?.annotations.readOnlyHint, false);
  const result = value(response.calls[0]); assert.equal(result.status, 'applied', JSON.stringify(result)); assert.equal(result.files.length, 2);
  assert.equal(result.diagnostics_status, 'received'); assert.equal(result.diagnostics.length, 2);
  assert.match(await readFile(path.join(root, 'model.ts'), 'utf8'), /class NamedGreeter/);
  assert.match(await readFile(path.join(root, 'consumer.ts'), 'utf8'), /import \{ NamedGreeter \}/);
  assert.equal(await readFile(path.join(root, 'unrelated.ts'), 'utf8'), files['unrelated.ts']);
  const repeated = await mcp(root, [{ name: 'rename_apply', arguments: { ...args, selection_id: selected.selection_id } }]);
  assert.equal(repeated.calls[0].isError, true);
});

test('write MCP tools reject stale or forged context and client-submitted edits without writes', { skip: !ts && 'set TEST_TYPESCRIPT_DIR', timeout: 30000 }, async t => {
  const { root, files } = await fixture(t);
  const args = rename(root); const selected = value((await mcp(root, [{ name: 'rename_preview', arguments: args }])).calls[0]).result;
  await writeFile(path.join(root, 'consumer.ts'), files['consumer.ts'] + '// concurrent edit\n');
  await symlink('/etc/hosts', path.join(root, 'escape.ts'));
  const requests = [
    { name: 'rename_apply', arguments: { ...args, selection_id: selected.selection_id } },
    { name: 'rename_apply', arguments: { ...args, new_name: 'Different', selection_id: selected.selection_id } },
    { name: 'rename_apply', arguments: { ...args, file: 'empty.ts', selection_id: selected.selection_id } },
    { name: 'rename_apply', arguments: { ...args, selection_id: selected.selection_id, edit: selected.edit } },
    { name: 'rename_apply', arguments: { ...args, new_name: 'not valid', selection_id: selected.selection_id } },
    { name: 'rename_apply', arguments: { ...args, file: '../outside.ts', selection_id: selected.selection_id } },
    { name: 'code_action_apply', arguments: { ...quickfix(root), file: 'escape.ts', selection_id: selected.selection_id } },
  ];
  const result = await mcp(root, requests);
  assert.ok(result.calls.every(r => r.isError));
  assert.equal(await readFile(path.join(root, 'model.ts'), 'utf8'), files['model.ts']);
  assert.equal(await readFile(path.join(root, 'consumer.ts'), 'utf8'), files['consumer.ts'] + '// concurrent edit\n');
});
