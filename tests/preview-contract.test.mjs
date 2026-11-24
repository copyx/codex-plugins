import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { captureBasis, assertBasisCurrent, buildPreview } from '../plugins/typescript-lsp/lib/preview.mjs';

async function fixture(t) {
  const outer = await realpath(await mkdtemp(path.join(tmpdir(), 'preview-contract-')));
  t.after(() => rm(outer, { recursive: true, force: true }));
  const root = path.join(outer, 'workspace');
  await mkdir(path.join(root, 'a'), { recursive: true }); await mkdir(path.join(root, 'b'));
  await mkdir(path.join(root, 'node_modules/typescript/lib'), { recursive: true });
  const project = { workspace: root, root: path.join(root, 'a'), file: path.join(root, 'a/main.ts'), config: path.join(root, 'a/tsconfig.json'), tsserver: path.join(root, 'node_modules/typescript/lib/tsserver.js') };
  await writeFile(project.file, 'const old = 1;\r\n'); await writeFile(project.config, '{}'); await writeFile(project.tsserver, '// fixture');
  await writeFile(path.join(root, 'node_modules/typescript/package.json'), '{"version":"fixture"}');
  const basis = await captureBasis(project, 'rename_preview', { workspace_root: root, file: project.file, line: 1, character: 7, new_name: 'next' }, 'const old = 1;\r\n');
  const edit = { changes: { [pathToFileURL(project.file).href]: [{ range: { start: { line: 0, character: 6 }, end: { line: 0, character: 9 } }, newText: 'next' }] } };
  return { outer, root, project, basis, edit };
}

test('preview selection is deterministic and bound to request, project/config and target preimages', async t => {
  const { basis, edit, project } = await fixture(t);
  const first = await buildPreview(basis, { title: 'Rename', edit });
  assert.equal(first.selection_id, (await buildPreview(basis, { edit, title: 'Rename' })).selection_id);
  assert.equal(first.edit.files[0].edits[0].old_text, 'old');
  const other = await buildPreview({ ...basis, request: { ...basis.request, new_name: 'different' } }, { title: 'Rename', edit });
  assert.notEqual(other.selection_id, first.selection_id);
  await writeFile(project.config, '{"compilerOptions":{"strict":true}}');
  await assert.rejects(assertBasisCurrent(basis), /changed/);
  const updated = await captureBasis(project, 'rename_preview', basis.request, 'const old = 1;\r\n');
  assert.notEqual((await buildPreview(updated, { title: 'Rename', edit })).selection_id, first.selection_id);
  await writeFile(project.file, 'const new = 2;\r\n');
  await assert.rejects(assertBasisCurrent(updated), /changed/);
});

test('preview status never treats command or resolve requirements as standalone applicable edits', async t => {
  const { basis, edit } = await fixture(t);
  assert.equal((await buildPreview(basis, { title: 'Edit', edit })).status, 'edit_available');
  const commanded = await buildPreview(basis, { title: 'Edit', edit, command: { command: '_server.command', arguments: [1] } });
  assert.equal(commanded.status, 'requires_command'); assert.equal(commanded.preview_only, true);
  assert.equal((await buildPreview(basis, { title: 'Deferred', data: { globalId: 1 } })).status, 'requires_resolve');
  const partial = await buildPreview(basis, { title: 'Deferred', edit, data: { globalId: 1 } });
  assert.equal(partial.status, 'requires_resolve');
  assert.notEqual(partial.selection_id, (await buildPreview(basis, { title: 'Deferred', edit, data: { globalId: 2 } })).selection_id);
  assert.equal((await buildPreview(basis, { title: 'Command', command: 'server.command' })).status, 'requires_command');
  assert.equal((await buildPreview(basis, { title: 'Empty' })).status, 'unavailable');
  assert.equal((await buildPreview(basis, { title: 'Disabled', edit, disabled: { reason: 'unsupported' } })).status, 'disabled');
});

test('preview reports multiple URI boundaries and resource operations without reading external files', async t => {
  const { outer, root, project, basis } = await fixture(t);
  const external = path.join(outer, 'outside.ts'); await writeFile(external, 'private external content');
  await writeFile(path.join(root, 'b/other.ts'), 'other'); await symlink(external, path.join(root, 'a/escape.ts'));
  const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
  const edit = { documentChanges: [
    ...[project.file, path.join(root, 'b/other.ts'), path.join(root, 'a/escape.ts')].map(file => ({ textDocument: { uri: pathToFileURL(file).href, version: 7 }, edits: [{ range, newText: 'insert' }] })),
    { kind: 'create', uri: pathToFileURL(path.join(root, 'a/new.ts')).href },
    { kind: 'rename', oldUri: pathToFileURL(project.file).href, newUri: pathToFileURL(path.join(root, 'b/moved.ts')).href },
    { kind: 'delete', uri: pathToFileURL(external).href },
  ] };
  const result = await buildPreview(basis, { title: 'Mixed', edit });
  assert.equal(result.edit.files[0].project_boundary, 'inside');
  assert.equal(result.edit.files[1].project_boundary, 'outside'); assert.equal(result.edit.files[1].workspace_boundary, 'inside');
  assert.equal(result.edit.files[2].workspace_boundary, 'outside'); assert.equal(result.edit.files[2].sha256, null);
  assert.equal(result.edit.files[2].edits[0].old_text, null);
  assert.equal(result.edit.files[0].document_version, 7);
  assert.deepEqual(result.edit.resource_operations.map(r => r.kind), ['create', 'rename', 'delete']);
  assert.ok(result.issues.includes('outside_workspace'));
});

test('preview target preimages use UTF-16 ranges and exact byte hashes', async t => {
  const { root, basis } = await fixture(t);
  const file = path.join(root, 'a/references.ts');
  const uri = pathToFileURL(file).href;
  await writeFile(file, '😀old\r\nnext\n');
  const action = { title: 'Edit', edit: { changes: { [uri]: [{ range: { start: { line: 0, character: 2 }, end: { line: 0, character: 5 } }, newText: 'next' }] } } };
  const first = await buildPreview(basis, action);
  assert.equal(first.edit.files[0].edits[0].old_text, 'old');
  await writeFile(file, '😀new\r\nnext\n');
  assert.notEqual((await buildPreview(basis, action)).selection_id, first.selection_id);
  await assert.rejects(assertBasisCurrent(first.basis), /target changed/);
  await writeFile(file, Buffer.from([0xff])); const a = await buildPreview(basis, action);
  await writeFile(file, Buffer.from([0xfe])); const b = await buildPreview(basis, action);
  assert.notEqual(a.edit.files[0].sha256, b.edit.files[0].sha256);
  assert.ok(b.issues.includes('invalid_text_edit'));
});
