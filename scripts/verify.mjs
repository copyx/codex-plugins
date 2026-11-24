import { readdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { prerequisites, repo, runProcess, runCodexVerification, cleanEnvironment } from './lib/codex-verification.mjs';

try {
  const options = await prerequisites();
  console.log(`Prerequisites: ${options.codexVersion}; TypeScript ${options.tsVersion}; language-server ${options.lspVersion}`);
  const env = { ...cleanEnvironment(options.home), TEST_TYPESCRIPT_DIR: options.typescript };
  const check = await runProcess(process.execPath, ['scripts/check.mjs'], { cwd: repo, env });
  process.stdout.write(check.stdout);
  assert.equal(check.code, 0, 'Static checks failed');
  const files = (await readdir(new URL('../tests/', import.meta.url))).filter(f => f.endsWith('.test.mjs') && !f.startsWith('python-')).map(f => `tests/${f}`);
  const tests = await runProcess(process.execPath, ['--test', '--test-reporter=tap', ...files], { cwd: repo, env });
  process.stdout.write(tests.stdout);
  assert.equal(tests.code, 0, 'Tests failed');
  const counts = Object.fromEntries(['tests', 'pass', 'fail', 'skipped'].map(key => [key, Number(new RegExp(`^# ${key} (\\d+)$`, 'm').exec(tests.stdout)?.[1] ?? NaN)]));
  assert.ok(counts.tests > 0 && counts.tests === counts.pass && counts.fail === 0 && counts.skipped === 0, 'Full test coverage required: missing counts, failures, or skipped tests');
  await runCodexVerification(options);
  console.log(`PASS verify: ${counts.pass} tests, 0 skipped, static checks and isolated Codex integration`);
} catch (error) { console.error(`FAIL verify: ${error.message}`); process.exitCode = 1; }
