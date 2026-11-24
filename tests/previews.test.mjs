import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mcp, value } from './helpers/mcp.mjs';

const ts = process.env.TEST_TYPESCRIPT_DIR;
async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'typescript-lsp-previews-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'node_modules'));
  await symlink(path.resolve(ts), path.join(root, 'node_modules/typescript'));
  const files = {
    'a/tsconfig.json': '{"compilerOptions":{"strict":true},"include":["*.ts"]}',
    'a/main.ts': 'import { AlphaSymbol } from "./model";\nexport const instance = new AlphaSymbol();\nexport const answer = square(2);\n',
    'a/model.ts': 'export class AlphaSymbol { value = 1; }\n',
    'a/utils.ts': 'export function square(value: number) { return value * value; }\n',
    'a/empty.ts': '// No symbols here.\n',
    'a/builtin.ts': 'export const numbers: Array<number> = [];\n',
    'b/tsconfig.json': '{"compilerOptions":{"strict":true},"include":["*.ts"]}',
    'b/other.ts': 'export function BetaSymbol() { return true; }\n',
  };
  for (const [file, text] of Object.entries(files)) { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), text); }
  return { root, files };
}
async function unchanged(root, files) { for (const [file, text] of Object.entries(files)) assert.equal(await readFile(path.join(root, file), 'utf8'), text); }

test('#25 project symbols search the anchor project including unopened files, not an unrelated sibling config', { skip: !ts && 'set TEST_TYPESCRIPT_DIR', timeout: 30000 }, async t => {
  const { root, files } = await fixture(t);
  const result = await mcp(root, [
    ...[['a/main.ts', 'square'], ['a/main.ts', 'BetaSymbol'], ['b/other.ts', 'BetaSymbol'], ['a/main.ts', 'NoSuchSymbolZZZ']].map(([file, query]) => ({ name: 'project_symbols', arguments: { workspace_root: root, file, query } })),
    { name: 'project_symbols', arguments: { workspace_root: root, file: '../outside.ts', query: 'x' } },
    { name: 'project_symbols', arguments: { workspace_root: root, file: 'a/main.ts', query: '' } },
  ]);
  const tool = result.tools.find(t => t.name === 'project_symbols');
  assert.ok(tool); assert.deepEqual(tool.inputSchema.required, ['workspace_root', 'file', 'query']); assert.equal(tool.annotations.readOnlyHint, true);
  const a = value(result.calls[0]);
  assert.equal(a.project_root, path.join(root, 'a'));
  assert.equal(a.search_scope.kind, 'selected_project_session');
  assert.equal(a.search_scope.anchor_file, path.join(root, 'a/main.ts'));
  assert.ok(a.result.some(s => s.name === 'square' && s.location.uri.endsWith('/a/utils.ts')));
  assert.deepEqual(value(result.calls[1]).result, []);
  assert.ok(value(result.calls[2]).result.some(s => s.name === 'BetaSymbol'));
  assert.deepEqual(value(result.calls[3]).result, []);
  assert.equal(result.calls[4].isError, true); assert.equal(result.calls[5].isError, true);
  await unchanged(root, files);
});

