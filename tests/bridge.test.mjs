import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath, copyFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { resolveProject, patchFiles } from '../plugins/typescript-lsp/lib/project.mjs';
import { LspSession } from '../plugins/typescript-lsp/lib/lsp.mjs';

const plugin = fileURLToPath(new URL('../plugins/typescript-lsp/', import.meta.url));
const ts = process.env.TEST_TYPESCRIPT_DIR;
async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'typescript-lsp-test-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'node_modules'), { recursive: true });
  if (ts) await symlink(ts, path.join(root, 'node_modules/typescript'));
  await writeFile(path.join(root, 'tsconfig.json'), '{"compilerOptions":{"strict":true},"include":["*.ts"]}');
  await writeFile(path.join(root, 'lib.ts'), 'export function greet(name: string) { return name; }\n');
  await writeFile(path.join(root, 'main.ts'), 'import { greet } from "./lib";\ngreet("hello");\n');
  return root;
}

test('patch paths include destination of moves and exclude deleted files', () => {
  assert.deepEqual(patchFiles('*** Begin Patch\n*** Add File: a.ts\n+x\n*** Update File: b.ts\n*** Move to: moved.ts\n@@\n-x\n+y\n*** Delete File: gone.ts\n*** End Patch'), ['a.ts', 'moved.ts']);
});

test('project resolution rejects traversal and symlink escapes', async t => {
  const root = await fixture(t);
  await assert.rejects(resolveProject('../outside.ts', root), /outside/);
  await symlink('/etc/hosts', path.join(root, 'escape.ts'));
  await assert.rejects(resolveProject('escape.ts', root), /outside/);
});

test('missing project TypeScript is actionable and never uses a global fallback', async t => {
  const root = await fixture(t);
  await rm(path.join(root, 'node_modules'), { recursive: true });
  await assert.rejects(resolveProject('main.ts', root), /TypeScript.*node_modules/);
});

test('diagnostic timeout stays incomplete and an unresponsive server is killed', { timeout: 5000 }, async t => {
  const root = await fixture(t);
  const command = path.join(root, 'silent-lsp');
  await copyFile(new URL('./fixtures/silent-lsp.mjs', import.meta.url), command);
  await chmod(command, 0o755);
  const session = new LspSession({ root, tsserver: '/unused/tsserver.js' }, { command, diagnosticMs: 100, timeoutMs: 1000 });
  t.after(() => session.close());
  await session.start();
  const results = await session.diagnostics([path.join(root, 'main.ts')]);
  assert.equal(results[0].status, 'timeout');
  await assert.rejects(session.request('unanswered', {}, 30), /timeout/);
  await session.close();
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.throws(() => process.kill(session.child.pid, 0), /ESRCH/);
});

test('LSP rejects files in a sibling project and missing server exits promptly', async t => {
  const root = await fixture(t);
  const session = new LspSession({ root: path.join(root, 'other'), tsserver: '/unused' }, { command: path.join(root, 'does-not-exist') });
  await assert.rejects(session.sync(path.join(root, 'main.ts')), /mix LSP project roots/);
  const missing = new LspSession({ root, tsserver: '/unused' }, { command: path.join(root, 'does-not-exist') });
  await assert.rejects(missing.start(), /ENOENT/);
  await missing.close();
});

test('nearest config and hoisted project TypeScript are selected', { skip: !ts && 'set TEST_TYPESCRIPT_DIR' }, async t => {
  const root = await fixture(t);
  await mkdir(path.join(root, 'packages/app'), { recursive: true });
  await writeFile(path.join(root, 'packages/app/tsconfig.json'), '{}');
  await writeFile(path.join(root, 'packages/app/app.ts'), 'export const x = 1;');
  const project = await resolveProject('packages/app/app.ts', root);
  assert.equal(project.root, path.join(root, 'packages/app'));
  assert.match(project.tsserver, /typescript\/lib\/tsserver\.js$/);
});

test('real LSP navigation and versionless didChange TS2345 diagnostics', { skip: !ts && 'set TEST_TYPESCRIPT_DIR', timeout: 30000 }, async t => {
  const root = await fixture(t);
  const project = await resolveProject('main.ts', root);
  const session = new LspSession(project);
  t.after(() => session.close());
  await session.start();
  const uri = await session.sync(project.file);
  await session.diagnostics([project.file]);
  const position = { line: 1, character: 2 };
  const definition = await session.request('textDocument/definition', { textDocument: { uri }, position });
  assert.match(JSON.stringify(definition), /lib\.ts/);
  const references = await session.request('textDocument/references', { textDocument: { uri }, position, context: { includeDeclaration: true } });
  assert.ok(references.length >= 2);
  const hover = await session.request('textDocument/hover', { textDocument: { uri }, position });
  assert.match(JSON.stringify(hover), /name: string/);
  await writeFile(project.file, 'import { greet } from "./lib";\ngreet(123);\n');
  const result = await session.diagnostics([project.file]);
  assert.equal(result[0].status, 'received');
  assert.ok(result[0].diagnostics.some(d => d.code === 2345));
  await session.close();
  assert.equal(session.child.exitCode, 0);
});

