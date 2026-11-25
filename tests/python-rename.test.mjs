import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, chmod, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { resolveProject } from '../plugins/python-lsp/lib/project.mjs';
import { offsetAt } from '../plugins/python-lsp/lib/preview.mjs';
import { validatePythonName, namePolicy, renamePreview } from '../plugins/python-lsp/lib/rename.mjs';

async function fixture(t) {
  const outer=await realpath(await mkdtemp(path.join(tmpdir(),'python-rename-')));t.after(()=>rm(outer,{recursive:true,force:true}));
  const root=path.join(outer,'workspace');await mkdir(path.join(root,'a/.venv/bin'),{recursive:true});await mkdir(path.join(root,'b'));
  await writeFile(path.join(root,'a/.venv/pyvenv.cfg'),'version = 3.15.2\n');
  const python=path.join(root,'a/.venv/bin/python');await writeFile(python,'fixture interpreter');await chmod(python,0o755);
  await writeFile(path.join(root,'a/ty.toml'),'[environment]\nroot=["."]\n');
  const file=path.join(root,'a/main.py'),text='target = 1\r\n';await writeFile(file,text);
  const command=path.join(outer,'ty');await writeFile(command,'fixture ty 0.0.109');
  const project=await resolveProject('a/main.py',root,{env:{}}),uri=pathToFileURL(file).href,range={start:{line:0,character:0},end:{line:0,character:6}},seen=[];
  const session={command,serverVersion:'ty 0.0.109 fixture',runtime:{source:'explicit_command',config:null},settings:{configuration:{environment:{python:project.environment.path}}},capabilities:{renameProvider:{prepareProvider:true}},documents:new Map([[uri,{version:1,text}]]),
    sync:async()=>uri,position:(_uri,line,character)=>{const p={line:line-1,character:character-1};offsetAt(text,p);return p;},
    request:async(method,params)=>{seen.push(method);return method==='textDocument/prepareRename'?{range,placeholder:'target'}:{changes:{[uri]:[{range,newText:params.newName}]}};},
  };
  const args={workspace_root:root,file,line:1,character:2,new_name:'renamed'};
  return{outer,root,file,text,project,uri,range,seen,session,args};
}
test('Python rename names enforce NFKC-stable Unicode XID and conservative reserved-name policy',()=>{
  for(const value of ['Renamed','_value','이름','café','δοκιμή','𐐀Name'])assert.equal(validatePythonName(value),value);
  for(const value of ['',null,12,'class','await','False','match','case','type','lazy','_','__debug__','1name','two words','a.b','x-y','x\0','a\n','😀','e\u0301','K','a\u200db','a\u200cb','a\ufe0fb','x'.repeat(257)])assert.throws(()=>validatePythonName(value),/new_name|identifier|NFKC|reserved/,JSON.stringify(value));
  assert.equal(namePolicy.unicode_version,process.versions.unicode);assert.equal(namePolicy.normalization,'require_NFKC_stable');
});
test('Python rename preview binds prepared symbol, name, capability and snapshots without writes',async t=>{
  const f=await fixture(t),first=await renamePreview(f.project,f.session,f.args),second=await renamePreview(f.project,f.session,{...f.args});
  assert.equal(first.status,'preview_available');assert.equal(first.result.status,'edit_available');assert.equal(first.result.preview_only,true);
  assert.equal(first.result.selection_id,second.result.selection_id);assert.equal(first.result.basis.request.new_name,'renamed');
  assert.deepEqual(first.result.basis.operation_context.rename_capability,{prepareProvider:true});assert.equal(first.prepare.old_name,'target');
  assert.notEqual(first.result.selection_id,(await renamePreview(f.project,f.session,{...f.args,new_name:'other'})).result.selection_id);
  assert.equal(first.result.edit.files[0].edits[0].old_text,'target');assert.equal(await readFile(f.file,'utf8'),f.text);
  assert.deepEqual(f.seen.slice(0,2),['textDocument/prepareRename','textDocument/rename']);
});
test('Python rename preview separates no symbol, no edits, unsupported and malformed/error responses',async t=>{
  const f=await fixture(t);
  f.session.request=async method=>{f.seen.push(method);return null;};
  assert.equal((await renamePreview(f.project,f.session,f.args)).status,'not_renamable');assert.ok(!f.seen.includes('textDocument/rename'));
  f.session.capabilities.renameProvider=true;f.seen.length=0;
  assert.equal((await renamePreview(f.project,f.session,f.args)).status,'no_changes');assert.deepEqual(f.seen,['textDocument/rename']);
  f.session.capabilities.renameProvider=false;await assert.rejects(renamePreview(f.project,f.session,f.args),/rename/);
  f.session.capabilities.renameProvider={prepareProvider:true};f.session.request=async()=>({unexpected:true});await assert.rejects(renamePreview(f.project,f.session,f.args),/prepareRename/);
  f.session.request=async()=>({start:{line:20,character:0},end:{line:20,character:1}});await assert.rejects(renamePreview(f.project,f.session,f.args),/prepareRename|outside/);
  f.session.request=async()=>{throw new Error('prepare fixture failure');};await assert.rejects(renamePreview(f.project,f.session,f.args),/prepare.*failure/);
  f.session.capabilities.renameProvider=true;
  for(const result of [[],42,{command:'unsafe.command',changes:{}},{documentChanges:false},{changes:{[f.uri]:'invalid'}}]){f.session.request=async()=>result;await assert.rejects(renamePreview(f.project,f.session,f.args),/rename|WorkspaceEdit/);}
});
test('Python rename preview supports prepared Range, placeholder and default identifier forms',async t=>{
  const f=await fixture(t),edit={changes:{[f.uri]:[{range:f.range,newText:'renamed'}]}};
  for(const prepare of [f.range,{range:f.range,placeholder:'target'},{defaultBehavior:true},{defaultBehavior:false}]){
    f.session.request=async method=>method==='textDocument/prepareRename'?prepare:edit;
    assert.equal((await renamePreview(f.project,f.session,f.args)).status,'preview_available');
  }
  f.session.request=async method=>method==='textDocument/prepareRename'?f.range:{changes:{[f.uri]:[{range:f.range,newText:'target'}]}};
  assert.equal((await renamePreview(f.project,f.session,{...f.args,new_name:'target'})).status,'no_changes');
});
test('Python rename preview displays documentChanges, external/resource constraints and detects concurrent edits',async t=>{
  const f=await fixture(t),edit={documentChanges:[{textDocument:{uri:f.uri,version:1},edits:[{range:f.range,newText:'renamed'}]}]};
  f.session.request=async method=>method==='textDocument/prepareRename'?f.range:edit;
  assert.equal((await renamePreview(f.project,f.session,f.args)).result.status,'edit_available');
  f.session.request=async method=>method==='textDocument/prepareRename'?f.range:{changes:{'file:///outside/secret.py':[{range:f.range,newText:'renamed'}]}};
  const outside=await renamePreview(f.project,f.session,f.args);assert.equal(outside.result.status,'unsupported_edit');assert.equal(outside.result.edit.files[0].sha256,null);
  f.session.request=async method=>method==='textDocument/prepareRename'?f.range:{documentChanges:[{kind:'rename',oldUri:f.uri,newUri:pathToFileURL(path.join(f.root,'a/new.py')).href}]};
  const resource=await renamePreview(f.project,f.session,f.args);assert.equal(resource.result.status,'unsupported_edit');assert.equal(resource.result.edit.resource_operations[0].kind,'rename');
  await assert.rejects(readFile(path.join(f.root,'a/new.py')),{code:'ENOENT'});
  f.session.request=async method=>{if(method==='textDocument/prepareRename')return f.range;await writeFile(f.file,'target = 2\r\n');return edit;};
  await assert.rejects(renamePreview(f.project,f.session,f.args),/changed/);
});
test('Python rename invalid new_name fails before protocol requests',async t=>{
  const f=await fixture(t);await assert.rejects(renamePreview(f.project,f.session,{...f.args,new_name:'class'}),/reserved/);assert.deepEqual(f.seen,[]);
});
test('Node rename policy accepted sample names compile in the explicit isolated test Python',{skip:!process.env.TEST_PYTHON_ENV&&'set TEST_PYTHON_ENV'},()=>{
  const names=['Renamed','_value','이름','café','δοκιμή','𐐀Name'];
  const script='import json,keyword,sys,unicodedata\nnames=json.loads(sys.argv[1])\nfor n in names:\n assert n.isidentifier() and not keyword.iskeyword(n)\n compile(n+" = 1", "<rename-policy-test>", "exec")\nprint(json.dumps({"python":sys.version.split()[0],"unicode":unicodedata.unidata_version,"keywords":keyword.kwlist,"soft_keywords":keyword.softkwlist}))';
  const result=spawnSync(path.join(process.env.TEST_PYTHON_ENV,'bin/python'),['-I','-S','-c',script,JSON.stringify(names)],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);const info=JSON.parse(result.stdout);assert.ok(info.unicode);
  for(const keyword of [...info.keywords,...info.soft_keywords])assert.throws(()=>validatePythonName(keyword),/reserved/);
});
