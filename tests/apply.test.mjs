import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { captureBasis, buildPreview } from '../plugins/typescript-lsp/lib/preview.mjs';
import { applyPreview } from '../plugins/typescript-lsp/lib/apply.mjs';
import { postApplyDiagnostics } from '../plugins/typescript-lsp/lib/operations.mjs';

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'typescript-lsp-apply-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'node_modules/typescript/lib'), { recursive: true });
  const project = { workspace: root, root, file: path.join(root, 'a.ts'), config: path.join(root, 'tsconfig.json'), tsserver: path.join(root, 'node_modules/typescript/lib/tsserver.js') };
  await fs.writeFile(project.config, '{}'); await fs.writeFile(project.tsserver, '// fixture');
  await fs.writeFile(path.join(root, 'node_modules/typescript/package.json'), '{"version":"fixture"}');
  const originals = { 'a.ts': '😀old\r\n', 'b.ts': 'old value\n' };
  for (const [f, text] of Object.entries(originals)) await fs.writeFile(path.join(root, f), text);
  const basis = await captureBasis(project, 'rename_preview', { workspace_root: root, file: project.file, line: 1, character: 3, new_name: 'next' }, originals['a.ts']);
  const raw = { changes: {
    [pathToFileURL(project.file).href]: [{ range: { start: { line: 0, character: 2 }, end: { line: 0, character: 5 } }, newText: 'next' }],
    [pathToFileURL(path.join(root, 'b.ts')).href]: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: 'next' }],
  } };
  const preview = await buildPreview(basis, { title: 'Rename', edit: raw });
  return { root, project, originals, preview, raw, basis };
}
async function originalsUnchanged(f) { for (const [name, text] of Object.entries(f.originals)) assert.equal(await fs.readFile(path.join(f.root, name), 'utf8'), text); }

test('#28 applies multiple existing files with UTF-16/CRLF text and no leftover transaction artifacts', async t => {
  const f = await fixture(t);
  const result = await applyPreview(f.project, f.preview);
  assert.equal(result.status, 'applied', JSON.stringify(result));
  assert.equal(await fs.readFile(f.project.file, 'utf8'), '😀next\r\n');
  assert.equal(await fs.readFile(path.join(f.root, 'b.ts'), 'utf8'), 'next value\n');
  assert.deepEqual((await fs.readdir(f.root)).filter(n => n.includes('typescript-lsp-')), []);
});

test('#28 stale preimages, overlaps, resource operations, versions and external boundaries fail before source writes', async t => {
  const f = await fixture(t);
  const uri = pathToFileURL(f.project.file).href;
  const cases = [
    await buildPreview(f.basis, { title: 'Deferred edit', data: { globalId: 1 }, edit: f.raw }),
    await buildPreview(f.basis, { title: 'Unknown command', command: 'unsupported.command', edit: f.raw }),
    await buildPreview(f.basis, { title: 'Overlap', edit: { changes: { [uri]: [f.raw.changes[uri][0], f.raw.changes[uri][0]] } } }),
    await buildPreview(f.basis, { title: 'Resource', edit: { documentChanges: [{ kind: 'delete', uri }] } }),
    await buildPreview(f.basis, { title: 'Version', edit: { documentChanges: [{ textDocument: { uri, version: 99 }, edits: f.raw.changes[uri] }] } }),
    await buildPreview(f.basis, { title: 'External', edit: { changes: { 'file:///etc/hosts': f.raw.changes[uri] } } }),
  ];
  for (const preview of cases) { assert.equal((await applyPreview(f.project, preview)).status, 'rejected'); await originalsUnchanged(f); }
  await fs.writeFile(path.join(f.root, 'b.ts'), 'external change');
  assert.equal((await applyPreview(f.project, f.preview)).status, 'rejected');
  assert.equal(await fs.readFile(f.project.file, 'utf8'), f.originals['a.ts']);
  assert.equal(await fs.readFile(path.join(f.root, 'b.ts'), 'utf8'), 'external change');
});

test('#28 real second-file rename failure restores the already committed original', async t => {
  const f = await fixture(t); let commits = 0;
  const io = { ...fs, rename: async (from, to) => { if (from.endsWith('.next') && ++commits === 2) throw new Error('injected second commit failure'); return fs.rename(from, to); } };
  const result = await applyPreview(f.project, f.preview, { io });
  assert.equal(commits, 2); assert.equal(result.status, 'rolled_back', JSON.stringify(result));
  await originalsUnchanged(f);
  assert.deepEqual((await fs.readdir(f.root)).filter(n => n.includes('typescript-lsp-')), []);
});

test('#28 failure reported after a real second commit detects the uncertain outcome and restores both files', async t => {
  const f = await fixture(t); let commits = 0;
  const io = { ...fs, rename: async (from, to) => {
    const second = from.endsWith('.next') && ++commits === 2;
    await fs.rename(from, to);
    if (second) throw new Error('injected error after the second commit');
  } };
  const result = await applyPreview(f.project, f.preview, { io });
  assert.equal(result.status, 'rolled_back', JSON.stringify(result));
  assert.equal(result.recovery.length, 2); await originalsUnchanged(f);
});