test('#26 quickfix previews use live diagnostics, retain command requirements, and have stable selection IDs without applying edits', { skip: !ts && 'set TEST_TYPESCRIPT_DIR', timeout: 30000 }, async t => {
  const { root, files } = await fixture(t);
  const input = { workspace_root: root, file: 'a/main.ts', range: { start: { line: 3, character: 23 }, end: { line: 3, character: 29 } } };
  const result = await mcp(root, [
    { name: 'code_actions_preview', arguments: input },
    { name: 'code_actions_preview', arguments: input },
    { name: 'code_actions_preview', arguments: { ...input, file: 'a/empty.ts', range: { start: { line: 1, character: 1 }, end: { line: 1, character: 4 } } } },
  ]);
  const tool = result.tools.find(t => t.name === 'code_actions_preview'); assert.ok(tool); assert.equal(tool.annotations.readOnlyHint, true);
  const first = value(result.calls[0]);
  assert.ok(first.diagnostics.some(d => d.code === 2304));
  const candidate = first.result.find(a => a.title.includes('Add import'));
  assert.ok(candidate, 'Missing import must have a quickfix preview');
  assert.equal(candidate.preview_only, true);
  assert.equal(candidate.status, 'requires_command');
  assert.ok(candidate.command.name);
  assert.match(candidate.selection_id, /^sha256:[a-f0-9]{64}$/);
  assert.ok(candidate.edit.files.some(f => f.edits.some(e => e.new_text.includes('import { square }'))));
  assert.equal(candidate.basis.request.file, path.join(root, 'a/main.ts'));
  assert.equal(candidate.basis.scope.project_root, path.join(root, 'a'));
  assert.equal(candidate.selection_id, value(result.calls[1]).result.find(a => a.title === candidate.title).selection_id);
  assert.deepEqual(value(result.calls[2]).result, []);
  await unchanged(root, files);
});

test('#27 rename previews show declaration/import/references across files, with clear no-symbol results and no writes', { skip: !ts && 'set TEST_TYPESCRIPT_DIR', timeout: 30000 }, async t => {
  const { root, files } = await fixture(t);
  const result = await mcp(root, [
    { name: 'rename_preview', arguments: { workspace_root: root, file: 'a/model.ts', line: 1, character: 14, new_name: 'RenamedSymbol' } },
    { name: 'rename_preview', arguments: { workspace_root: root, file: path.join(root, 'a/model.ts'), line: 1, character: 14, new_name: 'RenamedSymbol' } },
    { name: 'rename_preview', arguments: { workspace_root: root, file: 'a/empty.ts', line: 1, character: 4, new_name: 'RenamedSymbol' } },
    { name: 'rename_preview', arguments: { workspace_root: root, file: 'a/builtin.ts', line: 1, character: 23, new_name: 'OtherArray' } },
  ]);
  assert.equal(result.tools.find(t => t.name === 'rename_preview')?.annotations.readOnlyHint, true);
  const proposal = value(result.calls[0]).result;
  assert.equal(proposal.status, 'edit_available'); assert.equal(proposal.preview_only, true);
  assert.equal(proposal.basis.request.new_name, 'RenamedSymbol');
  assert.ok(proposal.edit.files.some(f => f.file.endsWith('/model.ts')));
  assert.ok(proposal.edit.files.some(f => f.file.endsWith('/main.ts')));
  assert.ok(proposal.edit.files.reduce((n, f) => n + f.edits.length, 0) >= 3);
  assert.ok(proposal.edit.files.every(f => f.workspace_boundary === 'inside' && f.project_boundary === 'inside' && f.sha256));
  assert.equal(value(result.calls[1]).result.selection_id, proposal.selection_id);
  for (const call of result.calls.slice(2)) { const empty = value(call); assert.equal(empty.status, 'not_renamable'); assert.equal(empty.result, null); }
  await unchanged(root, files);
});

test('stage-two tools reject traversal and symlink inputs without executing a server command', { skip: !ts && 'set TEST_TYPESCRIPT_DIR', timeout: 10000 }, async t => {
  const { root, files } = await fixture(t);
  await symlink('/etc/hosts', path.join(root, 'escape.ts'));
  const calls = ['project_symbols', 'code_actions_preview', 'rename_preview'].flatMap(name => ['../outside.ts', 'escape.ts'].map(file => ({ name, arguments: {
    workspace_root: root, file,
    ...(name === 'project_symbols' ? { query: 'x' } : name === 'rename_preview' ? { line: 1, character: 1, new_name: 'next' } : { range: { start: { line: 1, character: 1 }, end: { line: 1, character: 1 } } }),
  } })));
  const result = await mcp(root, calls);
  for (const call of result.calls) { assert.equal(call.isError, true); assert.match(call.content[0].text, /outside/); }
  await unchanged(root, files);
});
