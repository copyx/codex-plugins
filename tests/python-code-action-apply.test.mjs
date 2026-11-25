import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const plugin = fileURLToPath(new URL('../plugins/python-lsp/', import.meta.url));
const message = (id, name, args) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
async function mcp(root, requests, command = process.env.TEST_TY_BIN) {
  const child = spawn(process.execPath, [path.join(plugin, 'server.mjs')], { cwd: root, env: { ...process.env, PYTHON_LSP_TY: command ?? '' }, stdio: ['pipe','pipe','pipe'] });
  let stdout = '', stderr = ''; child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 24000);
  try {
    child.stdin.end(requests.map(JSON.stringify).join('\n') + '\n');
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    assert.equal(code, 0, stderr); return stdout.trim().split('\n').map(JSON.parse).map(r => r.result);
  } finally { clearTimeout(timer); child.kill(); }
}
const value = result => { assert.ok(!result.isError, result.content?.[0]?.text); return JSON.parse(result.content[0].text); };
test('Python MCP preserves strict selected quickfix schema alongside nine read tools and two write tools', async () => {
  const [listed] = await mcp(tmpdir(), [{ jsonrpc: '2.0', id: 1, method: 'tools/list' }]);
  const tool = listed.tools.find(t => t.name === 'code_action_apply'); assert.ok(tool, 'selected quickfix application must be advertised');
  assert.equal(listed.tools.length, 11); assert.equal(listed.tools.filter(t => t.annotations.readOnlyHint).length, 9); assert.equal(listed.tools.filter(t => !t.annotations.readOnlyHint).length, 2);
  assert.equal(tool.annotations.readOnlyHint, false); assert.equal(tool.annotations.destructiveHint, true); assert.equal(tool.annotations.idempotentHint, false);
  assert.deepEqual(tool.inputSchema.required, ['workspace_root','file','range','selection_id']); assert.equal(tool.inputSchema.additionalProperties, false);
  assert.deepEqual(Object.keys(tool.inputSchema.properties), ['workspace_root','file','range','selection_id']);
});
async function fixture(t, commandFixture = false) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'python-quickfix-apply-'))); t.after(() => fs.rm(root, { recursive: true, force: true }));
  if (process.env.TEST_PYTHON_ENV) await fs.symlink(process.env.TEST_PYTHON_ENV, path.join(root, '.venv'));
  else { await fs.mkdir(path.join(root, '.venv/bin'), { recursive: true }); await fs.writeFile(path.join(root, '.venv/pyvenv.cfg'), 'version = 3.15.2\n'); await fs.writeFile(path.join(root, '.venv/bin/python'), 'fixture'); await fs.chmod(path.join(root, '.venv/bin/python'), 0o755); }
  await fs.mkdir(path.join(root, 'src')); await fs.writeFile(path.join(root, 'ty.toml'), '[environment]\nroot=["src"]\n');
  const source = 'answer = square(2)\r\n', file = path.join(root, 'main.py'); await fs.writeFile(file, source);
  await fs.writeFile(path.join(root, 'src/utils.py'), 'def square(value: int) -> int:\n    return value * value\n');
  await fs.writeFile(path.join(root, 'unrelated.py'), 'untouched = 1\n');
  const args = { workspace_root: root, file: 'main.py', range: { start: { line: 1, character: 10 }, end: { line: 1, character: 16 } } };
  let command;
  if (commandFixture) { command = path.join(root, 'fixture-lsp.mjs'); await fs.copyFile(new URL('./fixtures/python-code-action-apply-lsp.mjs', import.meta.url), command); await fs.chmod(command, 0o755); await fs.writeFile(path.join(root, 'apply-mode'), 'normal'); }
  return { root, file, source, args, command };
}
const real = { skip: !(process.env.TEST_TY_BIN && process.env.TEST_PYTHON_ENV) && 'set TEST_TY_BIN and TEST_PYTHON_ENV', timeout: 30000 };
test('Python selected actual ty import edit applies once and returns new diagnostics without suppression or unrelated changes', real, async t => {
  const f = await fixture(t), shown = value((await mcp(f.root, [message(1, 'code_actions_preview', f.args)]))[0]);
  const imported = shown.result.find(p => p.category === 'import'), suppressed = shown.result.find(p => p.category === 'suppression');
  assert.ok(imported && suppressed); assert.equal(imported.status, 'edit_available'); assert.equal(await fs.readFile(f.file, 'utf8'), f.source);
  const args = { ...f.args, selection_id: imported.selection_id };
  const response = (await mcp(f.root, [message(1, 'code_action_apply', args)]))[0], applied = value(response).result;
  assert.equal(applied.status, 'applied'); assert.equal(applied.selection_id, imported.selection_id); assert.equal(applied.diagnostics_status, 'received');
  assert.equal(applied.diagnostics.length, 1); assert.ok(applied.diagnostics.every(d => d.status === 'received' && !d.diagnostics.some(x => x.code === 'unresolved-reference')));
  const after = await fs.readFile(f.file, 'utf8'); assert.match(after, /from utils import square/); assert.ok(!after.includes('ignore')); assert.ok(after.endsWith(f.source));
  assert.equal(await fs.readFile(path.join(f.root, 'src/utils.py'), 'utf8'), 'def square(value: int) -> int:\n    return value * value\n'); assert.equal(await fs.readFile(path.join(f.root, 'unrelated.py'), 'utf8'), 'untouched = 1\n');
  const duplicate = (await mcp(f.root, [message(1, 'code_action_apply', args)]))[0]; assert.equal(duplicate.isError, true); assert.match(duplicate.content[0].text, /stale|selection/i); assert.equal(await fs.readFile(f.file, 'utf8'), after);
});
test('Python write MCP rejects forged arguments, altered requests and stale disk selections without writes', real, async t => {
  const f = await fixture(t), shown = value((await mcp(f.root, [message(1, 'code_actions_preview', f.args)]))[0]);
  const selected = shown.result.find(p => p.category === 'import'), args = { ...f.args, selection_id: selected.selection_id };
  const invalid = ['edit','basis','command','selection_ids','apply_all'].map(key => ({ ...args, [key]: key === 'apply_all' ? true : {} }));
  invalid.push({ ...f.args }, { ...args, selection_id: 'not-an-id' }, { ...args, selection_id: 'sha256:'+'0'.repeat(64) }, { ...args, range: { ...args.range, extra: true } }, { ...args, range: { start: { line: 1, character: 1 }, end: { line: 1, character: 1 } } }, { ...args, file: '../outside.py' });
  const results = await mcp(f.root, invalid.map((a,i) => message(i+1,'code_action_apply',a)));
  assert.ok(results.every(r => r.isError), JSON.stringify(results)); assert.equal(await fs.readFile(f.file,'utf8'),f.source);
  await fs.writeFile(f.file, f.source+'# separate user edit\n');
  const stale = (await mcp(f.root,[message(1,'code_action_apply',args)]))[0]; assert.equal(stale.isError,true); assert.match(stale.content[0].text,/stale|selection/i); assert.equal(await fs.readFile(f.file,'utf8'),f.source+'# separate user edit\n');
});
const audit = async f => (await fs.readFile(path.join(f.root,'apply-audit.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
test('Python controlled MCP rejects command/deferred/disabled/resource/annotation/external candidates without writes or post sessions', { timeout:30000 }, async t => {
  const f=await fixture(t,true), shown=value((await mcp(f.root,[message(1,'code_actions_preview',f.args)],f.command))[0]);
  for(const candidate of shown.result.filter(p=>p.status!=='edit_available')){
    const result=(await mcp(f.root,[message(1,'code_action_apply',{...f.args,selection_id:candidate.selection_id})],f.command))[0];
    assert.equal(result.isError,true,candidate.title); assert.equal(await fs.readFile(f.file,'utf8'),f.source);
  }
  const records=await audit(f); assert.equal(records.filter(r=>r.phase==='post').length,0); assert.ok(!records.some(r=>['workspace/executeCommand','codeAction/resolve'].includes(r.method))); assert.ok(records.some(r=>r.applyEditResult?.applied===false)); await assert.rejects(fs.readFile(path.join(f.root,'new.py')),{code:'ENOENT'});
});
test('Python controlled MCP reports engine rejection and does not request post-apply diagnostics', async t => {
  const f=await fixture(t,true), shown=value((await mcp(f.root,[message(1,'code_actions_preview',f.args)],f.command))[0]);
  await fs.link(f.file,path.join(f.root,'hardlink.py'));
  const response=(await mcp(f.root,[message(1,'code_action_apply',{...f.args,selection_id:shown.result[0].selection_id})],f.command))[0];
  assert.equal(response.isError,true); const result=JSON.parse(response.content[0].text).result; assert.equal(result.status,'rejected'); assert.equal(result.diagnostics_status,'not_run'); assert.deepEqual(result.diagnostics,[]);
  assert.equal(await fs.readFile(f.file,'utf8'),f.source); assert.equal((await audit(f)).filter(r=>r.method==='initialize').length,2);
});
test('Python applied outcome survives controlled post-apply startup failure and separate disk change', { timeout:30000 }, async t => {
  for(const mode of ['post-error','post-change']){
    const f=await fixture(t,true); await fs.writeFile(path.join(f.root,'apply-mode'),mode);
    const shown=value((await mcp(f.root,[message(1,'code_actions_preview',f.args)],f.command))[0]);
    const result=value((await mcp(f.root,[message(1,'code_action_apply',{...f.args,selection_id:shown.result[0].selection_id})],f.command))[0]).result;
    assert.equal(result.status,'applied'); assert.equal(result.diagnostics_status,'incomplete'); assert.match(result.diagnostics_error,/post-apply startup|differs from applied snapshot/); assert.equal(result.files.length,1); assert.match(await fs.readFile(f.file,'utf8'),/^from utils import square\n/);
    if(mode==='post-change')assert.match(await fs.readFile(f.file,'utf8'),/separate change during post diagnostics/);
  }
});
test('Python applied outcome reports incomplete when fresh post-apply publication times out', { timeout:20000 }, async t => {
  const f=await fixture(t,true); await fs.writeFile(path.join(f.root,'apply-mode'),'post-timeout');
  const shown=value((await mcp(f.root,[message(1,'code_actions_preview',f.args)],f.command))[0]);
  const result=value((await mcp(f.root,[message(1,'code_action_apply',{...f.args,selection_id:shown.result[0].selection_id})],f.command))[0]).result;
  assert.equal(result.status,'applied'); assert.equal(result.diagnostics_status,'incomplete'); assert.equal(result.diagnostics[0].status,'timeout'); assert.match(await fs.readFile(f.file,'utf8'),/^from utils import square\n/);
});
test('Python post-apply diagnostic output is bounded and omissions do not imply a clean result', { timeout:30000 }, async t => {
  for(const mode of ['post-big','post-many']){
    const f=await fixture(t,true); await fs.writeFile(path.join(f.root,'apply-mode'),mode);
    const shown=value((await mcp(f.root,[message(1,'code_actions_preview',f.args)],f.command))[0]);
    const result=value((await mcp(f.root,[message(1,'code_action_apply',{...f.args,selection_id:shown.result[0].selection_id})],f.command))[0]).result;
    assert.equal(result.status,'applied'); assert.equal(result.diagnostics_status,'received'); assert.equal(result.diagnostics_truncated,true); assert.ok(result.diagnostics[0].omitted_diagnostics>0); assert.ok(result.diagnostics[0].diagnostics.length<=30); assert.ok(Buffer.byteLength(JSON.stringify(result))<1024*1024);
  }
});
test('Python controlled MCP rejects a duplicate matching selection rather than choosing one', async t => {
  const f=await fixture(t,true); await fs.writeFile(path.join(f.root,'apply-mode'),'duplicate');
  const shown=value((await mcp(f.root,[message(1,'code_actions_preview',f.args)],f.command))[0]); assert.equal(shown.result.length,2); assert.equal(shown.result[0].selection_id,shown.result[1].selection_id);
  const result=(await mcp(f.root,[message(1,'code_action_apply',{...f.args,selection_id:shown.result[0].selection_id})],f.command))[0]; assert.equal(result.isError,true); assert.equal(await fs.readFile(f.file,'utf8'),f.source);
});
test('Python applied outcome survives an oversized post-apply LSP error message', async t => {
  const f=await fixture(t,true); await fs.writeFile(path.join(f.root,'apply-mode'),'post-big-error');
  const shown=value((await mcp(f.root,[message(1,'code_actions_preview',f.args)],f.command))[0]);
  const result=value((await mcp(f.root,[message(1,'code_action_apply',{...f.args,selection_id:shown.result[0].selection_id})],f.command))[0]).result;
  assert.equal(result.status,'applied'); assert.equal(result.diagnostics_status,'incomplete'); assert.match(result.diagnostics_error,/truncated/); assert.ok(result.diagnostics_error.length<4200); assert.match(await fs.readFile(f.file,'utf8'),/^from utils import square\n/);
});