test('#28 rollback preserves a separately changed file and retains an original recovery backup', async t => {
  const f = await fixture(t); let commits = 0;
  const io = { ...fs, rename: async (from, to) => {
    if (from.endsWith('.next') && ++commits === 2) { await fs.writeFile(f.project.file, 'external after first commit'); throw new Error('injected failure with concurrent edit'); }
    return fs.rename(from, to);
  } };
  const result = await applyPreview(f.project, f.preview, { io });
  assert.equal(result.status, 'recovery_incomplete', JSON.stringify(result));
  assert.equal(await fs.readFile(f.project.file, 'utf8'), 'external after first commit');
  const conflict = result.recovery.find(r => r.status === 'not_restored_conflict');
  assert.ok(conflict?.backup_path); assert.equal(await fs.readFile(conflict.backup_path, 'utf8'), f.originals['a.ts']);
  assert.equal(await fs.readFile(path.join(f.root, 'b.ts'), 'utf8'), f.originals['b.ts']);
});

test('#28 critical-point concurrent edits and symlink replacement are not overwritten', async t => {
  const f = await fixture(t); let staged = 0;
  const io = { ...fs, open: async (...args) => {
    const handle = await fs.open(...args);
    if (String(args[0]).endsWith('.next') && ++staged === 2) await fs.writeFile(path.join(f.root, 'b.ts'), 'edited during staging');
    return handle;
  } };
  assert.equal((await applyPreview(f.project, f.preview, { io })).status, 'rejected');
  assert.equal(await fs.readFile(f.project.file, 'utf8'), f.originals['a.ts']);
  assert.equal(await fs.readFile(path.join(f.root, 'b.ts'), 'utf8'), 'edited during staging');
  await fs.unlink(path.join(f.root, 'b.ts')); await fs.symlink('/etc/hosts', path.join(f.root, 'b.ts'));
  assert.equal((await applyPreview(f.project, f.preview)).status, 'rejected');
});

test('#28 numbered document edits require a matching current version', async t => {
  const f = await fixture(t); const uri = pathToFileURL(f.project.file).href;
  const preview = await buildPreview(f.basis, { title: 'Versioned', edit: { documentChanges: [{ textDocument: { uri, version: 2 }, edits: f.raw.changes[uri] }] } });
  assert.equal((await applyPreview(f.project, preview, { versions: new Map([[uri, 1]]) })).status, 'rejected');
  await originalsUnchanged(f);
  assert.equal((await applyPreview(f.project, preview, { versions: new Map([[uri, 2]]) })).status, 'applied');
});

test('#28 annotations, malformed file URIs, read-only files and hard links are rejected without source changes', async t => {
  const f = await fixture(t); const uri = pathToFileURL(f.project.file).href;
  const annotated = await buildPreview(f.basis, { title: 'Annotated', edit: { changes: f.raw.changes, changeAnnotations: { confirm: { label: 'Needs review', needsConfirmation: true } } } });
  const queried = await buildPreview(f.basis, { title: 'Query URI', edit: { changes: { [uri + '?query']: f.raw.changes[uri] } } });
  for (const preview of [annotated, queried]) { assert.equal((await applyPreview(f.project, preview)).status, 'rejected'); await originalsUnchanged(f); }
  await fs.chmod(f.project.file, 0o400);
  assert.equal((await applyPreview(f.project, f.preview)).status, 'rejected');
  await fs.chmod(f.project.file, 0o600);
  await fs.link(f.project.file, path.join(f.root, 'linked.ts'));
  assert.equal((await applyPreview(f.project, f.preview)).status, 'rejected');
  await originalsUnchanged(f);
});

test('#28 workspace-internal files outside the selected config root are rejected', async t => {
  const f = await fixture(t); const app = path.join(f.root, 'app'); await fs.mkdir(app);
  const project = { ...f.project, root: app, file: path.join(app, 'main.ts'), config: path.join(app, 'tsconfig.json') };
  await fs.writeFile(project.file, 'const local = 1;\n'); await fs.writeFile(project.config, '{}');
  const basis = await captureBasis(project, 'rename_preview', { workspace_root: f.root, file: project.file, line: 1, character: 7, new_name: 'next' }, 'const local = 1;\n');
  const preview = await buildPreview(basis, { title: 'Outside project', edit: { changes: { [pathToFileURL(path.join(f.root, 'b.ts')).href]: f.raw.changes[pathToFileURL(path.join(f.root, 'b.ts')).href] } } });
  assert.equal(preview.edit.files[0].workspace_boundary, 'inside'); assert.equal(preview.edit.files[0].project_boundary, 'outside');
  assert.equal((await applyPreview(project, preview)).status, 'rejected'); await originalsUnchanged(f);
  assert.equal(await fs.readFile(project.file, 'utf8'), 'const local = 1;\n');
});

test('post-apply diagnostics preserve applied status but do not follow a newly substituted external symlink', async t => {
  const f = await fixture(t);
  const session = { close: async () => { await fs.unlink(f.project.file); await fs.symlink('/etc/hosts', f.project.file); } };
  const result = await postApplyDiagnostics(f.project, session, { status: 'applied', files: [{ file: f.project.file }] });
  assert.equal(result.status, 'applied'); assert.equal(result.diagnostics_status, 'incomplete');
  assert.match(result.diagnostics_error, /outside/); assert.deepEqual(result.diagnostics, []);
});

test('#28 competing cooperative transactions do not both commit the same preimage', async t => {
  const f = await fixture(t);
  const results = await Promise.all([applyPreview(f.project, f.preview), applyPreview(f.project, f.preview)]);
  assert.deepEqual(results.map(r => r.status).sort(), ['applied', 'rejected']);
  assert.equal(await fs.readFile(f.project.file, 'utf8'), '😀next\r\n');
  assert.deepEqual((await fs.readdir(f.root)).filter(n => n.includes('typescript-lsp-')), []);
});
