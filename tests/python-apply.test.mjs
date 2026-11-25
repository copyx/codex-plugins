import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveProject } from '../plugins/python-lsp/lib/project.mjs';
import { captureBasis, buildPreview, fingerprint } from '../plugins/python-lsp/lib/preview.mjs';
import { applyPreview } from '../plugins/python-lsp/lib/apply.mjs';
import { LspSession } from '../plugins/python-lsp/lib/lsp.mjs';
import { renamePreview } from '../plugins/python-lsp/lib/rename.mjs';
const range = (start, end, line = 0) => ({ start: { line, character: start }, end: { line, character: end } });
async function fixture(t) {
  const outer = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'python-apply-')));
  t.after(() => fs.rm(outer, { recursive: true, force: true }));
  const root = path.join(outer, 'workspace');
  await fs.mkdir(path.join(root, 'app/.venv/bin'), { recursive: true });
  await fs.writeFile(path.join(root, 'app/.venv/pyvenv.cfg'), 'version = 3.15.2\n');
  await fs.writeFile(path.join(root, 'app/.venv/bin/python'), 'fixture Python');
  await fs.chmod(path.join(root, 'app/.venv/bin/python'), 0o755);
  await fs.writeFile(path.join(root, 'app/ty.toml'), '[environment]\nroot=["."]\n');
  const file = path.join(root, 'app/a.py'), other = path.join(root, 'app/b.pyi');
  const originals = new Map([[file, Buffer.from('\uFEFFemoji = "😀"; old = 1\r\n')], [other, Buffer.from('old: int\r\n')]]);
  for (const [name, bytes] of originals) await fs.writeFile(name, bytes);
  const project = await resolveProject(file, root), uri = pathToFileURL(file).href, otherUri = pathToFileURL(other).href;
  const command = path.join(outer, 'ty'); await fs.writeFile(command, 'fixture ty 0.0.109');
  const session = { command, serverVersion: 'ty 0.0.109 fixture', runtime: { source: 'explicit_command', config: null }, settings: {}, capabilities: { renameProvider: true }, documents: new Map([[uri, { version: 1, text: new TextDecoder().decode(originals.get(file)) }]]) };
  const basis = await captureBasis(project, session, 'rename_preview', { workspace_root: root, file, line: 1, character: 15, new_name: 'next' }, session.documents.get(uri).text, [], { rename_capability: true });
  const raw = { changes: { [uri]: [{ range: range(14, 17), newText: 'next' }], [otherUri]: [{ range: range(0, 3), newText: 'next' }] } };
  const preview = await buildPreview(basis, { title: 'Rename', kind: 'refactor.rename', edit: raw });
  return { outer, root, file, other, uri, otherUri, project, session, basis, raw, preview, originals };
}
async function unchanged(f) { for (const [file, bytes] of f.originals) assert.deepEqual(await fs.readFile(file), bytes); }
async function artifacts(f) { return (await fs.readdir(path.dirname(f.file))).filter(n => n.includes('.python-lsp')); }

test('Python engine applies existing .py/.pyi edits with UTF-16, CRLF and BOM preserved', async t => {
  assert.equal(typeof applyPreview, 'function', 'internal Python apply engine must exist');
  const f = await fixture(t), result = await applyPreview(f.project, f.session, f.preview);
  assert.equal(result.status, 'applied', JSON.stringify(result));
  assert.deepEqual(await fs.readFile(f.file), Buffer.from('\uFEFFemoji = "😀"; next = 1\r\n'));
  assert.deepEqual(await fs.readFile(f.other), Buffer.from('next: int\r\n'));
  assert.equal(result.files.length, 2); assert.deepEqual(await artifacts(f), []);
  assert.equal(f.session.documents.get(f.uri).text, 'emoji = "😀"; old = 1\r\n', 'engine must not pretend the live LSP document was resynchronized');
});

