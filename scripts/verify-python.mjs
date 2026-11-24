import assert from 'node:assert/strict';
import path from 'node:path';
import { realpath, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { prerequisites, runProcess, runCodexVerification, cleanEnvironment, repo } from './lib/codex-verification.mjs';

try {
  assert.ok(process.env.TEST_TY_BIN, 'Set TEST_TY_BIN to an installed ty 0.0.109 executable');
  assert.ok(process.env.TEST_PYTHON_ENV, 'Set TEST_PYTHON_ENV to a separately prepared test Python venv');
  const ty = await realpath(path.resolve(process.env.TEST_TY_BIN));
  const pythonEnv = await realpath(path.resolve(process.env.TEST_PYTHON_ENV));
  assert.ok((await stat(path.join(pythonEnv, 'pyvenv.cfg'))).isFile(), 'TEST_PYTHON_ENV must be a venv with pyvenv.cfg');
  const options = { ...await prerequisites(), python: true, ty, pythonEnv, useRuntimeConfig: process.env.TEST_PYTHON_RUNTIME_CONFIG === '1' };
  const trusted = process.argv.includes('--trusted-profile');
  if (trusted) {
    assert.ok(process.env.TEST_CODEX_PROFILE, 'Set TEST_CODEX_PROFILE to a separately installed and reviewed temporary Codex profile');
    const selected = await realpath(path.resolve(process.env.TEST_CODEX_PROFILE));
    const tempRoots = await Promise.all([tmpdir(), '/tmp'].map(p => realpath(p)));
    assert.ok(tempRoots.some(root => { const relative = path.relative(root, selected); return relative && !relative.startsWith('..') && !path.isAbsolute(relative); }), 'Trusted Python verification accepts only an explicit temporary profile');
    assert.notEqual(selected, await realpath(options.home), 'Do not use the current user profile');
    options.home = selected;
  }
  const env = { ...cleanEnvironment(options.home), TEST_TYPESCRIPT_DIR: options.typescript, TEST_TY_BIN: ty, TEST_PYTHON_ENV: pythonEnv };
  const version = await runProcess(ty, ['--version'], { env });
  assert.equal(version.code, 0); assert.match(version.stdout, /^ty 0\.0\.109(?:\s|$)/);
  console.log(`Prerequisites: ${options.codexVersion}; ${version.stdout.trim()}; TypeScript ${options.tsVersion}; language-server ${options.lspVersion}`);
  const check = await runProcess(process.execPath, ['scripts/check.mjs'], { cwd: repo, env });
  process.stdout.write(check.stdout); assert.equal(check.code, 0, 'Static checks failed');
  const files = (await readdir(new URL('../tests/', import.meta.url))).filter(f => f.startsWith('python-') && f.endsWith('.test.mjs')).map(f => `tests/${f}`);
  const tests = await runProcess(process.execPath, ['--test', '--test-reporter=tap', ...files], { cwd: repo, env });
  process.stdout.write(tests.stdout); assert.equal(tests.code, 0, 'Python tests failed');
  const counts = Object.fromEntries(['tests', 'pass', 'fail', 'skipped'].map(key => [key, Number(new RegExp(`^# ${key} (\\d+)$`, 'm').exec(tests.stdout)?.[1] ?? NaN)]));
  assert.ok(counts.tests > 0 && counts.pass === counts.tests && counts.fail === 0 && counts.skipped === 0, 'Python verification requires 0 skipped tests');
  await runCodexVerification(options, { installed: trusted });
  console.log(`PASS verify:python: ${counts.pass} tests, 0 skipped, standalone Python cache, both MCP servers and mixed apply_patch error/fix context`);
} catch (error) { console.error(`FAIL verify:python: ${error.message}`); process.exitCode = 1; }
