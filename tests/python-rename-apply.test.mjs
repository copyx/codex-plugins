import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const plugin = fileURLToPath(new URL('../plugins/python-lsp/', import.meta.url));
const message = (id, name, args) => ({ jsonrpc:'2.0',id,method:'tools/call',params:{name,arguments:args} });
async function mcp(root, requests, command = process.env.TEST_TY_BIN) {
  const child = spawn(process.execPath,[path.join(plugin,'server.mjs')],{cwd:root,env:{...process.env,PYTHON_LSP_TY:command??''},stdio:['pipe','pipe','pipe']});
  let stdout='',stderr=''; child.stdout.on('data',b=>{stdout+=b;}); child.stderr.on('data',b=>{stderr+=b;}); const timer=setTimeout(()=>child.kill('SIGKILL'),24000);
  try { child.stdin.end(requests.map(JSON.stringify).join('\n')+'\n'); const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});assert.equal(code,0,stderr);return stdout.trim().split('\n').map(JSON.parse).map(r=>r.result); }
  finally {clearTimeout(timer);child.kill();}
}
const value = result => {assert.ok(!result.isError,result.content?.[0]?.text);return JSON.parse(result.content[0].text);};
test('Python MCP advertises rename_apply as the second strict write tool and preserves nine read tools',async()=>{
  const [listed]=await mcp(tmpdir(),[{jsonrpc:'2.0',id:1,method:'tools/list'}]);
  const tool=listed.tools.find(t=>t.name==='rename_apply');assert.ok(tool,'selected rename application must be advertised');
  assert.equal(listed.tools.length,11);assert.equal(listed.tools.filter(t=>t.annotations.readOnlyHint).length,9);
  assert.equal(tool.annotations.readOnlyHint,false);assert.equal(tool.annotations.destructiveHint,true);assert.equal(tool.annotations.idempotentHint,false);
  assert.deepEqual(tool.inputSchema.required,['workspace_root','file','line','character','new_name','selection_id']);assert.equal(tool.inputSchema.additionalProperties,false);
  assert.deepEqual(Object.keys(tool.inputSchema.properties),['workspace_root','file','line','character','new_name','selection_id']);
});
async function fixture(t, controlled=false) {
  const outer=await fs.realpath(await fs.mkdtemp(path.join(tmpdir(),'python-rename-apply-')));t.after(()=>fs.rm(outer,{recursive:true,force:true}));
  const root=path.join(outer,'workspace');await fs.mkdir(path.join(root,'src'),{recursive:true});
  if(process.env.TEST_PYTHON_ENV)await fs.symlink(process.env.TEST_PYTHON_ENV,path.join(root,'.venv'));
  else{await fs.mkdir(path.join(root,'.venv/bin'),{recursive:true});await fs.writeFile(path.join(root,'.venv/pyvenv.cfg'),'version = 3.15.2\n');await fs.writeFile(path.join(root,'.venv/bin/python'),'fixture');await fs.chmod(path.join(root,'.venv/bin/python'),0o755);}
  await fs.writeFile(path.join(root,'ty.toml'),'[environment]\nroot=["src"]\n');
  const line='emoji = "😀"; item = Greeter()';
  const originals={'src/model.py':'class Greeter:\r\n    pass\r\n','use.py':'from model import Greeter\r\n'+line+'\r\n# no symbol\r\n','unrelated.py':'def local():\n    class Greeter:\n        pass\n    return Greeter()\n','untouched.py':'other = 42\n'};
  for(const[name,text]of Object.entries(originals))await fs.writeFile(path.join(root,name),text);
  const args={workspace_root:root,file:'use.py',line:2,character:line.indexOf('Greeter')+2,new_name:'RenamedGreeter'};
  let command;
  if(controlled){command=path.join(root,'fixture-rename.mjs');await fs.copyFile(new URL('./fixtures/python-rename-lsp.mjs',import.meta.url),command);await fs.chmod(command,0o755);await fs.writeFile(path.join(root,'rename-source.py'),'old = 1\n');await fs.writeFile(path.join(root,'rename-mode'),'normal');Object.assign(args,{file:'rename-source.py',line:1,character:2,new_name:'renamed'});}
  return{outer,root,args,originals,command};
}
async function unchanged(f){for(const[name,text]of Object.entries(f.originals))assert.deepEqual(await fs.readFile(path.join(f.root,name)),Buffer.from(text));}
const real={skip:!(process.env.TEST_TY_BIN&&process.env.TEST_PYTHON_ENV)&&'set TEST_TY_BIN and TEST_PYTHON_ENV',timeout:30000};
test('Python actual ty selected rename updates declarations imports references and returns fresh diagnostics without touching unrelated symbols',real,async t=>{
  const f=await fixture(t),shown=value((await mcp(f.root,[message(1,'rename_preview',f.args)]))[0]);assert.equal(shown.result.status,'edit_available');assert.equal(shown.result.edit.files.length,2);await unchanged(f);
  const args={...f.args,file:path.join(f.root,'use.py'),selection_id:shown.result.selection_id};
  const result=value((await mcp(f.root,[message(1,'rename_apply',args)]))[0]).result;assert.equal(result.status,'applied');assert.equal(result.selection_id,shown.result.selection_id);assert.equal(result.files.length,2);assert.equal(result.diagnostics_status,'received');assert.equal(result.diagnostics.length,2);assert.ok(result.diagnostics.every(d=>d.status==='received'&&d.diagnostics.length===0&&d.omitted_diagnostics===0));
  assert.deepEqual(await fs.readFile(path.join(f.root,'src/model.py')),Buffer.from('class RenamedGreeter:\r\n    pass\r\n'));
  assert.deepEqual(await fs.readFile(path.join(f.root,'use.py')),Buffer.from('from model import RenamedGreeter\r\nemoji = "😀"; item = RenamedGreeter()\r\n# no symbol\r\n'));
  for(const name of ['unrelated.py','untouched.py'])assert.deepEqual(await fs.readFile(path.join(f.root,name)),Buffer.from(f.originals[name]));
  const repeated=(await mcp(f.root,[message(1,'rename_apply',args)]))[0];assert.equal(repeated.isError,true);assert.match(repeated.content[0].text,/preview|stale|no_changes/i);assert.deepEqual(await fs.readFile(path.join(f.root,'src/model.py')),Buffer.from('class RenamedGreeter:\r\n    pass\r\n'));
});
test('Python rename write rejects forged input changed name position range and non-renamable selections without writes',real,async t=>{
  const f=await fixture(t),shown=value((await mcp(f.root,[message(1,'rename_preview',f.args)]))[0]),args={...f.args,selection_id:shown.result.selection_id};
  const outside=path.join(f.outer,'outside.py');await fs.writeFile(outside,'outside = 1\n');await fs.symlink(outside,path.join(f.root,'escape.py'));
  const inputs=['edit','basis','command','range','selection_ids'].map(key=>({...args,[key]:{}}));
  inputs.push({...f.args},{...args,selection_id:'invalid'},{...args,selection_id:'sha256:'+'0'.repeat(64)},{...args,new_name:'OtherGreeter'},{...args,new_name:'class'},{...args,new_name:'e\u0301'},{...args,new_name:'Greeter'},{...args,line:3,character:1},{...args,character:11},{...args,line:999},{...args,file:'../outside.py'},{...args,file:'escape.py'});
  const results=await mcp(f.root,inputs.map((a,i)=>message(i+1,'rename_apply',a)));assert.ok(results.every(r=>r.isError),JSON.stringify(results));await unchanged(f);assert.equal(await fs.readFile(outside,'utf8'),'outside = 1\n');
});
test('Python rename rejects a selection when a non-anchor target changes after preview',real,async t=>{
  const f=await fixture(t),shown=value((await mcp(f.root,[message(1,'rename_preview',f.args)]))[0]);
  const file=path.join(f.root,'src/model.py'),changed=f.originals['src/model.py']+'# separate target edit\n';await fs.writeFile(file,changed);
  const result=(await mcp(f.root,[message(1,'rename_apply',{...f.args,selection_id:shown.result.selection_id})]))[0];assert.equal(result.isError,true);assert.match(result.content[0].text,/stale|selection/i);assert.equal(await fs.readFile(file,'utf8'),changed);assert.equal(await fs.readFile(path.join(f.root,'use.py'),'utf8'),f.originals['use.py']);
});
const events=async f=>(await fs.readFile(path.join(f.root,'rename-events.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
test('Python controlled rename documentChanges applies and returns separate fresh diagnostics',async t=>{
  const f=await fixture(t,true);await fs.writeFile(path.join(f.root,'rename-mode'),'document');
  const shown=value((await mcp(f.root,[message(1,'rename_preview',f.args)],f.command))[0]);assert.equal(shown.result.edit.files[0].source,'documentChanges');assert.equal(await fs.readFile(path.join(f.root,'rename-source.py'),'utf8'),'old = 1\n');
  const result=value((await mcp(f.root,[message(1,'rename_apply',{...f.args,selection_id:shown.result.selection_id})],f.command))[0]).result;
  assert.equal(result.status,'applied');assert.equal(result.diagnostics_status,'received');assert.equal(await fs.readFile(path.join(f.root,'rename-source.py'),'utf8'),'renamed = 1\n');
  const log=await events(f);assert.ok(log.some(e=>e.phase==='post'&&e.method==='textDocument/didOpen'));assert.ok(!log.some(e=>['workspace/executeCommand','codeAction/resolve'].includes(e.method)));assert.ok(log.some(e=>e.applyEditResult?.applied===false));
});
test('Python controlled rename refuses external resource and annotated previews without writing',async t=>{
  const f=await fixture(t,true);
  for(const mode of ['external','resource','annotation']){
    await fs.writeFile(path.join(f.root,'rename-mode'),mode);const shown=value((await mcp(f.root,[message(1,'rename_preview',f.args)],f.command))[0]);assert.equal(shown.result.status,'unsupported_edit');
    const result=(await mcp(f.root,[message(1,'rename_apply',{...f.args,selection_id:shown.result.selection_id})],f.command))[0];assert.equal(result.isError,true);assert.equal(await fs.readFile(path.join(f.root,'rename-source.py'),'utf8'),'old = 1\n');
  }
  await assert.rejects(fs.readFile(path.join(f.root,'renamed.py')),{code:'ENOENT'});assert.ok(!(await events(f)).some(e=>e.phase==='post'));await unchanged(f);
});
test('Python controlled rename refuses unavailable errors malformed responses and changed prepare capability',async t=>{
  const f=await fixture(t,true),shown=value((await mcp(f.root,[message(1,'rename_preview',f.args)],f.command))[0]);
  for(const mode of ['unsupported','no-symbol','prepare-error','bad-prepare','error','invalid-result','command','null-edit','empty-edit','no-prepare','default']){
    await fs.writeFile(path.join(f.root,'rename-mode'),mode);
    const result=(await mcp(f.root,[message(1,'rename_apply',{...f.args,selection_id:shown.result.selection_id})],f.command))[0];assert.equal(result.isError,true,mode);assert.equal(await fs.readFile(path.join(f.root,'rename-source.py'),'utf8'),'old = 1\n');
  }
  assert.ok(!(await events(f)).some(e=>['workspace/executeCommand','codeAction/resolve'].includes(e.method)));
});
test('Python controlled rename preserves engine rejection and does not start post-apply diagnostics',async t=>{
  const f=await fixture(t,true),shown=value((await mcp(f.root,[message(1,'rename_preview',f.args)],f.command))[0]);await fs.link(path.join(f.root,'rename-source.py'),path.join(f.root,'hardlink.py'));
  const response=(await mcp(f.root,[message(1,'rename_apply',{...f.args,selection_id:shown.result.selection_id})],f.command))[0];assert.equal(response.isError,true);
  const result=JSON.parse(response.content[0].text).result;assert.equal(result.status,'rejected');assert.equal(result.diagnostics_status,'not_run');assert.equal(await fs.readFile(path.join(f.root,'rename-source.py'),'utf8'),'old = 1\n');assert.equal((await events(f)).filter(e=>e.method==='initialize').length,2);
});
test('Python controlled rename preserves applied outcome on post-apply server failure or separate edit',async t=>{
  for(const mode of ['post-error','post-change']){
    const f=await fixture(t,true);await fs.writeFile(path.join(f.root,'rename-mode'),mode);const shown=value((await mcp(f.root,[message(1,'rename_preview',f.args)],f.command))[0]);
    const result=value((await mcp(f.root,[message(1,'rename_apply',{...f.args,selection_id:shown.result.selection_id})],f.command))[0]).result;
    assert.equal(result.status,'applied');assert.equal(result.diagnostics_status,'incomplete');assert.match(result.diagnostics_error,/post-apply startup|differs from applied snapshot/);assert.match(await fs.readFile(path.join(f.root,'rename-source.py'),'utf8'),/^renamed = 1\n/);
    if(mode==='post-change')assert.match(await fs.readFile(path.join(f.root,'rename-source.py'),'utf8'),/separate edit during diagnostics/);
  }
});