const selected = (f, edit, extra = {}) => buildPreview(f.basis, { title: 'Server candidate', kind: 'refactor.rename', edit, ...extra });
function reseal(preview) { preview.selection_id = fingerprint({ basis: preview.basis, action_fingerprint: preview.action_fingerprint }); return preview; }
test('Python engine permits adjacent edits and verified anchor documentChanges', async t => {
  const f = await fixture(t);
  const preview = await selected(f, { documentChanges: [{ textDocument: { uri: f.uri, version: 1 }, edits: [{ range: range(14, 15), newText: 'n' }, { range: range(15, 17), newText: 'ew' }] }] });
  await fs.chmod(f.file, 0o640);
  // Mode must be part of the fresh preview, not silently accepted from stale data.
  const basis = await captureBasis(f.project, f.session, f.basis.tool, f.basis.request, f.session.documents.get(f.uri).text);
  const fresh = await buildPreview(basis, { title: 'Adjacent', edit: { documentChanges: [{ textDocument: { uri: f.uri, version: 1 }, edits: [{ range: range(14, 15), newText: 'n' }, { range: range(15, 17), newText: 'ew' }] }] } });
  assert.equal((await applyPreview(f.project, f.session, preview)).status, 'rejected');
  const result = await applyPreview(f.project, f.session, fresh);
  assert.equal(result.status, 'applied', JSON.stringify(result)); assert.equal((await fs.stat(f.file)).mode & 0o777, 0o640);
  assert.deepEqual(await fs.readFile(f.file), Buffer.from('\uFEFFemoji = "😀"; new = 1\r\n')); assert.deepEqual(await fs.readFile(f.other), f.originals.get(f.other));
});
test('Python engine rejects unsupported candidates and ambiguous ranges before any transaction artifact', async t => {
  const f = await fixture(t), e = f.raw.changes[f.uri][0]; let creations = 0;
  const io = { ...fs, open: async (...args) => { if (String(args[0]).includes('.python-lsp')) creations++; return fs.open(...args); } };
  const candidates = [
    await selected(f, f.raw, { command: 'unsafe.command' }), await selected(f, f.raw, { data: { id: 1 } }), await selected(f, f.raw, { disabled: { reason: 'no' } }),
    await selected(f, { documentChanges: [{ kind: 'delete', uri: f.uri }] }),
    await selected(f, { changes: { [f.uri]: [{ ...e, annotationId: 'a' }] }, changeAnnotations: { a: { label: 'review' } } }),
    await selected(f, { changes: { [f.uri]: [e, e] } }),
    await selected(f, { changes: { [f.uri]: [{ range: range(0, 0), newText: 'one' }, { range: range(0, 0), newText: 'two' }] } }),
    await selected(f, { changes: { [f.uri]: [{ range: range(10, 11), newText: 'broken surrogate' }] } }),
    await selected(f, { changes: { [f.uri]: [{ range: range(17, 14), newText: 'reverse' }] } }),
    await selected(f, { changes: { [f.uri]: [{ range: range(0, 1, 90), newText: 'outside' }] } }),
    await selected(f, { changes: { [f.uri + '?query']: [e] } }),
    await selected(f, { changes: { 'https://example.test/a.py': [e] } }),
    await selected(f, { changes: { [pathToFileURL(path.join(f.outer, 'outside.py')).href]: [e] } }),
    await selected(f, { documentChanges: [{ textDocument: { uri: f.uri, version: 99 }, edits: [e] }] }),
    await selected(f, { documentChanges: [{ textDocument: { uri: f.uri, version: 1 }, edits: [e] }, { textDocument: { uri: f.uri, version: 1 }, edits: [] }] }),
  ];
  for (const preview of candidates) { const r = await applyPreview(f.project, f.session, preview, { io }); assert.equal(r.status, 'rejected', JSON.stringify(r)); await unchanged(f); }
  assert.equal(creations, 0); assert.deepEqual(await artifacts(f), []);
});
test('Python engine rejects stale bytes, identities, versions and corrupted preimages without writes', async t => {
  const f = await fixture(t);
  for (const mutate of [p => { p.edit.files[0].sha256 = 'sha256:incorrect'; }, p => { p.edit.files[0].inode++; }, p => { p.edit.files[0].edits[0].old_text = 'wrong'; }]) {
    const preview = structuredClone(f.preview); mutate(preview); reseal(preview);
    assert.equal((await applyPreview(f.project, f.session, preview)).status, 'rejected'); await unchanged(f);
  }
  f.session.documents.get(f.uri).version++;
  assert.equal((await applyPreview(f.project, f.session, f.preview)).status, 'rejected'); f.session.documents.get(f.uri).version--;
  const replacement = path.join(path.dirname(f.other), 'replacement.pyi'); await fs.writeFile(replacement, f.originals.get(f.other)); await fs.rename(replacement, f.other);
  assert.equal((await applyPreview(f.project, f.session, f.preview)).status, 'rejected'); await unchanged(f);
  await fs.writeFile(f.other, 'separate disk edit\n');
  assert.equal((await applyPreview(f.project, f.session, f.preview)).status, 'rejected');
  assert.equal(await fs.readFile(f.other, 'utf8'), 'separate disk edit\n'); assert.deepEqual(await fs.readFile(f.file), f.originals.get(f.file)); assert.deepEqual(await artifacts(f), []);
});
test('Python engine denies hardlinks, symlinks, protected/environment sources and nested projects', async t => {
  const f = await fixture(t), e = { range: range(0, 0), newText: '# change\n' };
  await fs.link(f.other, path.join(path.dirname(f.other), 'hard.pyi'));
  assert.equal((await applyPreview(f.project, f.session, f.preview)).status, 'rejected');
  await fs.unlink(path.join(path.dirname(f.other), 'hard.pyi'));
  const aliases = [path.join(path.dirname(f.file), 'alias.py')]; await fs.symlink(f.other, aliases[0]);
  const outside = path.join(f.root, 'sibling.py'); await fs.writeFile(outside, 'outside = 1\n'); aliases.push(outside);
  const protectedFile = path.join(path.dirname(f.file), '.codex/config.py'); await fs.mkdir(path.dirname(protectedFile)); await fs.writeFile(protectedFile, 'secret = 1\n'); aliases.push(protectedFile);
  const envFile = path.join(f.project.environment.path, 'library.py'); await fs.writeFile(envFile, 'venv = 1\n'); aliases.push(envFile);
  const nested = path.join(path.dirname(f.file), 'nested/other.py'); await fs.mkdir(path.dirname(nested)); await fs.writeFile(nested, 'nested = 1\n'); await fs.writeFile(path.join(path.dirname(nested), 'ty.toml'), '[environment]\nroot=["."]\n'); aliases.push(nested);
  for (const file of aliases) {
    const before = await fs.readFile(file), preview = await selected(f, { changes: { [pathToFileURL(file).href]: [e] } });
    assert.equal((await applyPreview(f.project, f.session, preview)).status, 'rejected', file); assert.deepEqual(await fs.readFile(file), before);
  }
  await unchanged(f); assert.deepEqual(await artifacts(f), []);
});
test('Python engine rejects readonly permissions and invalid Unicode replacement before staging', async t => {
  const f = await fixture(t);
  const invalid = await selected(f, { changes: { [f.uri]: [{ ...f.raw.changes[f.uri][0], newText: '\ud800' }] } });
  assert.equal((await applyPreview(f.project, f.session, invalid)).status, 'rejected');
  await fs.chmod(f.other, 0o400);
  const current = await captureBasis(f.project, f.session, f.basis.tool, f.basis.request, f.session.documents.get(f.uri).text);
  const readonly = await buildPreview(current, { title: 'Read only', edit: f.raw });
  assert.equal((await applyPreview(f.project, f.session, readonly)).status, 'rejected'); await unchanged(f); assert.deepEqual(await artifacts(f), []);
});
test('Python engine detects a source change during staging and preserves the separate edit', async t => {
  const f = await fixture(t); let staged = 0;
  const io = { ...fs, open: async (...args) => { const handle = await fs.open(...args); if (String(args[0]).endsWith('.next') && ++staged === 2) await fs.writeFile(f.other, 'edited during staging\r\n'); return handle; } };
  const r = await applyPreview(f.project, f.session, f.preview, { io }); assert.equal(r.status, 'rejected', JSON.stringify(r));
  assert.deepEqual(await fs.readFile(f.file), f.originals.get(f.file)); assert.equal(await fs.readFile(f.other, 'utf8'), 'edited during staging\r\n'); assert.deepEqual(await artifacts(f), []);
});
test('Python engine rechecks configuration after its own first-file commit and rolls back', async t => {
  const f = await fixture(t); let commits = 0;
  const io = { ...fs, rename: async (from, to) => { await fs.rename(from, to); if (from.endsWith('.next') && ++commits === 1) await fs.writeFile(f.project.config, '# changed during commit\n'); } };
  const r = await applyPreview(f.project, f.session, f.preview, { io }); assert.equal(r.status, 'rolled_back', JSON.stringify(r)); assert.equal(commits, 1); await unchanged(f);
  assert.equal(await fs.readFile(f.project.config, 'utf8'), '# changed during commit\n'); assert.deepEqual(await artifacts(f), []);
});
test('Python engine restores the first committed file after second-file failure', async t => {
  const f = await fixture(t); let commits = 0;
  const io = { ...fs, rename: async (from, to) => { if (from.endsWith('.next') && ++commits === 2) throw new Error('injected second replacement failure'); return fs.rename(from, to); } };
  const r = await applyPreview(f.project, f.session, f.preview, { io }); assert.equal(commits, 2); assert.equal(r.status, 'rolled_back', JSON.stringify(r)); assert.deepEqual(r.recovery.map(x => x.status), ['restored']); await unchanged(f); assert.deepEqual(await artifacts(f), []);
});
test('Python engine inspects a rejected rename that actually committed and restores both files', async t => {
  const f = await fixture(t); let commits = 0;
  const io = { ...fs, rename: async (from, to) => { await fs.rename(from, to); if (from.endsWith('.next') && ++commits === 2) throw new Error('error after real commit'); } };
  const r = await applyPreview(f.project, f.session, f.preview, { io }); assert.equal(r.status, 'rolled_back', JSON.stringify(r)); assert.equal(r.recovery.length, 2); await unchanged(f); assert.deepEqual(await artifacts(f), []);
});
test('Python engine preserves a concurrent edit during recovery and retains a verified original backup', async t => {
  const f = await fixture(t); let commits = 0, failed = false;
  const io = { ...fs, rename: async (from, to) => { if (from.endsWith('.next') && ++commits === 2) { failed = true; throw new Error('second failure'); } return fs.rename(from, to); }, open: async (...args) => {
    const handle = await fs.open(...args); if (failed && String(args[0]).endsWith('.backup')) { failed = false; await fs.writeFile(f.file, 'user edit during rollback\n'); } return handle;
  } };
  const r = await applyPreview(f.project, f.session, f.preview, { io }); assert.equal(r.status, 'recovery_incomplete', JSON.stringify(r));
  assert.equal(await fs.readFile(f.file, 'utf8'), 'user edit during rollback\n'); assert.deepEqual(await fs.readFile(f.other), f.originals.get(f.other));
  const backup = r.recovery[0]; assert.equal(backup.status, 'not_restored_conflict'); assert.equal(backup.backup_verified, true); assert.ok(r.retained_artifacts.includes(backup.backup_path)); assert.deepEqual(await fs.readFile(backup.backup_path), f.originals.get(f.file));
});
test('Python engine reports unverified replaced backup and preserves outside content', async t => {
  const f = await fixture(t), outside = path.join(f.outer, 'secret'); await fs.writeFile(outside, 'DO NOT TOUCH'); let commits = 0;
  const io = { ...fs, rename: async (from, to) => {
    if (from.endsWith('.next') && ++commits === 2) {
      const backup = (await fs.readdir(path.dirname(f.file))).find(n => n.startsWith('.a.py.python-lsp-') && n.endsWith('.backup'));
      await fs.unlink(path.join(path.dirname(f.file), backup)); await fs.symlink(outside, path.join(path.dirname(f.file), backup)); throw new Error('backup replaced');
    }
    return fs.rename(from, to);
  } };
  const r = await applyPreview(f.project, f.session, f.preview, { io }); assert.equal(r.status, 'recovery_incomplete', JSON.stringify(r)); assert.equal(r.recovery[0].backup_verified, false); assert.equal(await fs.readFile(outside, 'utf8'), 'DO NOT TOUCH');
});
test('Python cooperative engines cannot both commit the same preimage', async t => {
  const f = await fixture(t), results = await Promise.all([applyPreview(f.project, f.session, f.preview), applyPreview(f.project, f.session, f.preview)]);
  assert.deepEqual(results.map(r => r.status).sort(), ['applied', 'rejected']); assert.deepEqual(await artifacts(f), []);
});
test('Python engine rechecks the final target after artifact verification immediately before replacement', async t => {
  const f = await fixture(t); let changed = false;
  const io = { ...fs, open: async (...args) => {
    const handle = await fs.open(...args);
    if (!changed && String(args[0]).endsWith('.next') && args[1] === (fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK)) { changed = true; await fs.writeFile(f.file, 'user at critical boundary\n'); }
    return handle;
  } };
  const r = await applyPreview(f.project, f.session, f.preview, { io }); assert.equal(changed, true); assert.equal(r.status, 'rejected', JSON.stringify(r));
  assert.equal(await fs.readFile(f.file, 'utf8'), 'user at critical boundary\n'); assert.deepEqual(await fs.readFile(f.other), f.originals.get(f.other)); assert.deepEqual(await artifacts(f), []);
});
test('Python engine does not follow a parent directory replaced during staging', async t => {
  const f = await fixture(t), app = path.dirname(f.file), moved = path.join(f.root, 'moved-app'), outside = path.join(f.outer, 'outside');
  await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'a.py'), 'OUTSIDE'); let staged = 0;
  const io = { ...fs, open: async (...args) => {
    const handle = await fs.open(...args);
    if (String(args[0]).endsWith('.next') && ++staged === 2) { await fs.rename(app, moved); await fs.symlink(outside, app); }
    return handle;
  } };
  const r = await applyPreview(f.project, f.session, f.preview, { io }); assert.equal(r.status, 'rejected', JSON.stringify(r));
  assert.equal(await fs.readFile(path.join(outside, 'a.py'), 'utf8'), 'OUTSIDE');
  assert.deepEqual(await fs.readFile(path.join(moved, 'a.py')), f.originals.get(f.file)); assert.ok(r.retained_artifacts.length > 0, 'changed parent artifacts must not be deleted through an unverified path');
});
test('Python engine refuses a result exceeding the preview source budget', async t => {
  const f = await fixture(t), bytes = Buffer.from('#' + 'a'.repeat(900000) + '\n'); await fs.writeFile(f.other, bytes);
  const edit = { changes: { [f.otherUri]: [{ range: range(0, 0), newText: '#'+ 'b'.repeat(200000)+'\n' }] } };
  const candidate = await selected(f, edit); assert.equal(candidate.status, 'edit_available');
  const r = await applyPreview(f.project, f.session, candidate); assert.equal(r.status, 'rejected'); assert.match(r.reason, /1 MiB/); assert.deepEqual(await fs.readFile(f.other), bytes); assert.deepEqual(await artifacts(f), []);
});
test('Python engine applies a freshly regenerated actual ty rename without changing unrelated symbols', { skip: !(process.env.TEST_TY_BIN && process.env.TEST_PYTHON_ENV) && 'set TEST_TY_BIN and TEST_PYTHON_ENV', timeout: 30000 }, async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'python-apply-ty-'))); t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.symlink(process.env.TEST_PYTHON_ENV, path.join(root, '.venv'));
  await fs.writeFile(path.join(root, 'ty.toml'), '[environment]\nroot=["."]\n');
  const sources = { 'model.py': 'class Greeter:\n    pass\n', 'use.py': 'from model import Greeter\nitem = Greeter()\n', 'unrelated.py': 'def local():\n    class Greeter:\n        pass\n    return Greeter()\n' };
  for (const [name, text] of Object.entries(sources)) await fs.writeFile(path.join(root, name), text);
  const project = await resolveProject('use.py', root), args = { workspace_root: root, file: 'use.py', line: 2, character: 9, new_name: 'RenamedGreeter' };
  const first = new LspSession(project, { command: process.env.TEST_TY_BIN }); t.after(() => first.close()); await first.start();
  const shown = await renamePreview(project, first, args); await first.close();
  const fresh = new LspSession(project, { command: process.env.TEST_TY_BIN }); t.after(() => fresh.close()); await fresh.start();
  const selected = await renamePreview(project, fresh, args);
  assert.equal(selected.result.selection_id, shown.result.selection_id, 'consumer must requery and match the original selection');
  for (const [name, text] of Object.entries(sources)) assert.equal(await fs.readFile(path.join(root, name), 'utf8'), text);
  const applied = await applyPreview(project, fresh, selected.result); assert.equal(applied.status, 'applied', JSON.stringify(applied)); assert.equal(applied.files.length, 2);
  assert.equal(await fs.readFile(path.join(root, 'model.py'), 'utf8'), 'class RenamedGreeter:\n    pass\n');
  assert.equal(await fs.readFile(path.join(root, 'use.py'), 'utf8'), 'from model import RenamedGreeter\nitem = RenamedGreeter()\n');
  assert.equal(await fs.readFile(path.join(root, 'unrelated.py'), 'utf8'), sources['unrelated.py']);
  assert.equal((await applyPreview(project, fresh, selected.result)).status, 'rejected', 'same preimage must not be applied twice');
});
test('Python engine rejects a target that acquires a nearer project config during staging', async t => {
  const f = await fixture(t), child = path.join(path.dirname(f.file), 'child'); await fs.mkdir(child);
  const file = path.join(child, 'other.py'); await fs.writeFile(file, 'old = 1\n');
  const preview = await selected(f, { changes: { [f.uri]: f.raw.changes[f.uri], [pathToFileURL(file).href]: [{ range: range(0, 3), newText: 'next' }] } });
  let staged = 0;
  const io = { ...fs, open: async (...args) => { const handle = await fs.open(...args); if (String(args[0]).endsWith('.next') && ++staged === 2) await fs.writeFile(path.join(child, 'ty.toml'), '[environment]\nroot=["."]\n'); return handle; } };
  const r = await applyPreview(f.project, f.session, preview, { io }); assert.equal(r.status, 'rejected', JSON.stringify(r));
  await unchanged(f); assert.equal(await fs.readFile(file, 'utf8'), 'old = 1\n');
});
test('Python engine rejects staging artifact permission changes before source replacement', async t => {
  const f = await fixture(t); let altered = false;
  const io = { ...fs, open: async (...args) => {
    if (!altered && String(args[0]).endsWith('.next') && args[1] === (fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK)) { altered = true; await fs.chmod(args[0], 0o777); }
    return fs.open(...args);
  } };
  const r = await applyPreview(f.project, f.session, f.preview, { io }); assert.equal(altered, true); assert.equal(r.status, 'rejected', JSON.stringify(r)); await unchanged(f);
});
test('Python engine reports uncertain commit when another process changes replacement metadata', async t => {
  const f = await fixture(t); let first = true;
  const io = { ...fs, rename: async (from, to) => { await fs.rename(from, to); if (first && from.endsWith('.next')) { first = false; await fs.chmod(to, 0o744); } } };
  const r = await applyPreview(f.project, f.session, f.preview, { io }); assert.equal(r.status, 'recovery_incomplete', JSON.stringify(r));
  assert.equal((await fs.stat(f.file)).mode & 0o777, 0o744); assert.equal(r.recovery[0].backup_verified, true); assert.deepEqual(await fs.readFile(r.recovery[0].backup_path), f.originals.get(f.file));
});
test('Python engine rejects a FIFO swapped at the open boundary without waiting for a writer', async t => {
  const f = await fixture(t); let changed = false;
  const io = { ...fs, open: async (...args) => {
    if (!changed && args[0] === f.other) {
      assert.ok(args[1] & fsConstants.O_NONBLOCK, 'source open must not block on a substituted FIFO');
      changed = true; await fs.unlink(f.other); const made = spawnSync('mkfifo', [f.other], { encoding: 'utf8' }); assert.equal(made.status, 0, made.stderr);
    }
    return fs.open(...args);
  } };
  const r = await applyPreview(f.project, f.session, f.preview, { io }); assert.equal(changed, true); assert.equal(r.status, 'rejected'); assert.match(r.reason, /regular/);
  assert.equal((await fs.lstat(f.other)).isFIFO(), true); assert.deepEqual(await fs.readFile(f.file), f.originals.get(f.file)); assert.deepEqual(await artifacts(f), []);
});
