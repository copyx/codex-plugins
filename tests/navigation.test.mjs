import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mcp, value } from './helpers/mcp.mjs';

const ts = process.env.TEST_TYPESCRIPT_DIR;
const model = 'export interface Greeter { greet(name: string): string; }\n'
  + 'export class FriendlyGreeter implements Greeter { greet(name: string) { return name; } }\n'
  + 'export class FormalGreeter implements Greeter { greet(name: string) { return "Hello " + name; } }\n'
  + 'export function decorate(text: string) { return text; }\n';

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'typescript-lsp-navigation-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = path.join(root, 'packages/app');
  await mkdir(app, { recursive: true });
  await mkdir(path.join(root, 'node_modules'));
  await symlink(path.resolve(ts), path.join(root, 'node_modules/typescript'));
  await writeFile(path.join(app, 'tsconfig.json'), '{"compilerOptions":{"strict":true},"include":["*.ts"]}');
  const files = {
    'model.ts': model,
    'main.ts': 'import { Greeter, FriendlyGreeter } from "./model";\nconst service: Greeter = new FriendlyGreeter();\nservice.greet("hi");\nexport { service };\n',
    'empty.ts': '// No symbols here.\n',
    'unused.ts': 'export interface Unused { nothing(): void; }\n',
  };
  for (const [name, text] of Object.entries(files)) await writeFile(path.join(app, name), text);
  return { root, app, files };
}

const args = (root, file, extra = {}) => ({ workspace_root: root, file: `packages/app/${file}`, ...extra });

test('#22 MCP document symbols expose names/kinds/locations and empty results within the selected project', { skip: !ts && 'set TEST_TYPESCRIPT_DIR', timeout: 30000 }, async t => {
  const { root, app, files } = await fixture(t);
  const result = await mcp(root, [
    { name: 'document_symbols', arguments: args(root, 'model.ts') },
    { name: 'document_symbols', arguments: args(root, 'empty.ts') },
    { name: 'document_symbols', arguments: { workspace_root: root, file: '../outside.ts' } },
  ]);
  const tool = result.tools.find(t => t.name === 'document_symbols');
  assert.ok(tool, 'tools/list must advertise document_symbols');
  assert.deepEqual(tool.inputSchema.required, ['workspace_root', 'file']);
  assert.equal(tool.annotations.readOnlyHint, true);
  const data = value(result.calls[0]);
  assert.equal(data.project_root, app);
  assert.equal(data.config, path.join(app, 'tsconfig.json'));
  for (const [name, kind] of [['Greeter', 11], ['FriendlyGreeter', 5], ['decorate', 12], ['greet', 6]]) {
    assert.ok(data.result.some(s => s.name === name && s.kind === kind && s.location.uri.endsWith('/model.ts') && Number.isInteger(s.location.range.start.line)), `${name} kind/location missing`);
  }
  assert.deepEqual(value(result.calls[1]).result, []);
  assert.equal(result.calls[2].isError, true);
  assert.match(result.calls[2].content[0].text, /outside/);
  for (const [name, text] of Object.entries(files)) assert.equal(await readFile(path.join(app, name), 'utf8'), text);
});

test('#23 MCP type definition finds the variable type, preserves ordinary definition, and returns an empty result for no symbol', { skip: !ts && 'set TEST_TYPESCRIPT_DIR', timeout: 30000 }, async t => {
  const { root, app } = await fixture(t);
  const position = { line: 3, character: 2 };
  const result = await mcp(root, [
    { name: 'type_definition', arguments: args(root, 'main.ts', position) },
    { name: 'definition', arguments: args(root, 'main.ts', position) },
    { name: 'type_definition', arguments: args(root, 'empty.ts', { line: 1, character: 4 }) },
    { name: 'type_definition', arguments: args(root, 'main.ts') },
  ]);
  const tool = result.tools.find(t => t.name === 'type_definition');
  assert.ok(tool, 'tools/list must advertise type_definition');
  assert.deepEqual(tool.inputSchema.required, ['workspace_root', 'file', 'line', 'character']);
  assert.equal(tool.annotations.readOnlyHint, true);
  const type = value(result.calls[0]);
  assert.equal(type.project_root, app);
  assert.equal(type.result.length, 1);
  assert.ok(type.result[0].uri.endsWith('/model.ts'));
  assert.equal(type.result[0].range.start.line, 0);
  const definition = value(result.calls[1]);
  assert.ok(definition.result[0].uri.endsWith('/main.ts'));
  assert.equal(definition.result[0].range.start.line, 1);
  assert.deepEqual(value(result.calls[2]).result, []);
  assert.equal(result.calls[3].isError, true);
});

test('#24 MCP implementation returns multiple implementations and an empty result for an unused interface', { skip: !ts && 'set TEST_TYPESCRIPT_DIR', timeout: 30000 }, async t => {
  const { root, app, files } = await fixture(t);
  const result = await mcp(root, [
    { name: 'implementation', arguments: args(root, 'model.ts', { line: 1, character: 18 }) },
    { name: 'implementation', arguments: args(root, 'unused.ts', { line: 1, character: 18 }) },
  ]);
  const tool = result.tools.find(t => t.name === 'implementation');
  assert.ok(tool, 'tools/list must advertise implementation');
  assert.deepEqual(tool.inputSchema.required, ['workspace_root', 'file', 'line', 'character']);
  assert.equal(tool.annotations.readOnlyHint, true);
  const data = value(result.calls[0]);
  assert.equal(data.project_root, app);
  assert.equal(data.result.length, 2);
  assert.deepEqual(data.result.map(r => r.range.start.line).sort(), [1, 2]);
  assert.ok(data.result.every(r => r.uri.endsWith('/model.ts')));
  assert.deepEqual(value(result.calls[1]).result, []);
  for (const [name, text] of Object.entries(files)) assert.equal(await readFile(path.join(app, name), 'utf8'), text);
});

test('all new MCP tools reject path traversal and symlink escapes before opening a project', { skip: !ts && 'set TEST_TYPESCRIPT_DIR', timeout: 10000 }, async t => {
  const { root } = await fixture(t);
  await symlink('/etc/hosts', path.join(root, 'escape.ts'));
  const calls = ['document_symbols', 'type_definition', 'implementation'].flatMap(name => ['../outside.ts', 'escape.ts'].map(file => ({
    name, arguments: { workspace_root: root, file, ...(name === 'document_symbols' ? {} : { line: 1, character: 1 }) },
  })));
  const result = await mcp(root, calls);
  assert.equal(result.calls.length, 6);
  for (const call of result.calls) { assert.equal(call.isError, true); assert.match(call.content[0].text, /outside/); }
});
