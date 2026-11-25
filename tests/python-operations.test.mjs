import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { resolveProject } from '../plugins/python-lsp/lib/project.mjs';
import { codeActionsPreview } from '../plugins/python-lsp/lib/preview.mjs';
import { applyCodeAction, postApplyDiagnostics } from '../plugins/python-lsp/lib/operations.mjs';

async function fixture(t) {
  const root=await fs.realpath(await fs.mkdtemp(path.join(tmpdir(),'python-operations-'))); t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await fs.mkdir(path.join(root,'.venv/bin'),{recursive:true}); await fs.writeFile(path.join(root,'.venv/pyvenv.cfg'),'version = 3.15.2\n'); await fs.writeFile(path.join(root,'.venv/bin/python'),'fixture'); await fs.chmod(path.join(root,'.venv/bin/python'),0o755); await fs.writeFile(path.join(root,'ty.toml'),'[environment]\nroot=["."]\n');
  const file=path.join(root,'main.py'), other=path.join(root,'other.py'), text='answer = missing(2)\n'; await fs.writeFile(file,text); await fs.writeFile(other,'missing = 1\n');
  const command=path.join(root,'ty'); await fs.writeFile(command,'fixture ty'); const project=await resolveProject(file,root),uri=pathToFileURL(file).href;
  const range={start:{line:0,character:0},end:{line:0,character:0}};
  let closed=0,diagnosed=0;
  const session={command,serverVersion:'ty 0.0.109 fixture',runtime:{source:'explicit_command',config:null},settings:{},capabilities:{codeActionProvider:true},documents:new Map([[uri,{version:1,text}]]),
    close:async()=>{closed++;},diagnostics:async()=>{diagnosed++;return[{file,status:'received',version:1,diagnostics:[{range:{start:{line:0,character:9},end:{line:0,character:16}},message:'missing',code:'unresolved-reference'}]}];},
    request:async()=>[{title:'Controlled two-file quickfix',kind:'quickfix',edit:{changes:{[uri]:[{range,newText:'# main\n'}],[pathToFileURL(other).href]:[{range,newText:'# other\n'}]}}}],
  };
  const args={workspace_root:root,file,range:{start:{line:1,character:10},end:{line:1,character:17}}};
  return{root,file,other,text,project,session,args,closed:()=>closed,diagnosed:()=>diagnosed};
}
test('Python operation rolls back a controlled second-file failure and skips post-apply sessions',async t=>{
  const f=await fixture(t),shown=await codeActionsPreview(f.project,f.session,f.args); let commits=0;
  const io={...fs,rename:async(from,to)=>{if(from.endsWith('.next')&&++commits===2)throw new Error('controlled second-file failure');return fs.rename(from,to);}};
  const output=await applyCodeAction(f.project,f.session,{...f.args,selection_id:shown.result[0].selection_id},{io});
  assert.equal(output.result.status,'rolled_back',JSON.stringify(output)); assert.equal(output.result.diagnostics_status,'not_run'); assert.deepEqual(output.result.diagnostics,[]); assert.equal(f.closed(),0); assert.equal(await fs.readFile(f.file,'utf8'),f.text); assert.equal(await fs.readFile(f.other,'utf8'),'missing = 1\n');
});
test('Python operation rejects an unavailable or malformed selection without invoking the write engine',async t=>{
  const f=await fixture(t);await assert.rejects(applyCodeAction(f.project,f.session,{...f.args,selection_id:'invalid'}),/selection_id/); assert.equal(f.diagnosed(),0);
  await assert.rejects(applyCodeAction(f.project,f.session,{...f.args,selection_id:'sha256:'+'0'.repeat(64)}),/stale|selection/i); assert.equal(f.closed(),0);assert.equal(await fs.readFile(f.file,'utf8'),f.text);
});
test('Python post-apply diagnostics do not run for any non-applied engine status',async()=>{
  for(const status of ['rejected','rolled_back','recovery_incomplete']){
    const session={close:async()=>{assert.fail('must not close/start a post-apply session');}};
    const original={status,files:[{file:'fixture'}],recovery:[{status:'fixture'}]}; const result=await postApplyDiagnostics({},session,original);
    assert.equal(result.status,status);assert.equal(result.diagnostics_status,'not_run');assert.deepEqual(result.recovery,original.recovery);
  }
});
test('Python successful application remains applied even when diagnostic close and kill fail',async()=>{
  const original={status:'applied',files:[{file:'fixture',after_sha256:'sha256:fixture'}],recovery:[]};
  const result=await postApplyDiagnostics({}, {close:async()=>{throw new Error('fixture close failure');},kill:()=>{throw new Error('fixture kill failure');}}, original);
  assert.equal(result.status,'applied');assert.equal(result.diagnostics_status,'incomplete');assert.match(result.diagnostics_error,/close failure/);assert.deepEqual(result.files,original.files);
});
test('Python post-apply diagnostics preserve applied status when a source becomes an external symlink',async t=>{
  const f=await fixture(t),outside=path.join(f.root,'../outside-'+path.basename(f.root)); await fs.writeFile(outside,'OUTSIDE');t.after(()=>fs.rm(outside,{force:true}));
  const session={command:f.session.command,close:async()=>{await fs.unlink(f.file);await fs.symlink(outside,f.file);},kill:()=>{}};
  const result=await postApplyDiagnostics(f.project,session,{status:'applied',files:[{file:f.file,after_sha256:'sha256:fixture'}],recovery:[]});
  assert.equal(result.status,'applied');assert.equal(result.diagnostics_status,'incomplete');assert.match(result.diagnostics_error,/outside/);assert.equal(await fs.readFile(outside,'utf8'),'OUTSIDE');
});