function run(script, input, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(plugin, script)], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', b => { stdout += b; });
    child.stderr.on('data', b => { stderr += b; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

test('PostToolUse produces additionalContext with real TS2345', { skip: !ts && 'set TEST_TYPESCRIPT_DIR', timeout: 30000 }, async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'main.ts'), 'import { greet } from "./lib";\ngreet(123);\n');
  const result = await run('hooks/post-tool-use.mjs', JSON.stringify({ cwd: root, hook_event_name: 'PostToolUse', tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Update File: main.ts\n@@\n-greet("hello");\n+greet(123);\n*** End Patch' } }), root);
  assert.equal(result.code, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.match(output.hookSpecificOutput.additionalContext, /TS2345/);
});

test('one patch keeps sibling project diagnostics separate', { skip: !ts && 'set TEST_TYPESCRIPT_DIR', timeout: 30000 }, async t => {
  const root = await fixture(t);
  for (const [name, type] of [['a', 'string'], ['b', 'number']]) {
    await mkdir(path.join(root, name));
    await writeFile(path.join(root, name, 'tsconfig.json'), '{"compilerOptions":{"strict":true}}');
    await writeFile(path.join(root, name, 'main.ts'), `function accept(value: ${type}) { return value; }\naccept(123);\n`);
  }
  const result = await run('hooks/post-tool-use.mjs', JSON.stringify({ cwd: root, hook_event_name: 'PostToolUse', tool_name: 'apply_patch', tool_input: { command: '*** Update File: a/main.ts\n*** Update File: b/main.ts' } }), root);
  const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
  assert.match(context, /a\/main.ts:2:8: error TS2345/);
  assert.match(context, /b\/main.ts: no diagnostics/);
});

test('JavaScript uses jsconfig and project TypeScript diagnostics', { skip: !ts && 'set TEST_TYPESCRIPT_DIR', timeout: 30000 }, async t => {
  const root = await fixture(t);
  await mkdir(path.join(root, 'js'));
  await writeFile(path.join(root, 'js/jsconfig.json'), '{"compilerOptions":{"checkJs":true,"allowJs":true}}');
  await writeFile(path.join(root, 'js/main.js'), '/** @param {string} name */\nfunction greet(name) { return name; }\ngreet(123);\n');
  const project = await resolveProject('js/main.js', root);
  assert.match(project.config, /jsconfig.json$/);
  const session = new LspSession(project);
  t.after(() => session.close());
  await session.start();
  const result = await session.diagnostics([project.file]);
  assert.ok(result[0].diagnostics.some(d => d.code === 2345));
});

test('hook ignores unrelated tools and reports missing TypeScript without blocking', async t => {
  const root = await fixture(t);
  await rm(path.join(root, 'node_modules'), { recursive: true });
  const event = { cwd: root, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: '*** Update File: main.ts' } };
  assert.equal((await run('hooks/post-tool-use.mjs', JSON.stringify(event), root)).stdout, '');
  event.tool_name = 'apply_patch';
  const result = await run('hooks/post-tool-use.mjs', JSON.stringify(event), root);
  assert.equal(result.code, 0);
  assert.match(JSON.parse(result.stdout).hookSpecificOutput.additionalContext, /not checked: Project TypeScript/);
});

test('MCP malformed input and unknown tools return errors without killing the bridge', async t => {
  const root = await fixture(t);
  const result = await run('server.mjs', 'null\n' + JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: '__proto__', arguments: {} } }) + '\n', root);
  assert.equal(result.code, 0);
  const responses = result.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(responses[0].error.code, -32600);
  assert.equal(responses[1].result.isError, true);
});

test('MCP initializes, lists navigation tools, calls hover over stdio, and closes', { skip: !ts && 'set TEST_TYPESCRIPT_DIR', timeout: 30000 }, async t => {
  const root = await fixture(t);
  const messages = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'hover', arguments: { workspace_root: root, file: 'main.ts', line: 2, character: 3 } } },
  ];
  const result = await run('server.mjs', messages.map(m => JSON.stringify(m)).join('\n') + '\n', root);
  assert.equal(result.code, 0, result.stderr);
  const responses = result.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(responses.find(r => r.id === 2).result.tools.length, 3);
  const call = responses.find(r => r.id === 3).result;
  assert.ok(!call.isError, JSON.stringify(call));
  assert.match(JSON.stringify(call), /name: string/);
});
