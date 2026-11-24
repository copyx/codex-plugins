import test from 'node:test';
import assert from 'node:assert/strict';
import { commandEffect } from '../plugins/typescript-lsp/lib/operations.mjs';

const identity = { version: '6.0.3', executable_sha256: 'sha256:9d9193d6b7d8d92b291d0f1cae8ca3588a5481d8dd6bdf18bd93a43bd49c2916' };
const preview = { edit: { files: [{ file: '/project/main.ts', edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, new_text: 'import x;\n' }] }] } };
const action = { command: { command: '_typescript.applyCodeActionCommand', arguments: [{ action: { changes: [{ fileName: '/project/main.ts', textChanges: [{ start: { line: 1, offset: 1 }, end: { line: 1, offset: 1 }, newText: 'import x;\n' }] }] } }] } };

test('#29 only the audited empty-command wrapper with identical edits is proven a no-op', () => {
  assert.equal(commandEffect(action, preview, identity).status, 'proven_noop');
  assert.equal(commandEffect({}, preview, {}).status, 'none');
  assert.throws(() => commandEffect(action, preview, { ...identity, version: 'other' }), /Unsupported/);
  assert.throws(() => commandEffect(action, preview, { ...identity, executable_sha256: 'different' }), /Unsupported/);
  const extra = structuredClone(action); extra.command.arguments[0].action.commands = [{ type: 'install package' }];
  assert.throws(() => commandEffect(extra, preview, identity), /additional/);
  const other = structuredClone(action); other.command.command = 'other';
  assert.throws(() => commandEffect(other, preview, identity), /Unsupported/);
  const mismatched = structuredClone(action); mismatched.command.arguments[0].action.changes[0].textChanges[0].newText = 'different';
  assert.throws(() => commandEffect(mismatched, preview, identity), /differ/);
});
