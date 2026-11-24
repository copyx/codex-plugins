import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, stat, readdir, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { requireTrustedHook, verifyTransition, runProcess, runCodexVerification } from '../scripts/lib/codex-verification.mjs';

const hook = { pluginId: 'typescript-lsp@copyx-codex-plugins', eventName: 'postToolUse', enabled: true, trustStatus: 'trusted' };
const request = texts => ({ input: texts.map(text => ({ role: 'developer', content: [{ type: 'input_text', text }] })) });
const error = 'TypeScript LSP post-patch diagnostics (changed files only; disk snapshot):\nmain.ts:2:7: error TS2345 invalid argument';
const clean = 'TypeScript LSP post-patch diagnostics (changed files only; disk snapshot):\nmain.ts: no diagnostics published for this snapshot';

test('installed verification refuses missing, disabled, and untrusted hooks with actionable errors', () => {
  assert.throws(() => requireTrustedHook([]), /not installed|not discovered/);
  assert.throws(() => requireTrustedHook([{ ...hook, enabled: false }]), /disabled/);
  assert.throws(() => requireTrustedHook([{ ...hook, trustStatus: 'untrusted' }]), /\/hooks.*PostToolUse/);
  assert.equal(requireTrustedHook([hook]).pluginId, hook.pluginId);
});

test('diagnostic verification requires a fresh clean context after the fixing patch', () => {
  assert.throws(() => verifyTransition(request([error]), request([error])), /fresh/);
  assert.throws(() => verifyTransition(request([error]), request([error, error])), /TS2345|clean/);
  assert.throws(() => verifyTransition(request([clean]), request([clean, clean])), /TS2345/);
  assert.deepEqual(verifyTransition(request([error]), request([error, clean])), { errorContexts: 1, fixedContexts: 2 });
});

test('verify fails before running tests when TypeScript prerequisites are missing', () => {
  const env = { ...process.env };
  delete env.TEST_TYPESCRIPT_DIR;
  const result = spawnSync(process.execPath, ['scripts/verify.mjs'], { env, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /TEST_TYPESCRIPT_DIR/);
});

test('timed out subprocesses are reaped even when they ignore SIGTERM', { timeout: 5000 }, async () => {
  await assert.rejects(runProcess(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], { timeoutMs: 100 }), /timed out/);
});

test('installed verification never creates a missing user profile', async t => {
  const temp = await mkdtemp(path.join(tmpdir(), 'verify-missing-profile-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const home = path.join(temp, 'missing');
  await assert.rejects(runCodexVerification({ home }, { installed: true }), /profile does not exist/);
  await assert.rejects(stat(home), { code: 'ENOENT' });
});

test('verify fails explicitly when model capability metadata is missing', () => {
  const env = { ...process.env, TEST_TYPESCRIPT_DIR: '.' };
  delete env.TEST_MODEL_CATALOG;
  const result = spawnSync(process.execPath, ['scripts/verify.mjs'], { env, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /TEST_MODEL_CATALOG/);
});

test('installed verification refuses a missing plugin cache without writing the profile', async t => {
  const home = await mkdtemp(path.join(tmpdir(), 'verify-empty-profile-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await assert.rejects(runCodexVerification({ home }, { installed: true }), /not installed/);
  assert.deepEqual(await readdir(home), []);
});

test('verify:installed refuses a missing profile before executing any Codex command', async t => {
  const temp = await mkdtemp(path.join(tmpdir(), 'verify-profile-preflight-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const typescript = path.join(temp, 'typescript');
  await mkdir(path.join(typescript, 'lib'), { recursive: true });
  await writeFile(path.join(typescript, 'lib/tsserver.js'), '// preflight fixture');
  await writeFile(path.join(typescript, 'package.json'), '{"name":"typescript"}');
  const catalog = path.join(temp, 'models.json');
  await writeFile(catalog, '{"models":[{"slug":"fixture","apply_patch_tool_type":"freeform"}]}');
  const home = path.join(temp, 'missing');
  const result = spawnSync(process.execPath, ['scripts/verify-installed.mjs'], {
    env: { ...process.env, CODEX_HOME: home, TEST_TYPESCRIPT_DIR: typescript, TEST_MODEL_CATALOG: catalog, TEST_CODEX_BIN: path.join(temp, 'must-not-run') }, encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /profile does not exist/);
  await assert.rejects(stat(home), { code: 'ENOENT' });
});
