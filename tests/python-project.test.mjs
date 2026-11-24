import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveProject, patchFiles, markLocations } from '../plugins/python-lsp/lib/project.mjs';

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'python-project-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, '.venv/bin'), { recursive: true });
  await writeFile(path.join(root, '.venv/pyvenv.cfg'), 'version = 3.12.0\n');
  await symlink(process.execPath, path.join(root, '.venv/bin/python'));
  await writeFile(path.join(root, 'main.py'), 'x: int = 1\n');
  return root;
}
const options = { env: {} };
test('Python resolves verified local venv without executing its interpreter', async t => {
  const root = await fixture(t);
  const p = await resolveProject('main.py', root, options);
  assert.equal(p.environment.path, path.join(root, '.venv'));
  assert.equal(p.environment.source, 'project .venv');
  assert.equal(p.root, root);
  assert.equal(p.config, null);
});
test('Python requires absolute workspace and rejects traversal, source and config symlink escapes', async t => {
  const root = await fixture(t);
  await assert.rejects(resolveProject('main.py', '.', options), /absolute/);
  await assert.rejects(resolveProject('../main.py', root, options), /outside/);
  await symlink('/etc/hosts', path.join(root, 'escape.py'));
  await assert.rejects(resolveProject('escape.py', root, options), /outside/);
  await symlink('/etc/hosts', path.join(root, 'ty.toml'));
  await assert.rejects(resolveProject('main.py', root, options), /config.*outside/i);
});
test('Python accepts a symlinked workspace alias and .pyi input with real boundaries', async t => {
  const root = await fixture(t);
  const alias = `${root}-alias`;
  await symlink(root, alias); t.after(() => rm(alias));
  await writeFile(path.join(root, 'api.pyi'), 'def greet(name: str) -> str: ...\n');
  assert.equal((await resolveProject(path.join(alias, 'api.pyi'), alias, options)).file, path.join(root, 'api.pyi'));
});
test('Python never silently uses VIRTUAL_ENV or global Python', async t => {
  const root = await fixture(t);
  await assert.rejects(resolveProject('main.py', root, { env: { VIRTUAL_ENV: '/different' } }), /VIRTUAL_ENV.*(different|mismatch)/);
  await rm(path.join(root, '.venv'), { recursive: true });
  await assert.rejects(resolveProject('main.py', root, options), /PYTHON_LSP_PYTHON.*\.venv/);
  await assert.rejects(resolveProject('main.py', root, { env: { PYTHON_LSP_PYTHON: 'missing' } }), /environment.*(missing|not found)/i);
});
test('Python nearest project and ty.toml precedence preserve relative environment paths', async t => {
  const root = await fixture(t);
  await mkdir(path.join(root, 'a/src'), { recursive: true });
  await mkdir(path.join(root, 'b'), { recursive: true });
  await writeFile(path.join(root, 'a/src/main.py'), 'x = 1');
  await writeFile(path.join(root, 'a/pyproject.toml'), '[tool.ty.environment]\npython = "missing"\n');
  await writeFile(path.join(root, 'a/ty.toml'), '[environment]\npython = "../.venv"\nroot = ["src"]\n');
  await writeFile(path.join(root, 'b/ty.toml'), '[environment]\npython = "missing"\n');
  const p = await resolveProject('a/src/main.py', root, options);
  assert.equal(p.root, path.join(root, 'a'));
  assert.equal(p.config, path.join(root, 'a/ty.toml'));
  assert.equal(p.environment.path, path.join(root, '.venv'));
});
test('Python config and explicit environment disagreement fails, dotted and quoted keys work', async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'pyproject.toml'), '["tool"."ty"]\nenvironment.python = ".venv" # comment\n');
  assert.equal((await resolveProject('main.py', root, options)).environment.source, 'project config');
  await mkdir(path.join(root, 'other/bin'), { recursive: true });
  await writeFile(path.join(root, 'other/pyvenv.cfg'), 'version = 3.12.0');
  await symlink(process.execPath, path.join(root, 'other/bin/python'));
  await assert.rejects(resolveProject('main.py', root, { env: { PYTHON_LSP_PYTHON: 'other' } }), /conflict/);
  await writeFile(path.join(root, 'pyproject.toml'), '[tool.ty]\nenvironment = { python = ".venv" }\n');
  await assert.rejects(resolveProject('main.py', root, options), /table.*environment|environment.*table/);
});
test('Python patch paths handle moves across language extensions and deletions', () => {
  assert.deepEqual(patchFiles('*** Add File: a.py\n*** Update File: old.ts\n*** Move to: api.pyi\n*** Update File: old.py\n*** Move to: out.txt\n*** Delete File: gone.py\n*** Add File: b.ts'), ['a.py', 'api.pyi']);
});
test('Python marks external and symlink locations without reading source content', async t => {
  const root = await fixture(t);
  await symlink('/etc/hosts', path.join(root, 'link.py'));
  const locations = await markLocations([{ uri: `file://${root}/main.py`, range: {} }, { uri: `file://${root}/link.py`, range: {} }, { uri: 'https://example.org/file.py', range: {} }, { uri: 'file:///missing-external-library.py', range: {} }], root);
  assert.deepEqual(locations.map(l => l.workspace_boundary), ['inside', 'outside', 'external_uri', 'outside']);
});
test('Python environment selection refuses standalone-script metadata rather than selecting another environment', async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'main.py'), '# /// script\n# requires-python = ">=3.12"\n# [tool.ty.environment]\n# python = "some-other-venv"\n# ///\nx = 1\n');
  await assert.rejects(resolveProject('main.py', root, options), /PEP 723.*(unsupported|not supported)/);
});
test('Python accepts canonical absolute source in an aliased workspace', async t => {
  const root = await fixture(t), alias = `${root}-alias`;
  await symlink(root, alias); t.after(() => rm(alias));
  assert.equal((await resolveProject(path.join(root, 'main.py'), alias, options)).file, path.join(root, 'main.py'));
});
