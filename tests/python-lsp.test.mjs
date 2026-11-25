import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath, cp, chmod, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveProject } from '../plugins/python-lsp/lib/project.mjs';
import { LspSession } from '../plugins/python-lsp/lib/lsp.mjs';
import { runtimeConfigPath } from '../plugins/python-lsp/lib/runtime.mjs';

const ty = process.env.TEST_TY_BIN;
const pythonEnv = process.env.TEST_PYTHON_ENV;
const plugin = fileURLToPath(new URL('../plugins/python-lsp/', import.meta.url));
const real = { skip: !(ty && pythonEnv) && 'set TEST_TY_BIN and TEST_PYTHON_ENV', timeout: 30000 };
async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'python-lsp-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  if (pythonEnv) await symlink(pythonEnv, path.join(root, '.venv'));
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'pyproject.toml'), '[project]\nname = "fixture"\nversion = "0.0.0"\n[tool.ty.environment]\nroot = ["src"]\n');
  await writeFile(path.join(root, 'src/lib.py'), 'def greet(name: str) -> str:\n    return name\n');
  await writeFile(path.join(root, 'main.py'), 'from lib import greet\ngreet("hello")\n');
  return root;
}
// Use a real stdin child for MCP and hook entry points, not imported dispatch.
async function entry(root, script, input, bundle = plugin, overrides = {}) {
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, [path.join(bundle, script)], { cwd: root, env: { ...process.env, PYTHON_LSP_TY: ty, ...overrides } });
  let stdout = '', stderr = '';
  child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 24000);
  try {
    child.stdin.end(input);
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    assert.equal(code, 0, stderr); return stdout;
  } finally { clearTimeout(timer); child.kill(); }
}
const message = (id, name, args) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
test('Python real LSP capabilities, src layout navigation and fresh v1/v2 empty diagnostics', real, async t => {
  const root = await fixture(t), project = await resolveProject('main.py', root, { env: {} });
  const s = new LspSession(project, { command: ty }); t.after(() => s.close());
  await s.start();
  assert.equal(s.capabilities.positionEncoding, 'utf-16');
  assert.ok(s.capabilities.definitionProvider && s.capabilities.referencesProvider && s.capabilities.hoverProvider);
  const uri = await s.sync(project.file), params = { textDocument: { uri }, position: { line: 1, character: 2 } };
  assert.match(JSON.stringify(await s.request('textDocument/definition', params)), /src\/lib.py/);
  assert.ok((await s.request('textDocument/references', { ...params, context: { includeDeclaration: true } })).length >= 2);
  assert.match(JSON.stringify(await s.request('textDocument/hover', params)), /name: str/);
  await writeFile(project.file, 'from lib import greet\ngreet(123)\n');
  const bad = (await s.diagnostics([project.file]))[0];
  assert.equal(bad.status, 'received'); assert.ok(bad.diagnostics.some(d => d.code === 'invalid-argument-type'));
  await writeFile(project.file, 'from lib import greet\ngreet("fixed")\n');
  const fixed = (await s.diagnostics([project.file]))[0];
  assert.equal(fixed.status, 'received'); assert.deepEqual(fixed.diagnostics, []);
  assert.ok(fixed.version > bad.version);
});
test('Python ty.toml wins over pyproject rules and both config forms apply', real, async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'main.py'), 'def f(x: str): return x\nf(123)\n');
  await writeFile(path.join(root, 'ty.toml'), '[rules]\ninvalid-argument-type = "ignore"\n');
  const s = new LspSession(await resolveProject('main.py', root, { env: {} }), { command: ty }); t.after(() => s.close());
  await s.start(); const results = await s.diagnostics([path.join(root, 'main.py')]);
  assert.equal(results[0].status, 'received'); assert.deepEqual(results[0].diagnostics, []);
});
test('Python actual MCP lists nine read-only tools; Unicode CRLF and .pyi calls work from standalone cache', real, async t => {
  const root = await fixture(t), bundle = path.join(root, 'cache/python-lsp');
  await cp(plugin, bundle, { recursive: true });
  const line = 'emoji = "😀"; value = greet("hi")';
  await writeFile(path.join(root, 'unicode.py'), `from lib import greet\r\n${line}\r\n# no symbol here\r\n`);
  await writeFile(path.join(root, 'src/api.pyi'), 'def greet_stub(name: str) -> str: ...\n');
  await writeFile(path.join(root, 'stub.py'), 'from api import greet_stub\ngreet_stub("hi")\n');
  const args = { workspace_root: root, file: 'unicode.py', line: 2, character: line.indexOf('greet') + 2 };
  const requests = [ { jsonrpc: '2.0', id: 1, method: 'initialize' }, { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    ...['definition', 'references', 'hover'].map((name, i) => message(i + 3, name, args)),
    message(6, 'definition', { ...args, line: 3, character: 1 }),
    message(7, 'definition', { ...args, file: 'stub.py', line: 2, character: 2 }),
    message(8, 'hover', { ...args, file: 'src/api.pyi', line: 1, character: 8 }),
    message(9, 'hover', { ...args, file: '../outside.py' }),
    message(10, 'hover', { ...args, line: 200 }),
    message(11, 'hover', { ...args, character: 11 }), // splitting the emoji surrogate pair
    message(12, 'hover', { ...args, extra: true }) ];
  const output = (await entry(root, 'server.mjs', requests.map(JSON.stringify).join('\n') + '\n', bundle)).trim().split('\n').map(JSON.parse);
  assert.equal(output[0].result.serverInfo.version, JSON.parse(await readFile(path.join(plugin,'.codex-plugin/plugin.json'),'utf8')).version);
  assert.deepEqual(output[1].result.tools.map(t => t.name), ['definition', 'references', 'hover', 'document_symbols', 'project_symbols', 'type_definition', 'implementation', 'code_actions_preview', 'rename_preview']);
  assert.ok(output[1].result.tools.every(t => t.annotations.readOnlyHint && !t.annotations.destructiveHint));
  for (const id of [3,4,5,6,7,8]) assert.ok(!output.find(r => r.id === id).result.isError, JSON.stringify(output.find(r => r.id === id)));
  assert.match(JSON.stringify(output.find(r => r.id === 3).result), /src\/lib.py/);
  const hover = JSON.parse(output.find(r => r.id === 5).result.content[0].text).result;
  assert.equal(hover.range.start.character, line.indexOf('greet'));
  assert.equal(JSON.parse(output.find(r => r.id === 6).result.content[0].text).result, null);
  assert.match(JSON.stringify(output.find(r => r.id === 7)), /api.pyi/);
  for (const id of [9,10,11,12]) assert.equal(output.find(r => r.id === id).result.isError, true);
});
test('Python hook reports actual error then new clean snapshot and ignores deletion/non-Python/other tools', real, async t => {
  const root = await fixture(t);
  const event = { cwd: root, hook_event_name: 'PostToolUse', tool_name: 'apply_patch', tool_input: '*** Update File: main.py\n*** Update File: main.ts\n*** Delete File: gone.py' };
  await writeFile(path.join(root, 'main.py'), 'from lib import greet\ngreet(123)\n');
  const bad = JSON.parse(await entry(root, 'hooks/post-tool-use.mjs', JSON.stringify(event))).hookSpecificOutput.additionalContext;
  assert.match(bad, /ty.*invalid-argument-type/); assert.doesNotMatch(bad, /main.ts|gone.py/);
  await writeFile(path.join(root, 'main.py'), 'from lib import greet\ngreet("fixed")\n');
  const clean = JSON.parse(await entry(root, 'hooks/post-tool-use.mjs', JSON.stringify(event))).hookSpecificOutput.additionalContext;
  assert.match(clean, /main.py: no diagnostics published for this snapshot/); assert.doesNotMatch(clean, /invalid-argument-type/);
  for (const patch of ['*** Delete File: main.py', '*** Update File: main.ts']) assert.equal(await entry(root, 'hooks/post-tool-use.mjs', JSON.stringify({ ...event, tool_input: patch })), '');
  assert.equal(await entry(root, 'hooks/post-tool-use.mjs', JSON.stringify({ ...event, tool_name: 'Bash' })), '');
});
test('Python request and diagnostic deadlines reap unresponsive children; missing executable is actionable', { timeout: 6000 }, async t => {
  const root = await fixture(t), command = path.join(root, 'silent-lsp');
  await cp(new URL('./fixtures/silent-lsp.mjs', import.meta.url), command); await chmod(command, 0o755);
  const p = { root, file: path.join(root, 'main.py'), workspace: root, environment: { path: root } };
  // Allow the fixture's Node process to start under suite load. Diagnostic and
  // unanswered-request deadlines below remain independent of this startup wait.
  const s = new LspSession(p, { command, checkVersion: false, timeoutMs: 2000, diagnosticMs: 80, requireCapabilities: false });
  t.after(() => s.close()); await s.start();
  assert.equal((await s.diagnostics([p.file]))[0].status, 'timeout');
  await assert.rejects(s.request('unanswered', {}, 30), /timeout/);
  await s.close(); await new Promise(r => setTimeout(r, 40));
  assert.throws(() => process.kill(s.child.pid, 0), /ESRCH/);
  const missing = new LspSession(p, { command: path.join(root, 'missing') });
  await assert.rejects(missing.start(), /PYTHON_LSP_TY|not found|ENOENT/); await missing.close();
});
test('Python rejects old diagnostic versions, oversize frames and unsupported server requests', () => {
  const s = new LspSession({ root: '/tmp' });
  assert.throws(() => s.consume(Buffer.from('Content-Length: 99999999\r\n\r\n')), /exceeds/);
  const frames = []; s.send = m => frames.push(m);
  const consume = message => { const b = Buffer.from(JSON.stringify(message)); s.consume(Buffer.concat([Buffer.from(`Content-Length: ${b.length}\r\n\r\n`), b])); };
  s.buffer = Buffer.alloc(0);
  consume({ jsonrpc: '2.0', id: 1, method: 'workspace/applyEdit', params: { edit: {} } });
  assert.equal(frames[0].result.applied, false);
  s.documents.set('file:///tmp/a.py', { version: 2 });
  consume({ method: 'textDocument/publishDiagnostics', params: { uri: 'file:///tmp/a.py', version: 1, diagnostics: [{ message: 'old' }] } });
  assert.equal(s.freshPublication('file:///tmp/a.py', 0), false);
  consume({ method: 'textDocument/publishDiagnostics', params: { uri: 'file:///tmp/a.py', diagnostics: [] } });
  assert.equal(s.freshPublication('file:///tmp/a.py', 0), false, 'versionless publication cannot prove this snapshot');
});
test('Python MCP invalid JSON/unknown tools remain errors without terminating', async t => {
  const root = await fixture(t);
  const responses = (await entry(root, 'server.mjs', 'null\nno-json\n' + JSON.stringify(message(1, '__proto__', {})) + '\n')).trim().split('\n').map(JSON.parse);
  assert.equal(responses[0].error.code, -32600); assert.equal(responses[1].error.code, -32700); assert.equal(responses[2].result.isError, true);
});
test('Python external venv import locations are labeled outside without bridge source reads', real, async t => {
  const root = await fixture(t), external = `${root}-venv`;
  t.after(() => rm(external, { recursive: true, force: true }));
  const { runProcess } = await import('../scripts/lib/codex-verification.mjs');
  const prepared = await runProcess(path.join(pythonEnv, 'bin/python'), ['-I', '-m', 'venv', '--without-pip', external], { timeoutMs: 10000 });
  assert.equal(prepared.code, 0);
  const metadata = await readFile(path.join(external, 'pyvenv.cfg'), 'utf8');
  const version = /^version = (\d+\.\d+)/m.exec(metadata)[1];
  const site = path.join(external, `lib/python${version}/site-packages/env_marker`);
  await mkdir(site, { recursive: true });
  await writeFile(path.join(site, '__init__.py'), 'def external(value: str) -> str:\n    return value\n');
  await writeFile(path.join(site, 'py.typed'), '');
  await writeFile(path.join(root, 'external.py'), 'from env_marker import external\nexternal("hello")\n');
  const output = JSON.parse((await entry(root, 'server.mjs', JSON.stringify(message(1, 'definition', { workspace_root: root, file: 'external.py', line: 2, character: 2 })) + '\n', plugin, { PYTHON_LSP_PYTHON: external })).trim());
  assert.ok(!output.result.isError, JSON.stringify(output));
  const data = JSON.parse(output.result.content[0].text);
  assert.equal(data.result[0].workspace_boundary, 'outside');
  assert.match(data.result[0].targetUri ?? data.result[0].uri, /env_marker/);
  assert.equal(Object.hasOwn(data.result[0], 'text'), false);
});
test('Python mixed-project hook reports new/moved .py/.pyi separately and missing environment as not checked', real, async t => {
  const root = await fixture(t);
  for (const [name, type] of [['a', 'str'], ['b', 'int']]) {
    await mkdir(path.join(root, name));
    await symlink(pythonEnv, path.join(root, name, '.venv'));
    await writeFile(path.join(root, name, 'ty.toml'), '[environment]\nroot = ["."]\n');
    await writeFile(path.join(root, name, 'main.py'), `def f(value: ${type}): return value\nf(123)\n`);
  }
  await writeFile(path.join(root, 'b/api.pyi'), 'def api(value: int) -> int: ...\n');
  await mkdir(path.join(root, 'missing'));
  await writeFile(path.join(root, 'missing/ty.toml'), '');
  await writeFile(path.join(root, 'missing/main.py'), 'x = 1');
  const event = { cwd: root, hook_event_name: 'PostToolUse', tool_name: 'apply_patch', tool_input: { patch: '*** Update File: a/old.py\n*** Move to: a/main.py\n*** Add File: b/main.py\n*** Add File: b/api.pyi\n*** Update File: missing/main.py' } };
  const context = JSON.parse(await entry(root, 'hooks/post-tool-use.mjs', JSON.stringify(event))).hookSpecificOutput.additionalContext;
  assert.match(context, /a\/main.py:.*ty invalid-argument-type/);
  assert.match(context, /b\/main.py: no diagnostics/); assert.match(context, /b\/api.pyi: no diagnostics/);
  assert.match(context, /missing\/main.py: not checked: Set PYTHON_LSP_PYTHON/); assert.doesNotMatch(context, /old.py/);
});
test('Python hook unavailable server is incomplete, never a fresh clean result', real, async t => {
  const root = await fixture(t);
  const event = { cwd: root, hook_event_name: 'PostToolUse', tool_name: 'apply_patch', tool_input: '*** Update File: main.py' };
  const context = JSON.parse(await entry(root, 'hooks/post-tool-use.mjs', JSON.stringify(event), plugin, { PYTHON_LSP_TY: path.join(root, 'missing-ty') })).hookSpecificOutput.additionalContext;
  assert.match(context, /incomplete.*PYTHON_LSP_TY/); assert.doesNotMatch(context, /no diagnostics/);
});
test('Python validates exact ty version and absolute executable before starting a server', async t => {
  const root = await fixture(t), command = path.join(root, 'wrong-ty');
  await writeFile(command, '#!/usr/bin/env node\nconsole.log("ty 0.0.108");\n'); await chmod(command, 0o755);
  const p = { root, environment: { path: root } };
  const wrong = new LspSession(p, { command });
  await assert.rejects(wrong.start(), /must be ty 0.0.109/); assert.equal(wrong.child, undefined);
  const relative = new LspSession(p, { command: 'ty' });
  await assert.rejects(relative.start(), /absolute/); assert.equal(relative.child, undefined);
});
test('Python no-config workspace does not inherit parent ty rules across its boundary', real, async t => {
  const parent = await fixture(t), root = path.join(parent, 'isolated');
  await writeFile(path.join(parent, 'ty.toml'), '[rules]\ninvalid-argument-type = "ignore"\n');
  await mkdir(root); await symlink(pythonEnv, path.join(root, '.venv'));
  await writeFile(path.join(root, 'main.py'), 'def greet(name: str): return name\ngreet(123)\n');
  const project = await resolveProject('main.py', root, { env: {} });
  assert.equal(project.config, null);
  const s = new LspSession(project, { command: ty }); t.after(() => s.close());
  await s.start();
  const result = (await s.diagnostics([project.file]))[0];
  assert.equal(result.status, 'received');
  assert.ok(result.diagnostics.some(d => d.code === 'invalid-argument-type'));
});
test('Python MCP and hook use the same Node-home runtime settings without PYTHON_LSP_TY', real, async t => {
  const root=await fixture(t), home=await realpath(await mkdtemp(path.join(tmpdir(),'python-entry-home-')));
  t.after(()=>rm(home,{recursive:true,force:true}));
  await mkdir(path.dirname(runtimeConfigPath(home)),{recursive:true,mode:0o700});
  await writeFile(runtimeConfigPath(home),JSON.stringify({ty_path:ty}),{mode:0o600});
  const env={HOME:home,PYTHON_LSP_TY:undefined};
  const args={workspace_root:root,file:'main.py',line:2,character:2};
  const result=JSON.parse((await entry(root,'server.mjs',JSON.stringify(message(1,'hover',args))+'\n',plugin,env)).trim()).result;
  assert.ok(!result.isError,JSON.stringify(result));
  const data=JSON.parse(result.content[0].text);
  assert.equal(data.server.executable,ty);assert.equal(data.server.configuration_source,'user_config');
  await writeFile(path.join(root,'main.py'),'from lib import greet\ngreet(123)\n');
  const event={cwd:root,hook_event_name:'PostToolUse',tool_name:'apply_patch',tool_input:'*** Update File: main.py'};
  const context=JSON.parse(await entry(root,'hooks/post-tool-use.mjs',JSON.stringify(event),plugin,env)).hookSpecificOutput.additionalContext;
  assert.match(context,/ty invalid-argument-type/);
  const overridden=JSON.parse((await entry(root,'server.mjs',JSON.stringify(message(1,'hover',args))+'\n',plugin,{...env,PYTHON_LSP_TY:path.join(root,'missing-ty')})).trim()).result;
  assert.equal(overridden.isError,true);assert.match(overridden.content[0].text,/PYTHON_LSP_TY/);
  const wrong=path.join(root,'wrong-ty');await writeFile(wrong,'#!/usr/bin/env node\nconsole.log("ty 0.0.108");\n');await chmod(wrong,0o755);
  await writeFile(runtimeConfigPath(home),JSON.stringify({ty_path:wrong}));
  const version=JSON.parse((await entry(root,'server.mjs',JSON.stringify(message(1,'hover',args))+'\n',plugin,env)).trim()).result;
  assert.equal(version.isError,true);assert.match(version.content[0].text,/config.json must be ty 0.0.109/);
});
test('Python running MCP bridge rereads runtime settings on each tool call without restarting', real, async t => {
  const root=await fixture(t), home=await realpath(await mkdtemp(path.join(tmpdir(),'python-live-home-')));
  t.after(()=>rm(home,{recursive:true,force:true}));
  await mkdir(path.dirname(runtimeConfigPath(home)),{recursive:true,mode:0o700});
  await writeFile(runtimeConfigPath(home),JSON.stringify({ty_path:ty}),{mode:0o600});
  const {spawn}=await import('node:child_process'),{createInterface}=await import('node:readline');
  const child=spawn(process.execPath,[path.join(plugin,'server.mjs')],{cwd:root,env:{...process.env,HOME:home,PYTHON_LSP_TY:undefined}});
  child.stderr.resume();const lines=createInterface({input:child.stdout});
  t.after(()=>{lines.close();child.kill();});
  async function call(id){
    const response=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('MCP test response timeout')),10000);lines.once('line',line=>{clearTimeout(timer);resolve(JSON.parse(line).result);});});
    child.stdin.write(JSON.stringify(message(id,'hover',{workspace_root:root,file:'main.py',line:2,character:2}))+'\n');return response;
  }
  assert.ok(!(await call(1)).isError);
  await writeFile(runtimeConfigPath(home),JSON.stringify({ty_path:path.join(root,'missing-ty')}));
  assert.equal((await call(2)).isError,true);
  await writeFile(runtimeConfigPath(home),JSON.stringify({ty_path:ty}));
  assert.ok(!(await call(3)).isError);assert.equal(child.exitCode,null);
});
test('Python document_symbols MCP accepts file-only input and preserves real ty hierarchy, UTF-16 ranges and empty results', real, async t => {
  const root=await fixture(t);
  const source='class Greeter:\r\n    def greet(self, name: str) -> str:\r\n        return name\r\n\r\ndef decorate(text: str) -> str:\r\n    return text\r\n\r\ndef 𐐀function():\r\n    pass\r\n';
  await writeFile(path.join(root,'symbols.py'),source);
  await writeFile(path.join(root,'api.pyi'),'class Api:\n    def read(self, name: str) -> str: ...\n');
  await writeFile(path.join(root,'empty.py'),'# 😀 no symbols\r\n');
  await symlink('/etc/hosts',path.join(root,'escape.py'));
  const args={workspace_root:root,file:'symbols.py'};
  const requests=[{jsonrpc:'2.0',id:1,method:'tools/list'},message(2,'document_symbols',args),message(3,'document_symbols',{...args,file:'empty.py'}),message(4,'document_symbols',{...args,file:'api.pyi'}),message(5,'document_symbols',{...args,file:'../outside.py'}),message(6,'document_symbols',{...args,file:'escape.py'}),message(7,'document_symbols',{...args,line:1,character:1})];
  const responses=(await entry(root,'server.mjs',requests.map(JSON.stringify).join('\n')+'\n')).trim().split('\n').map(JSON.parse);
  const tool=responses[0].result.tools.find(t=>t.name==='document_symbols');
  assert.ok(tool,'document_symbols must be advertised');
  assert.deepEqual(tool.inputSchema.required,['workspace_root','file']);
  assert.deepEqual(Object.keys(tool.inputSchema.properties),['workspace_root','file']);
  assert.equal(tool.annotations.readOnlyHint,true);assert.equal(tool.annotations.destructiveHint,false);
  const value=id=>{const r=responses.find(r=>r.id===id).result;assert.ok(!r.isError,JSON.stringify(r));return JSON.parse(r.content[0].text).result;};
  const symbols=value(2),greeter=symbols.find(s=>s.name==='Greeter'),decorate=symbols.find(s=>s.name==='decorate');
  assert.equal(greeter.kind,5);assert.equal(greeter.selectionRange.start.line,0);
  const greet=greeter.children.find(s=>s.name==='greet');assert.equal(greet.kind,6);assert.equal(greet.range.start.line,1);assert.equal(greet.selectionRange.start.character,8);
  assert.equal(decorate.kind,12);assert.equal(decorate.selectionRange.start.line,4);
  const unicode=symbols.find(s=>s.name==='𐐀function');
  assert.equal(unicode.selectionRange.end.character-unicode.selectionRange.start.character,'𐐀function'.length);
  assert.deepEqual(value(3),[]);assert.equal(value(4).find(s=>s.name==='Api').children[0].name,'read');
  for(const id of [5,6,7])assert.equal(responses.find(r=>r.id===id).result.isError,true);
  const project=await resolveProject('symbols.py',root,{env:{}}),session=new LspSession(project,{command:ty});t.after(()=>session.close());
  await session.start();const uri=await session.sync(project.file);
  assert.deepEqual(symbols,await session.request('textDocument/documentSymbol',{textDocument:{uri}}),'MCP must preserve every original LSP field and hierarchy');
  assert.equal(await readFile(project.file,'utf8'),source);
});
test('Python symbol tools preserve LSP shapes and distinguish null, unsupported capability and LSP error', async t => {
  const root=await fixture(t);
  const command=path.join(root,'fixture-ty');
  const fake=String.raw`#!/usr/bin/env node
if (process.argv.includes('--version')) { console.log('ty 0.0.109'); process.exit(0); }
let buffer = Buffer.alloc(0);
const mode = FIXTURE_SYMBOL_MODE;
function send(message) {
  const body = JSON.stringify(message);
  process.stdout.write('Content-Length: ' + Buffer.byteLength(body) + '\r\n\r\n' + body);
}
process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const end = buffer.indexOf('\r\n\r\n');
    if (end < 0) return;
    const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, end).toString())[1]);
    if (buffer.length < end + 4 + length) return;
    const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length));
    buffer = buffer.subarray(end + 4 + length);
    if (message.method === 'initialize') {
      send({ jsonrpc:'2.0', id:message.id, result:{ capabilities:{ definitionProvider:true, referencesProvider:true, hoverProvider:true, documentSymbolProvider:mode !== 'unsupported', workspaceSymbolProvider:mode !== 'unsupported', typeDefinitionProvider:mode !== 'unsupported', implementationProvider:mode !== 'unsupported' } } });
    } else if (message.method === 'textDocument/typeDefinition' || message.method === 'textDocument/implementation') {
      if (mode === 'error') send({ jsonrpc:'2.0', id:message.id, error:{ code:-32601, message:message.method + ' unavailable' } });
      else {
        const range = { start:{line:0,character:0}, end:{line:0,character:4} };
        const location = { uri:'file:///outside/type.pyi', range };
        const link = { originSelectionRange:range, targetUri:'file:///outside/type.pyi', targetRange:range, targetSelectionRange:range };
        const result = mode === 'location' ? location : mode === 'locations' ? [location] : mode === 'links' ? [link] : mode === 'null' ? null : mode === 'single-link' ? link : mode === 'mixed' ? [location,link] : mode === 'bad-range' ? { ...location, range:{ start:{line:-1,character:0}, end:{line:0,character:1} } } : mode === 'invalid-array' ? [{}] : { unexpected:true };
        send({ jsonrpc:'2.0', id:message.id, result });
      }
    } else if (message.method === 'textDocument/documentSymbol' || message.method === 'workspace/symbol') {
      if (mode === 'error') send({ jsonrpc:'2.0', id:message.id, error:{ code:-32601, message:'documentSymbol unavailable' } });
      else {
        const flat = [{ name:'FlatSymbol', kind:12, containerName:'module', location:{ uri:message.params.textDocument?.uri ?? 'file:///outside/library.py', range:{ start:{ line:0, character:0 }, end:{ line:0, character:1 } } }, deprecated:false }];
        send({ jsonrpc:'2.0', id:message.id, result:mode === 'null' ? null : mode === 'invalid' ? { unexpected:true } : flat });
      }
    } else if (message.method === 'shutdown') send({ jsonrpc:'2.0', id:message.id, result:null });
    else if (message.method === 'exit') process.exit(0);
  }
});
`;
  await writeFile(command,fake);await chmod(command,0o755);
  if(!pythonEnv){await mkdir(path.join(root,'.venv/bin'),{recursive:true});await writeFile(path.join(root,'.venv/pyvenv.cfg'),'version = 3.15.2');await symlink(process.execPath,path.join(root,'.venv/bin/python'));}
  const call=async(mode,name='document_symbols')=>{
    const request=JSON.stringify(message(1,name,{workspace_root:root,file:'main.py',...(name==='project_symbols'?{query:'FlatSymbol'}:['type_definition','implementation'].includes(name)?{line:1,character:2}:{})}))+'\n';
    await writeFile(command,fake.replace('FIXTURE_SYMBOL_MODE',JSON.stringify(mode)));return JSON.parse((await entry(root,'server.mjs',request,plugin,{PYTHON_LSP_TY:command})).trim()).result;
  };
  const flat=await call('flat');assert.ok(!flat.isError,JSON.stringify(flat));
  assert.deepEqual(JSON.parse(flat.content[0].text).result,[{name:'FlatSymbol',kind:12,containerName:'module',location:{uri:`file://${root}/main.py`,range:{start:{line:0,character:0},end:{line:0,character:1}}},deprecated:false}]);
  assert.deepEqual(JSON.parse((await call('null')).content[0].text).result,[]);
  const unsupported=await call('unsupported');assert.equal(unsupported.isError,true);assert.match(unsupported.content[0].text,/documentSymbol|document_symbols/);
  const error=await call('error');assert.equal(error.isError,true);assert.match(error.content[0].text,/-32601.*unavailable/);
  const invalid=await call('invalid');assert.equal(invalid.isError,true);assert.match(invalid.content[0].text,/documentSymbol.*array or null/);
  const project=await call('flat','project_symbols');assert.ok(!project.isError,JSON.stringify(project));
  assert.deepEqual(JSON.parse(project.content[0].text).result,[{name:'FlatSymbol',kind:12,containerName:'module',location:{uri:'file:///outside/library.py',range:{start:{line:0,character:0},end:{line:0,character:1}}},deprecated:false,workspace_boundary:'outside'}]);
  assert.deepEqual(JSON.parse((await call('null','project_symbols')).content[0].text).result,[]);
  for(const mode of ['unsupported','error','invalid']){const r=await call(mode,'project_symbols');assert.equal(r.isError,true);assert.match(r.content[0].text,/workspace\/symbol|-32601/);}
  const range={start:{line:0,character:0},end:{line:0,character:4}};
  const location={uri:'file:///outside/type.pyi',range,workspace_boundary:'outside'};
  for(const name of ['type_definition','implementation']) {
    for(const mode of ['location','locations','links','null']) {
      const r=await call(mode,name);assert.ok(!r.isError,JSON.stringify(r));const result=JSON.parse(r.content[0].text).result;
      const expected=mode==='location'?location:mode==='locations'?[location]:mode==='links'?[{originSelectionRange:range,targetUri:'file:///outside/type.pyi',targetRange:range,targetSelectionRange:range,workspace_boundary:'outside'}]:[];
      assert.deepEqual(result,expected);
    }
    for(const mode of ['unsupported','error','invalid','invalid-array','bad-range','single-link','mixed']) {
      const r=await call(mode,name);assert.equal(r.isError,true,mode);assert.match(r.content[0].text,name==='implementation'?/implementation|-32601/:/typeDefinition|-32601/);
    }
  }
});
test('Python project_symbols finds unopened files in the selected project and separates sibling settings', real, async t => {
  const root=await fixture(t);
  for (const [name,symbol] of [['a','HiddenAlpha'],['b','HiddenBeta']]) {
    await mkdir(path.join(root,name,'src'),{recursive:true});await symlink(pythonEnv,path.join(root,name,'.venv'));
    await writeFile(path.join(root,name,'ty.toml'),'[environment]\nroot = ["src"]\n');
    await writeFile(path.join(root,name,'main.py'),'# anchor only\n');
    await writeFile(path.join(root,name,'src/hidden.py'),`class ${symbol}:\n    pass\n`);
  }
  await symlink('/etc/hosts',path.join(root,'a/escape.py'));
  const args={workspace_root:root,file:'a/main.py',query:'HiddenAlpha'};
  const requests=[{jsonrpc:'2.0',id:1,method:'tools/list'},message(2,'project_symbols',args),message(3,'project_symbols',{...args,query:'NoSuchSymbolAnywhere'}),message(4,'project_symbols',{...args,query:'HiddenBeta'}),message(5,'project_symbols',{...args,file:'b/main.py',query:'HiddenBeta'}),message(6,'project_symbols',{...args,file:'../outside.py'}),message(7,'project_symbols',{...args,file:'a/escape.py'}),...['','  ',null,12].map((query,i)=>message(i+8,'project_symbols',{...args,query})),message(12,'project_symbols',{...args,line:1})];
  const responses=(await entry(root,'server.mjs',requests.map(JSON.stringify).join('\n')+'\n')).trim().split('\n').map(JSON.parse);
  const tool=responses[0].result.tools.find(t=>t.name==='project_symbols');assert.ok(tool,'project_symbols must be advertised');
  assert.deepEqual(tool.inputSchema.required,['workspace_root','file','query']);assert.deepEqual(Object.keys(tool.inputSchema.properties),['workspace_root','file','query']);assert.equal(tool.annotations.readOnlyHint,true);
  const value=id=>{const r=responses.find(r=>r.id===id).result;assert.ok(!r.isError,JSON.stringify(r));return JSON.parse(r.content[0].text);};
  const found=value(2);assert.equal(found.result[0].name,'HiddenAlpha');assert.equal(found.result[0].kind,5);assert.match(found.result[0].location.uri,/a\/src\/hidden.py$/);assert.equal(found.result[0].workspace_boundary,'inside');
  assert.deepEqual(found.search_scope,{kind:'selected_project_session',workspace_root:root,project_root:path.join(root,'a'),config:path.join(root,'a/ty.toml'),anchor_file:path.join(root,'a/main.py')});
  assert.deepEqual(value(3).result,[]);assert.deepEqual(value(4).result,[]);assert.equal(value(5).result[0].name,'HiddenBeta');assert.equal(value(5).search_scope.project_root,path.join(root,'b'));
  for(const id of [6,7,8,9,10,11,12])assert.equal(responses.find(r=>r.id===id).result.isError,true);
  const project=await resolveProject('a/main.py',root,{env:{}}),session=new LspSession(project,{command:ty});t.after(()=>session.close());
  await session.start();await session.sync(project.file);const raw=await session.request('workspace/symbol',{query:'HiddenAlpha'});
  assert.deepEqual(found.result.map(({workspace_boundary,...symbol})=>symbol),raw);
});
test('Python project_symbols distinguishes import roots, excluded files and the anchor-selected project scope', real, async t => {
  const root=await fixture(t);
  for (const name of ['a','b']) {await mkdir(path.join(root,name),{recursive:true});await symlink(pythonEnv,path.join(root,name,'.venv'));}
  await writeFile(path.join(root,'a/ty.toml'),'[environment]\nroot = [".", "../b"]\n[src]\nexclude = ["excluded.py"]\n');
  await writeFile(path.join(root,'b/ty.toml'),'[environment]\nroot = ["."]\n');
  await writeFile(path.join(root,'b/remote.py'),'class ImportedSibling:\n    pass\n');
  await writeFile(path.join(root,'a/main.py'),'from remote import ImportedSibling\ninstance = ImportedSibling()\n');
  await writeFile(path.join(root,'a/local.py'),'class LocalIncluded:\n    pass\n');
  await writeFile(path.join(root,'a/excluded.py'),'class ExcludedLocal:\n    pass\n');
  const anchor={workspace_root:root,file:'a/main.py'};
  const requests=[message(1,'project_symbols',{...anchor,query:'ImportedSibling'}),message(2,'definition',{...anchor,line:2,character:13}),message(3,'project_symbols',{...anchor,query:'LocalIncluded'}),message(4,'project_symbols',{...anchor,query:'ExcludedLocal'}),message(5,'project_symbols',{...anchor,file:'main.py',query:'ImportedSibling'})];
  const responses=(await entry(root,'server.mjs',requests.map(JSON.stringify).join('\n')+'\n')).trim().split('\n').map(JSON.parse);
  const value=id=>{const r=responses.find(r=>r.id===id).result;assert.ok(!r.isError,JSON.stringify(r));return JSON.parse(r.content[0].text);};
  assert.equal(value(1).search_scope.project_root,path.join(root,'a'));assert.deepEqual(value(1).result,[]);
  assert.match(value(2).result[0].uri??value(2).result[0].targetUri,/b\/remote.py$/,'configured sibling import resolves even when absent from workspace/symbol');
  assert.ok(value(3).result.some(s=>s.name==='LocalIncluded'));assert.deepEqual(value(4).result,[]);
  assert.equal(value(5).search_scope.project_root,root);
  assert.ok(value(5).result.some(s=>s.name==='ImportedSibling'&&s.location.uri.endsWith('/b/remote.py')),'the parent-selected project can include the sibling');
});
test('Python type_definition distinguishes variable definition and py/pyi type declarations with UTF-16 input', real, async t => {
  const root=await fixture(t);
  await writeFile(path.join(root,'src/models.py'),'class Person:\n    pass\n');
  await writeFile(path.join(root,'src/typed_api.pyi'),'class StubPerson:\n    ...\n');
  await writeFile(path.join(root,'typed_ref.pyi'),'from typed_api import StubPerson\nrecord: StubPerson\n');
  const lines=['from models import Person','from typed_api import StubPerson','person: Person = Person()','stub: StubPerson = StubPerson()','emoji = "😀"; use_person = person','use_stub = stub','# no type'];
  const source=lines.join('\r\n')+'\r\n';await writeFile(path.join(root,'typed.py'),source);
  await writeFile(path.join(root,'no_type.py'),'# No type here\n');await writeFile(path.join(root,'unknown.py'),'unknown_value\n');await symlink('/etc/hosts',path.join(root,'escape.py'));
  const args={workspace_root:root,file:'typed.py',line:5,character:lines[4].lastIndexOf('person')+2};
  const requests=[{jsonrpc:'2.0',id:1,method:'tools/list'},message(2,'definition',args),message(3,'type_definition',args),message(4,'type_definition',{...args,line:6,character:lines[5].lastIndexOf('stub')+2}),message(5,'type_definition',{...args,file:'typed_ref.pyi',line:2,character:2}),message(6,'type_definition',{...args,file:'no_type.py',line:1,character:2}),message(7,'type_definition',{...args,line:7,character:1}),message(8,'type_definition',{...args,file:'../outside.py'}),message(9,'type_definition',{...args,file:'escape.py'}),message(10,'type_definition',{workspace_root:root,file:'typed.py'}),message(11,'type_definition',{...args,query:'Person'}),message(12,'type_definition',{...args,file:'unknown.py',line:1,character:2})];
  const responses=(await entry(root,'server.mjs',requests.map(JSON.stringify).join('\n')+'\n')).trim().split('\n').map(JSON.parse);
  const tool=responses[0].result.tools.find(t=>t.name==='type_definition');assert.ok(tool,'type_definition must be advertised');
  assert.deepEqual(tool.inputSchema.required,['workspace_root','file','line','character']);assert.equal(tool.annotations.readOnlyHint,true);assert.equal(tool.annotations.destructiveHint,false);
  const value=id=>{const r=responses.find(r=>r.id===id).result;assert.ok(!r.isError,JSON.stringify(r));return JSON.parse(r.content[0].text).result;};
  const one=result=>Array.isArray(result)?result[0]:result;
  const definition=one(value(2)),type=one(value(3));
  assert.match(definition.uri??definition.targetUri,/\/typed.py$/);assert.equal((definition.range??definition.targetSelectionRange).start.line,2);
  assert.match(type.uri??type.targetUri,/\/src\/models.py$/);assert.equal((type.range??type.targetSelectionRange).start.line,0);assert.equal(type.workspace_boundary,'inside');
  t.diagnostic(`Actual ty typeDefinition response: ${Array.isArray(value(3))?'array':'single'} ${type.targetUri?'LocationLink':'Location'}`);
  for(const id of [4,5])assert.match(one(value(id)).uri??one(value(id)).targetUri,/typed_api.pyi$/);
  assert.deepEqual(value(6),[]);assert.deepEqual(value(7),[]);
  const unknown=value(12);
  if(Array.isArray(unknown)&&unknown.length===0)t.diagnostic('Unresolved name: server returned no type');
  else {const target=one(unknown);assert.match(target.uri??target.targetUri,/ty_extensions\/_internal.pyi$/);assert.equal(target.workspace_boundary,'outside');t.diagnostic('Unresolved name: preserved external ty Unknown stub type');}
  for(const id of [8,9,10,11])assert.equal(responses.find(r=>r.id===id).result.isError,true);
  const project=await resolveProject('typed.py',root,{env:{}}),session=new LspSession(project,{command:ty});t.after(()=>session.close());
  await session.start();const uri=await session.sync(project.file);
  const raw=await session.request('textDocument/typeDefinition',{textDocument:{uri},position:{line:args.line-1,character:args.character-1}});
  const unmark=result=>Array.isArray(result)?result.map(({workspace_boundary,...location})=>location):(({workspace_boundary,...location})=>location)(result);
  assert.deepEqual(unmark(value(3)),raw);assert.equal(await readFile(project.file,'utf8'),source);
});
test('Python implementation preserves abstract base and multiple class/member implementations across files', real, async t => {
  const root=await fixture(t);
  const sources={
    'src/base.py':'from abc import ABC, abstractmethod\nclass Greeter(ABC):\n    @abstractmethod\n    def greet(self, name: str) -> str: ...\n',
    'src/friendly.py':'from base import Greeter\nclass FriendlyGreeter(Greeter):\n    def greet(self, name: str) -> str:\n        return name\n',
    'src/formal.py':'from base import Greeter\nclass FormalGreeter(Greeter):\n    def greet(self, name: str) -> str:\n        return "Hello " + name\n',
  };
  const lines=['from base import Greeter','from friendly import FriendlyGreeter','from formal import FormalGreeter','emoji = "😀"; service: Greeter = FriendlyGreeter()','output = service.greet("hi")','# no implementation'];
  sources['implementation.py']=lines.join('\r\n')+'\r\n';
  for(const[file,text]of Object.entries(sources))await writeFile(path.join(root,file),text);
  await symlink('/etc/hosts',path.join(root,'escape.py'));
  const args={workspace_root:root,file:'implementation.py',line:4,character:lines[3].indexOf('Greeter')+2};
  const requests=[{jsonrpc:'2.0',id:1,method:'tools/list'},message(2,'implementation',args),message(3,'implementation',{...args,file:'src/base.py',line:4,character:10}),message(4,'implementation',{...args,line:6,character:1}),message(5,'implementation',{...args,file:'../outside.py'}),message(6,'implementation',{...args,file:'escape.py'}),message(7,'implementation',{workspace_root:root,file:'implementation.py'}),message(8,'implementation',{...args,query:'Greeter'}),message(9,'implementation',{...args,line:200})];
  const responses=(await entry(root,'server.mjs',requests.map(JSON.stringify).join('\n')+'\n')).trim().split('\n').map(JSON.parse);
  const tool=responses[0].result.tools.find(t=>t.name==='implementation');assert.ok(tool,'implementation must be advertised');
  assert.deepEqual(tool.inputSchema.required,['workspace_root','file','line','character']);assert.equal(tool.annotations.readOnlyHint,true);assert.equal(tool.annotations.destructiveHint,false);
  const value=id=>{const r=responses.find(r=>r.id===id).result;assert.ok(!r.isError,JSON.stringify(r));return JSON.parse(r.content[0].text).result;};
  const locations=value(2),uri=location=>location.uri??location.targetUri;
  for(const file of ['base.py','friendly.py','formal.py'])assert.ok(locations.some(l=>uri(l).endsWith('/'+file)),`class implementation ${file} missing`);
  assert.ok(locations.every(l=>l.workspace_boundary==='inside'));
  const base=locations.find(l=>uri(l).endsWith('/base.py'));assert.equal((base.range??base.targetSelectionRange).start.line,1);
  const members=value(3);
  for(const file of ['base.py','friendly.py','formal.py'])assert.ok(members.some(l=>uri(l).endsWith('/'+file)),`member implementation ${file} missing`);
  t.diagnostic(`Actual ty implementation: ${locations.length} class locations and ${members.length} member locations; ${locations[0].targetUri?'LocationLink':'Location'} array`);
  assert.deepEqual(value(4),[]);for(const id of [5,6,7,8,9])assert.equal(responses.find(r=>r.id===id).result.isError,true);
  const project=await resolveProject('implementation.py',root,{env:{}}),session=new LspSession(project,{command:ty});t.after(()=>session.close());
  await session.start();const document=await session.sync(project.file);
  const raw=await session.request('textDocument/implementation',{textDocument:{uri:document},position:{line:args.line-1,character:args.character-1}});
  const canonical=result=>result.map(({workspace_boundary,...location})=>location).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
  assert.deepEqual(canonical(locations),canonical(raw));
  for(const[file,text]of Object.entries(sources))assert.equal(await readFile(path.join(root,file),'utf8'),text);
});
test('Python code_actions_preview uses fresh ty diagnostics, import/suppression edits and stable new-session IDs without writes',real,async t=>{
  const root=await fixture(t),line='emoji = "😀"; answer = square(2)',source=line+'\r\n';
  await writeFile(path.join(root,'quickfix.py'),source);await writeFile(path.join(root,'src/utils.py'),'def square(value: int) -> int:\n    return value * value\n');await writeFile(path.join(root,'clean.py'),'# no diagnostics or fixes\n');
  const start=line.indexOf('square')+1,args={workspace_root:root,file:'quickfix.py',range:{start:{line:1,character:start},end:{line:1,character:start+6}}};
  const requests=[{jsonrpc:'2.0',id:1,method:'tools/list'},message(2,'code_actions_preview',args),message(3,'code_actions_preview',{...args,file:path.join(root,'quickfix.py')}),message(4,'code_actions_preview',{...args,file:'clean.py',range:{start:{line:1,character:1},end:{line:1,character:1}}}),message(5,'code_actions_preview',{...args,range:{start:args.range.end,end:args.range.start}}),message(6,'code_actions_preview',{...args,file:'../outside.py'}),message(7,'code_actions_preview',{...args,line:1})];
  const responses=(await entry(root,'server.mjs',requests.map(JSON.stringify).join('\n')+'\n')).trim().split('\n').map(JSON.parse);
  const tool=responses[0].result.tools.find(t=>t.name==='code_actions_preview');assert.ok(tool,'code_actions_preview must be advertised');
  assert.deepEqual(tool.inputSchema.required,['workspace_root','file','range']);assert.equal(tool.annotations.readOnlyHint,true);assert.equal(tool.annotations.destructiveHint,false);
  const value=id=>{const r=responses.find(r=>r.id===id).result;assert.ok(!r.isError,JSON.stringify(r));return JSON.parse(r.content[0].text);};
  const first=value(2),second=value(3);assert.equal(first.diagnostics_status,'received');assert.ok(first.diagnostics.some(d=>d.code==='unresolved-reference'));
  const imported=first.result.find(a=>a.category==='import'),suppression=first.result.find(a=>a.category==='suppression');
  assert.ok(imported,'real ty import fix required');assert.ok(suppression,'real ty suppression must remain distinct');
  assert.equal(imported.status,'edit_available');assert.equal(imported.preview_only,true);assert.ok(imported.edit.files.some(f=>f.edits.some(e=>/from utils import square/.test(e.new_text))));
  assert.match(imported.selection_id,/^sha256:[a-f0-9]{64}$/);assert.equal(imported.selection_id,second.result.find(a=>a.title===imported.title).selection_id);
  for(const candidate of first.result)assert.equal(candidate.selection_id,second.result.find(a=>a.action_fingerprint===candidate.action_fingerprint)?.selection_id);
  assert.equal(imported.basis.request.file,path.join(root,'quickfix.py'));assert.equal(imported.basis.scope.project_root,root);assert.ok(imported.basis.server.executable_sha256);
  assert.deepEqual(value(4).result,[]);assert.deepEqual(value(4).diagnostics,[]);
  for(const id of [5,6,7])assert.equal(responses.find(r=>r.id===id).result.isError,true);
  assert.equal(await readFile(path.join(root,'quickfix.py'),'utf8'),source);assert.equal(await readFile(path.join(root,'src/utils.py'),'utf8'),'def square(value: int) -> int:\n    return value * value\n');
});
test('Python code_actions_preview normal MCP distinguishes unavailable/incomplete/errors and never executes deferred or command/resource actions',{timeout:30000},async t=>{
  const root=await fixture(t),command=path.join(root,'fixture-actions.mjs');
  await cp(new URL('./fixtures/python-code-actions-lsp.mjs',import.meta.url),command);await chmod(command,0o755);
  if(!pythonEnv){await mkdir(path.join(root,'.venv/bin'),{recursive:true});await writeFile(path.join(root,'.venv/pyvenv.cfg'),'version = 3.15.2');await symlink(process.execPath,path.join(root,'.venv/bin/python'));}
  const original=await readFile(path.join(root,'main.py'),'utf8');
  const request=JSON.stringify(message(1,'code_actions_preview',{workspace_root:root,file:'main.py',range:{start:{line:1,character:1},end:{line:1,character:8}}}))+'\n';
  const call=async mode=>{await writeFile(path.join(root,'preview-mode'),mode);return JSON.parse((await entry(root,'server.mjs',request,plugin,{PYTHON_LSP_TY:command})).trim()).result;};
  const result=await call('variants');assert.ok(!result.isError,JSON.stringify(result));const previews=JSON.parse(result.content[0].text).result;
  assert.deepEqual(previews.map(p=>p.status),['edit_available','disabled','requires_resolve','requires_command','requires_command','unsupported_edit']);
  const audit=JSON.parse(await readFile(path.join(root,'preview-audit.json'),'utf8'));assert.deepEqual(audit.forbidden,[]);assert.equal(audit.applyEditResult.applied,false);
  assert.deepEqual(audit.context.only,['quickfix']);assert.equal(audit.context.diagnostics[0].code,'unresolved-reference');
  await assert.rejects(readFile(path.join(root,'new.py')),{code:'ENOENT'});
  assert.deepEqual(JSON.parse((await call('empty')).content[0].text).result,[]);
  for(const mode of ['unsupported','not-quickfix','error','invalid','incomplete']){const r=await call(mode);assert.equal(r.isError,true,mode);assert.match(r.content[0].text,/codeAction|Diagnostics incomplete/);}
  const incomplete=JSON.parse(await readFile(path.join(root,'preview-audit.json'),'utf8'));assert.ok(!incomplete.methods.includes('textDocument/codeAction'));
  assert.equal(await readFile(path.join(root,'main.py'),'utf8'),original);
});
test('Python rename_preview shows scoped declaration/import/references and stable IDs without source changes',real,async t=>{
  const root=await fixture(t),line='emoji = "😀"; item = Greeter()';
  const sources={'src/model.py':'class Greeter:\n    pass\n','rename-use.py':'from model import Greeter\r\n'+line+'\r\n# no symbol\r\n','unrelated.py':'def local():\n    class Greeter:\n        pass\n    return Greeter()\n'};
  for(const[file,text]of Object.entries(sources))await writeFile(path.join(root,file),text);await symlink('/etc/hosts',path.join(root,'escape.py'));
  const args={workspace_root:root,file:'rename-use.py',line:2,character:line.indexOf('Greeter')+2,new_name:'RenamedGreeter'};
  const requests=[{jsonrpc:'2.0',id:1,method:'tools/list'},message(2,'rename_preview',args),message(3,'rename_preview',{...args,file:path.join(root,'rename-use.py')}),message(4,'rename_preview',{...args,new_name:'새이름'}),message(5,'rename_preview',{...args,line:3,character:1}),message(6,'rename_preview',{...args,new_name:'Greeter'}),message(7,'rename_preview',{...args,new_name:'class'}),message(8,'rename_preview',{...args,new_name:'e\u0301'}),message(9,'rename_preview',{...args,file:'../outside.py'}),message(10,'rename_preview',{...args,file:'escape.py'})];
  const responses=(await entry(root,'server.mjs',requests.map(JSON.stringify).join('\n')+'\n')).trim().split('\n').map(JSON.parse);
  const tool=responses[0].result.tools.find(t=>t.name==='rename_preview');assert.ok(tool,'rename_preview must be advertised');assert.deepEqual(tool.inputSchema.required,['workspace_root','file','line','character','new_name']);assert.equal(tool.annotations.readOnlyHint,true);
  const value=id=>{const r=responses.find(r=>r.id===id).result;assert.ok(!r.isError,JSON.stringify(r));return JSON.parse(r.content[0].text);};
  const first=value(2);assert.equal(first.status,'preview_available');assert.equal(first.result.status,'edit_available');assert.ok(first.result.edit.files.length>=2);
  assert.ok(first.result.edit.files.some(f=>f.file.endsWith('/src/model.py')));assert.ok(first.result.edit.files.some(f=>f.file.endsWith('/rename-use.py')));assert.ok(!first.result.edit.files.some(f=>f.file.endsWith('/unrelated.py')));
  assert.equal(first.result.selection_id,value(3).result.selection_id);assert.notEqual(first.result.selection_id,value(4).result.selection_id);
  assert.ok(value(4).result.edit.files.some(f=>f.edits.some(e=>e.new_text==='새이름')));
  assert.equal(value(5).status,'not_renamable');assert.equal(value(6).status,'no_changes');
  for(const id of [7,8,9,10])assert.equal(responses.find(r=>r.id===id).result.isError,true);
  t.diagnostic(`Actual ty rename prepare: ${first.prepare.status}; edit forms: ${[...new Set(first.result.edit.files.map(f=>f.source))].join(',')}`);
  for(const[file,text]of Object.entries(sources))assert.equal(await readFile(path.join(root,file),'utf8'),text);
});
test('Python rename_preview normal MCP handles prepare variants, documentChanges and errors without applying anything',{timeout:30000},async t=>{
  const root=await fixture(t),command=path.join(root,'fixture-rename.mjs'),source='old = 1\n';
  await cp(new URL('./fixtures/python-rename-lsp.mjs',import.meta.url),command);await chmod(command,0o755);await writeFile(path.join(root,'rename-source.py'),source);
  if(!pythonEnv){await mkdir(path.join(root,'.venv/bin'),{recursive:true});await writeFile(path.join(root,'.venv/pyvenv.cfg'),'version = 3.15.2');await symlink(process.execPath,path.join(root,'.venv/bin/python'));}
  const request=JSON.stringify(message(1,'rename_preview',{workspace_root:root,file:'rename-source.py',line:1,character:2,new_name:'renamed'}))+'\n';
  const call=async mode=>{await writeFile(path.join(root,'rename-mode'),mode);return JSON.parse((await entry(root,'server.mjs',request,plugin,{PYTHON_LSP_TY:command})).trim()).result;};
  for(const mode of ['document','range','default','false-default','no-prepare']){
    const r=await call(mode);assert.ok(!r.isError,JSON.stringify(r));const data=JSON.parse(r.content[0].text);assert.equal(data.status,'preview_available');assert.equal(data.result.status,'edit_available');
    const audit=JSON.parse(await readFile(path.join(root,'rename-audit.json'),'utf8'));assert.deepEqual(audit.forbidden,[]);assert.equal(audit.applyEditResult.applied,false);
    if(mode==='no-prepare')assert.ok(!audit.methods.includes('textDocument/prepareRename'));
  }
  const none=await call('no-symbol');assert.ok(!none.isError);assert.equal(JSON.parse(none.content[0].text).status,'not_renamable');
  assert.ok(!JSON.parse(await readFile(path.join(root,'rename-audit.json'),'utf8')).methods.includes('textDocument/rename'));
  for(const mode of ['null-edit','empty-edit'])assert.equal(JSON.parse((await call(mode)).content[0].text).status,'no_changes');
  for(const mode of ['unsupported','prepare-error','bad-prepare','error','invalid-result','command']){const r=await call(mode);assert.equal(r.isError,true,mode);assert.match(r.content[0].text,/rename|Rename|WorkspaceEdit/);}
  for(const mode of ['external','resource']){const r=await call(mode);assert.ok(!r.isError);assert.equal(JSON.parse(r.content[0].text).result.status,'unsupported_edit');}
  await assert.rejects(readFile(path.join(root,'renamed.py')),{code:'ENOENT'});assert.equal(await readFile(path.join(root,'rename-source.py'),'utf8'),source);
});
