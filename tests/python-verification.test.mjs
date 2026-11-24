import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { verifyPythonTransition } from '../scripts/lib/codex-verification.mjs';
const request = texts => ({ input: texts.map(text => ({ role: 'developer', content: [{ type: 'input_text', text }] })) });
const error = 'Python LSP post-patch diagnostics (changed files only; disk snapshot):\nmain.py:2:7: error ty invalid-argument-type bad';
const clean = 'Python LSP post-patch diagnostics (changed files only; disk snapshot):\nmain.py: no diagnostics published for this snapshot';
test('Python transition proof requires an independent fresh clean Python context', () => {
  assert.throws(() => verifyPythonTransition(request([error]), request([error])), /fresh/);
  assert.throws(() => verifyPythonTransition(request([error]), request([error, error])), /invalid-argument-type|clean/);
  assert.throws(() => verifyPythonTransition(request([error]), request([error, 'TypeScript LSP post-patch diagnostics\nmain.ts: no diagnostics'])), /fresh/);
  assert.throws(() => verifyPythonTransition(request([clean]), request([clean, clean])), /invalid-argument-type/);
  assert.deepEqual(verifyPythonTransition(request([error]), request([error, clean])), { pythonErrorContexts: 1, pythonFixedContexts: 2 });
});
test('Python full verification fails explicitly rather than skipping missing Python prerequisites', () => {
  const env = { ...process.env }; delete env.TEST_TY_BIN;
  const result = spawnSync(process.execPath, ['scripts/verify-python.mjs'], { env, encoding: 'utf8' });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /TEST_TY_BIN/);
});
