import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, chmod, symlink, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveProject } from '../plugins/python-lsp/lib/project.mjs';
import { fingerprint, offsetAt, toLspRange, selectDiagnostics, captureBasis, assertBasisCurrent, buildPreview, codeActionsPreview } from '../plugins/python-lsp/lib/preview.mjs';

async function fixture(t) {
  const outer=await realpath(await mkdtemp(path.join(tmpdir(),'python-preview-')));t.after(()=>rm(outer,{recursive:true,force:true}));
  const root=path.join(outer,'workspace');await mkdir(path.join(root,'a/.venv/bin'),{recursive:true});await mkdir(path.join(root,'b'));
  await writeFile(path.join(root,'a/.venv/pyvenv.cfg'),'version = 3.15.2\n');
  const interpreter=path.join(root,'a/.venv/bin/python');await writeFile(interpreter,'fixture Python');await chmod(interpreter,0o755);
  await writeFile(path.join(root,'a/ty.toml'),'[environment]\nroot=["."]\n');
  const file=path.join(root,'a/main.py'),text='value = missing(2)\r\n';await writeFile(file,text);
  const command=path.join(outer,'ty');await writeFile(command,'fixture ty 0.0.109');
  const project=await resolveProject('a/main.py',root,{env:{}}),uri=pathToFileURL(file).href;
  const session={command,serverVersion:'ty 0.0.109 (fixture)',runtime:{source:'explicit_command',config:null},settings:{diagnosticMode:'openFilesOnly',configuration:{environment:{python:project.environment.path}}},capabilities:{codeActionProvider:true},documents:new Map([[uri,{version:1,text}]])};
  const request={workspace_root:root,file,range:{start:{line:1,character:9},end:{line:1,character:16}}};
  const diagnostic={range:{start:{line:0,character:8},end:{line:0,character:15}},severity:1,source:'ty',code:'unresolved-reference',message:'missing'};
  const basis=await captureBasis(project,session,'code_actions_preview',request,text,[diagnostic]);
  const edit={changes:{[uri]:[{range:{start:{line:0,character:0},end:{line:0,character:0}},newText:'from helpers import missing\n'}]}};
  return{outer,root,file,text,project,session,uri,request,diagnostic,basis,edit,command};
}
test('Python preview ranges enforce UTF-16/CRLF, order, exact fields and half-open diagnostic intersection',()=>{
  const text='😀word\r\nnext\n';
  assert.equal(offsetAt(text,{line:1,character:0}),8);
  assert.deepEqual(toLspRange({start:{line:1,character:3},end:{line:1,character:7}},text),{start:{line:0,character:2},end:{line:0,character:6}});
  for(const range of [{start:{line:1,character:2},end:{line:1,character:3}},{start:{line:2,character:2},end:{line:1,character:3}},{start:{line:1,character:1},end:{line:1,character:8}},{start:{line:1,character:1},end:{line:1,character:1},extra:true}])assert.throws(()=>toLspRange(range,text));
  const diagnostics=[{range:{start:{line:0,character:2},end:{line:0,character:6}},code:'span'},{range:{start:{line:0,character:6},end:{line:0,character:6}},code:'point'}];
  assert.deepEqual(selectDiagnostics(text,{start:{line:0,character:2},end:{line:0,character:6}},diagnostics).map(d=>d.code),['span']);
  assert.deepEqual(selectDiagnostics(text,{start:{line:0,character:6},end:{line:0,character:6}},diagnostics).map(d=>d.code),['point']);
});
test('Python preview selection binds canonical basis, source/config/environment/server and exact candidate',async t=>{
  const f=await fixture(t),action={title:'Add import',kind:'quickfix',edit:f.edit};
  const first=await buildPreview(f.basis,action);const second=await buildPreview(f.basis,{edit:f.edit,kind:'quickfix',title:'Add import'});
  assert.equal(first.selection_id,second.selection_id);assert.match(first.selection_id,/^sha256:[a-f0-9]{64}$/);
  assert.equal(first.category,'import');assert.equal(first.status,'edit_available');assert.equal(first.edit.files[0].edits[0].old_text,'');
  const current=()=>captureBasis(f.project,f.session,'code_actions_preview',f.request,f.text,[f.diagnostic]);
  assert.equal(first.selection_id,(await buildPreview(await current(),action)).selection_id);
  assert.notEqual(first.selection_id,(await buildPreview({...f.basis,request:{...f.request,range:{start:{line:1,character:9},end:{line:1,character:9}}}},action)).selection_id);
  assert.notEqual(first.selection_id,(await buildPreview(f.basis,{...action,edit:{changes:{[f.uri]:[{range:{start:{line:0,character:0},end:{line:0,character:0}},newText:'import other\n'}]}}})).selection_id);
  await writeFile(f.project.config,'[environment]\nroot=["."]\n# changed\n');await assert.rejects(assertBasisCurrent(first.basis,f.session),/changed/);
  const config=await current();assert.notEqual(first.selection_id,(await buildPreview(config,action)).selection_id);
  await writeFile(path.join(f.project.environment.path,'pyvenv.cfg'),'version = 3.15.1\n');
  const environment=await current();assert.notEqual(fingerprint(config),fingerprint(environment));
  await writeFile(f.command,'changed ty binary');assert.notEqual(fingerprint(environment),fingerprint(await current()));
  await writeFile(f.file,'value = changed(2)\r\n');await assert.rejects(current(),/anchor changed/i);
});
test('Python preview states keep disabled, commands and deferred candidates separate from text edits',async t=>{
  const f=await fixture(t),action={title:'Edit',kind:'quickfix',edit:f.edit};
  assert.equal((await buildPreview(f.basis,{...action,disabled:{reason:'not available'}})).status,'disabled');
  const commanded=await buildPreview(f.basis,{...action,command:{command:'unsafe.command',arguments:[1]}});
  assert.equal(commanded.status,'requires_command');assert.equal(commanded.command.name,'unsafe.command');
  assert.notEqual(commanded.selection_id,(await buildPreview(f.basis,{...action,command:{command:'unsafe.command',arguments:[2]}})).selection_id);
  assert.equal((await buildPreview(f.basis,{title:'Command only',command:'unsafe.command',arguments:[2]})).status,'requires_command');
  const deferred=await buildPreview(f.basis,{...action,data:{key:1}});assert.equal(deferred.status,'requires_resolve');assert.equal(deferred.needs_resolve,true);
  assert.notEqual(deferred.selection_id,(await buildPreview(f.basis,{...action,data:{key:2}})).selection_id);
  assert.equal((await buildPreview(f.basis,{title:'No edit'})).status,'unavailable');
  const suppression=await buildPreview(f.basis,{title:'Ignore',kind:'quickfix',edit:{changes:{[f.uri]:[{range:{start:{line:0,character:18},end:{line:0,character:18}},newText:' # ty: ignore[unresolved-reference]'}]}}});
  assert.equal(suppression.category,'suppression');assert.equal(suppression.preview_only,true);
});
test('Python preview displays URI/project/resource boundaries without reading external or protected source',async t=>{
  const f=await fixture(t),outside=path.join(f.outer,'outside.py');await writeFile(outside,'SECRET EXTERNAL');
  await symlink(outside,path.join(f.root,'a/escape.py'));await writeFile(path.join(f.root,'b/other.py'),'other = 1\n');await writeFile(path.join(f.root,'a/.env.py'),'SECRET PROTECTED');
  await mkdir(path.join(f.project.environment.path,'lib'));await writeFile(path.join(f.project.environment.path,'lib/library.py'),'SECRET ENVIRONMENT');
  const range={start:{line:0,character:0},end:{line:0,character:0}};
  const uris=[f.file,path.join(f.root,'b/other.py'),path.join(f.root,'a/escape.py'),path.join(f.root,'a/.env.py'),path.join(f.project.environment.path,'lib/library.py')].map(p=>pathToFileURL(p).href);
  const action={title:'Mixed',edit:{documentChanges:[...uris.map(uri=>({textDocument:{uri,version:1},edits:[{range,newText:'insert'}]})),{kind:'create',uri:pathToFileURL(path.join(f.root,'a/new.py')).href},{kind:'rename',oldUri:f.uri,newUri:pathToFileURL(path.join(f.root,'b/moved.py')).href},{kind:'delete',uri:pathToFileURL(outside).href}]}};
  const preview=await buildPreview(f.basis,action);assert.equal(preview.status,'unsupported_edit');
  assert.equal(preview.edit.files[0].workspace_boundary,'inside');assert.equal(preview.edit.files[1].project_boundary,'outside');
  for(const file of preview.edit.files.slice(2)){assert.equal(file.sha256,null);assert.equal(file.edits[0].old_text,null);}
  assert.deepEqual(preview.edit.resource_operations.map(o=>o.kind),['create','rename','delete']);
  assert.ok(!JSON.stringify(preview).includes('SECRET'));assert.equal(await readFile(outside,'utf8'),'SECRET EXTERNAL');
});
test('Python preview rejects overlapping/invalid edits and rechecks target snapshots',async t=>{
  const f=await fixture(t),range={start:{line:0,character:0},end:{line:0,character:5}};
  const overlap=await buildPreview(f.basis,{title:'Overlap',edit:{changes:{[f.uri]:[{range,newText:'one'},{range,newText:'two'}]}}});
  assert.equal(overlap.status,'unsupported_edit');assert.ok(overlap.issues.includes('overlapping_text_edits'));
  const invalid=await buildPreview(f.basis,{title:'Invalid',edit:{changes:{[f.uri]:[{range:{start:{line:10,character:0},end:{line:10,character:1}},newText:'bad'}]}}});
  assert.equal(invalid.status,'unsupported_edit');
  const insertion={range:{start:{line:0,character:0},end:{line:0,character:0}},newText:'x'};
  const duplicate=await buildPreview(f.basis,{title:'Duplicate insertion',edit:{changes:{[f.uri]:[insertion,insertion]}}});assert.ok(duplicate.issues.includes('overlapping_text_edits'));
  const annotated=await buildPreview(f.basis,{title:'Annotated',edit:{changes:{[f.uri]:[{...insertion,annotationId:'a'}]},changeAnnotations:{a:{label:'review',needsConfirmation:true}}}});assert.equal(annotated.status,'unsupported_edit');assert.ok(annotated.issues.includes('change_annotations_require_policy'));
  const target=path.join(f.root,'a/other.py');await writeFile(target,'old = 1\n');
  const action={title:'Other',edit:{changes:{[pathToFileURL(target).href]:[{range,newText:'new'}]}}};
  const first=await buildPreview(f.basis,action);await writeFile(target,'old = 2\n');
  const second=await buildPreview(f.basis,action);assert.notEqual(first.selection_id,second.selection_id);
  await assert.rejects(assertBasisCurrent(first.basis,f.session),/target changed/i);
});
test('Python preview binds environment selection and rejects metadata/target drift and unsafe edit forms',async t=>{
  const f=await fixture(t),action={title:'Edit',edit:f.edit};
  const env=path.join(f.outer,'other-env');await mkdir(path.join(env,'bin'),{recursive:true});await writeFile(path.join(env,'pyvenv.cfg'),'version = 3.15.2\n');await writeFile(path.join(env,'bin/python'),'other Python');await chmod(path.join(env,'bin/python'),0o755);
  const alternate={...f.project,environment:{...f.project.environment,path:env,interpreter:path.join(env,'bin/python')}};
  const changed=await captureBasis(alternate,f.session,'code_actions_preview',f.request,f.text,[f.diagnostic]);
  assert.notEqual((await buildPreview(f.basis,action)).selection_id,(await buildPreview(changed,action)).selection_id);
  const mixed=await buildPreview(f.basis,{title:'Mixed forms',edit:{...f.edit,documentChanges:[]}});assert.equal(mixed.status,'unsupported_edit');assert.ok(mixed.issues.includes('mixed_edit_forms'));
  const version=await buildPreview(f.basis,{title:'Wrong version',edit:{documentChanges:[{textDocument:{uri:f.uri,version:9},edits:[{range:{start:{line:0,character:0},end:{line:0,character:0}},newText:'x'}]}]}});assert.ok(version.issues.includes('unverified_document_version'));
  const data=await buildPreview(f.basis,{title:'External URI',edit:{changes:{'https://example.org/library.py':[{range:{start:{line:0,character:0},end:{line:0,character:0}},newText:'x'}]}}});assert.equal(data.status,'unsupported_edit');assert.equal(data.edit.files[0].sha256,null);
  const runtimeFile=path.join(f.outer,'runtime.json');await writeFile(runtimeFile,'{"ty_path":"one"}');f.session.runtime={source:'user_config',config:runtimeFile};
  const runtimeBasis=await captureBasis(f.project,f.session,'code_actions_preview',f.request,f.text,[f.diagnostic]);await writeFile(runtimeFile,'{"ty_path":"two"}');await assert.rejects(assertBasisCurrent(runtimeBasis,f.session),/changed/);
});
test('Python quickfix preview forwards only fresh intersecting diagnostics and never resolves or executes',async t=>{
  const f=await fixture(t),seen=[];
  f.session.diagnostics=async()=>[{file:f.file,status:'received',version:1,diagnostics:[f.diagnostic]}];
  f.session.request=async(method,params)=>{seen.push({method,params});return [{title:'Deferred',kind:'quickfix',data:{id:1},edit:f.edit}];};
  const output=await codeActionsPreview(f.project,f.session,f.request);
  assert.equal(output.diagnostics_status,'received');assert.equal(output.result[0].status,'requires_resolve');
  assert.deepEqual(seen.map(r=>r.method),['textDocument/codeAction']);assert.deepEqual(seen[0].params.context.diagnostics,[f.diagnostic]);assert.deepEqual(seen[0].params.context.only,['quickfix']);
  f.session.diagnostics=async()=>[{status:'timeout',diagnostics:[]}];await assert.rejects(codeActionsPreview(f.project,f.session,f.request),/incomplete|timed out/);
  f.session.capabilities.codeActionProvider=false;await assert.rejects(codeActionsPreview(f.project,f.session,f.request),/codeAction/);
  assert.equal(await readFile(f.file,'utf8'),f.text);
});
test('Python quickfix preview rejects request errors and files changed while the server computes candidates',async t=>{
  const f=await fixture(t);
  f.session.diagnostics=async()=>[{status:'received',version:1,diagnostics:[f.diagnostic]}];
  f.session.request=async()=>{throw new Error('LSP fixture failure');};await assert.rejects(codeActionsPreview(f.project,f.session,f.request),/LSP fixture failure/);
  f.session.request=async()=>({invalid:true});await assert.rejects(codeActionsPreview(f.project,f.session,f.request),/Invalid codeAction/);
  f.session.request=async()=>{await writeFile(f.file,'value = changed(2)\r\n');return [{title:'Changed',edit:f.edit}];};
  await assert.rejects(codeActionsPreview(f.project,f.session,f.request),/changed/i);
});
test('Python preview bounds derived old/new text before constructing oversized responses',async t=>{
  const f=await fixture(t),changes={};
  for(const name of ['large-a.py','large-b.py']){const file=path.join(f.root,'a',name);await writeFile(file,'x'.repeat(600000));changes[pathToFileURL(file).href]=[{range:{start:{line:0,character:0},end:{line:0,character:600000}},newText:''}];}
  await assert.rejects(buildPreview(f.basis,{title:'Large deletion',edit:{changes}}),/Preview text limit/);
});
