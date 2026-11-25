import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveProject } from '../plugins/python-lsp/lib/project.mjs';
import { captureBasis, buildPreview } from '../plugins/python-lsp/lib/preview.mjs';
import { applyPreview } from '../plugins/python-lsp/lib/apply.mjs';
import { pythonText } from '../plugins/python-lsp/lib/source.mjs';
const rootModule=new URL('../plugins/python-lsp/',import.meta.url),entry=fileURLToPath(new URL('server.mjs',rootModule));
async function fixture(t){
 const root=await fs.realpath(await fs.mkdtemp(path.join(tmpdir(),'python-review-safety-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await fs.mkdir(path.join(root,'.venv/bin'),{recursive:true});await fs.writeFile(path.join(root,'.venv/pyvenv.cfg'),'version = 3.15.2\n');await fs.writeFile(path.join(root,'.venv/bin/python'),'fixture');await fs.chmod(path.join(root,'.venv/bin/python'),0o755);await fs.writeFile(path.join(root,'ty.toml'),'[environment]\nroot=["."]\n');
 const file=path.join(root,'main.py'),text='value = 1\n';await fs.writeFile(file,text);const command=path.join(root,'ty');await fs.writeFile(command,'fixture ty');
 const project=await resolveProject(file,root),uri=pathToFileURL(file).href,session={command,serverVersion:'ty 0.0.109 fixture',runtime:{source:'explicit_command',config:null},settings:{},capabilities:{},documents:new Map([[uri,{version:1,text}]])};
 const basis=await captureBasis(project,session,'rename_preview',{workspace_root:root,file,line:1,character:2,new_name:'renamed'},text);
 return{root,file,text,project,uri,session,basis};
}
const range={start:{line:0,character:0},end:{line:0,character:0}};
function child(script,args){return spawnSync(process.execPath,['--input-type=module','-e',script,...args],{encoding:'utf8',timeout:1500,killSignal:'SIGKILL'});}
function fifo(file){const p=spawnSync('mkfifo',[file],{encoding:'utf8'});assert.equal(p.status,0,p.stderr);}
test('Python project config FIFO refuses promptly without a writer and regular config still works',async t=>{
 const f=await fixture(t),script=`import {resolveProject} from ${JSON.stringify(new URL('lib/project.mjs',rootModule).href)};try{await resolveProject('main.py',process.argv[1]);console.log('regular')}catch(e){console.log(e.message)}`;
 assert.match(child(script,[f.root]).stdout,/regular/);await fs.unlink(path.join(f.root,'ty.toml'));fifo(path.join(f.root,'ty.toml'));
 const result=child(script,[f.root]);assert.equal(result.error?.code,undefined,'config FIFO must not time out');assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/regular file/);
});
test('Python preview FIFO refuses promptly without a writer and regular target still previews',async t=>{
 const f=await fixture(t),file=path.join(f.root,'target.py');await fs.writeFile(file,'target = 1\n');
 const script=`import {buildPreview} from ${JSON.stringify(new URL('lib/preview.mjs',rootModule).href)};const p=await buildPreview(JSON.parse(process.argv[1]),{title:'edit',edit:{changes:{[process.argv[2]]:[{range:{start:{line:0,character:0},end:{line:0,character:0}},newText:'# change\\n'}]}}});console.log(JSON.stringify({status:p.status,read:p.edit.files[0].read_status}))`;
 const args=[JSON.stringify(f.basis),pathToFileURL(file).href];assert.match(child(script,args).stdout,/edit_available/);await fs.unlink(file);fifo(file);
 const result=child(script,args);assert.equal(result.error?.code,undefined,'preview FIFO must not time out');assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/unsupported_edit/);
});
test('Python protected case aliases never disclose source text or apply edits',async t=>{
 const f=await fixture(t);await fs.mkdir(path.join(f.root,'.CoDeX'));const file=path.join(f.root,'.CoDeX/secret.py'),bytes=Buffer.from('SECRET_CASE_VARIANT = 1\n');await fs.writeFile(file,bytes);
 assert.equal((await fs.stat(file)).ino,(await fs.stat(path.join(f.root,'.codex/secret.py'))).ino,'fixture volume must exercise case aliases');
 for(const name of ['.CoDeX/secret.py','.codex/secret.py','.CODEX/secret.py']){
  const preview=await buildPreview(f.basis,{title:'edit',edit:{changes:{[pathToFileURL(path.join(f.root,name)).href]:[{range,newText:'# change\n'}]}}});
  assert.equal(preview.edit.files[0].read_status,'protected_path');assert.ok(!JSON.stringify(preview).includes('SECRET_CASE_VARIANT'));assert.equal(preview.edit.files[0].sha256,null);assert.equal((await applyPreview(f.project,f.session,preview)).status,'rejected');assert.deepEqual(await fs.readFile(file),bytes);
  await assert.rejects(resolveProject(path.join(f.root,name),f.root),/Protected/);
 }
});
test('Python UTF-8 source policy follows active first/second-line cookies and BOM spelling',()=>{
 const accepted=['# coding: utf-8\ncafé = 1\n','# coding: UTF_8\ncafé = 1\n','# coding: utf8\ncafé = 1\n','# coding: utf-8-unix\ncafé = 1\n','#!/usr/bin/python\n# coding: utf-8\ncafé = 1\n','\n# coding: utf-8\ncafé = 1\n','# coding: utf-8\n# coding: latin-1\ncafé = 1\n','value = 1\n# coding: ascii\ncafé = 2\n','# header\n# other\n# coding: ascii\ncafé = 1\n','\uFEFF# coding: utf-8\ncafé = 1\n'];
 for(const text of accepted){assert.equal(pythonText(Buffer.from(text)),text.replace(/^\uFEFF/,''));if(process.env.TEST_PYTHON_ENV){const p=spawnSync(path.join(process.env.TEST_PYTHON_ENV,'bin/python'),['-I','-S','-c','import sys; compile(sys.stdin.buffer.read(),"<cookie-test>","exec")'],{input:Buffer.from(text),encoding:'utf8'});assert.equal(p.status,0,p.stderr);}}
 for(const text of ['# coding: ascii\nvalue=1\n','# header\n# coding: latin-1\nvalue=1\n','# coding: bad-codec\nvalue=1\n','\uFEFF# coding: utf8\nvalue=1\n','\uFEFF# coding: latin-1\nvalue=1\n','\uFEFF\uFEFFvalue=1\n'])assert.throws(()=>pythonText(Buffer.from(text)),/encoding|BOM/);
});
test('Python preview and engine independently reject synthesized encoding declarations before any file changes',async t=>{
 const f=await fixture(t),other=path.join(f.root,'other.py');await fs.writeFile(other,'other = 1\n');
 const preview=await buildPreview(f.basis,{title:'bad header',edit:{changes:{[f.uri]:[{range,newText:'# coding: ascii\n'}],[pathToFileURL(other).href]:[{range,newText:'# normal edit\n'}]}}});
 assert.equal(preview.status,'unsupported_edit');assert.ok(preview.issues.includes('unsupported_result_encoding'));
 // Independent engine validation, even if an internal caller incorrectly clears preview issues.
 const result=await applyPreview(f.project,f.session,{...preview,status:'edit_available',issues:[]});assert.equal(result.status,'rejected');assert.match(result.reason,/encoding/);
 assert.equal(await fs.readFile(f.file,'utf8'),f.text);assert.equal(await fs.readFile(other,'utf8'),'other = 1\n');assert.deepEqual((await fs.readdir(f.root)).filter(n=>n.includes('.python-lsp')),[]);
});
test('Python multi-file edits with unsupported target encoding leave every file unchanged',async t=>{
 const f=await fixture(t),other=path.join(f.root,'other.py'),original='# coding: latin-1\nother = 1\n';await fs.writeFile(other,original);
 const preview=await buildPreview(f.basis,{title:'mixed encodings',edit:{changes:{[f.uri]:[{range,newText:'# allowed\n'}],[pathToFileURL(other).href]:[{range,newText:'# refused\n'}]}}});
 assert.equal(preview.status,'unsupported_edit');assert.equal(preview.edit.files.find(file=>file.file===other).read_status,'unsupported_encoding');assert.equal((await applyPreview(f.project,f.session,preview)).status,'rejected');
 assert.equal(await fs.readFile(f.file,'utf8'),f.text);assert.equal(await fs.readFile(other,'utf8'),original);assert.deepEqual((await fs.readdir(f.root)).filter(n=>n.includes('.python-lsp')),[]);
});
async function mcp(root,name,args){const p=spawn(process.execPath,[entry],{cwd:root,env:{...process.env,PYTHON_LSP_TY:process.env.TEST_TY_BIN},stdio:['pipe','pipe','pipe']});let out='',err='';p.stdout.on('data',b=>{out+=b;});p.stderr.on('data',b=>{err+=b;});const timer=setTimeout(()=>p.kill('SIGKILL'),15000);try{p.stdin.end(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})+'\n');const code=await new Promise((resolve,reject)=>{p.on('error',reject);p.on('close',resolve);});assert.equal(code,0,err);return JSON.parse(out.trim()).result;}finally{clearTimeout(timer);p.kill();}}
const real={skip:!(process.env.TEST_TY_BIN&&process.env.TEST_PYTHON_ENV)&&'set explicit ty and test Python',timeout:30000};
function compile(file){return spawnSync(path.join(process.env.TEST_PYTHON_ENV,'bin/python'),['-I','-S','-c','import sys; compile(open(sys.argv[1],"rb").read(),"<review-fixture>","exec")',file],{encoding:'utf8',timeout:3000});}
for(const encoding of ['ascii','latin-1','utf-8','bom-utf8','bom-ascii','unknown','latin-1-unicode-comment'])test(`Python actual ty rename respects source declaration ${encoding}`,real,async t=>{
 const f=await fixture(t);await fs.rm(path.join(f.root,'.venv'),{recursive:true});await fs.symlink(process.env.TEST_PYTHON_ENV,path.join(f.root,'.venv'));
 const cookie=encoding==='bom-utf8'?'utf-8':encoding==='bom-ascii'?'ascii':encoding==='unknown'?'no-such-encoding':encoding==='latin-1-unicode-comment'?'latin-1':encoding;
 const original=Buffer.from((encoding.startsWith('bom-')?'\uFEFF':'')+(encoding==='latin-1-unicode-comment'?'# \u2028coding: ':'# coding: ')+cookie+'\nvalue = 1\nprint(value)\n');await fs.writeFile(f.file,original);
 const before=compile(f.file);assert.equal(before.status,['bom-ascii','unknown'].includes(encoding)?1:0,before.stderr);
 const args={workspace_root:f.root,file:'main.py',line:2,character:2,new_name:'café'};const shown=await mcp(f.root,'rename_preview',args);let applied;
 if(!shown.isError){const preview=JSON.parse(shown.content[0].text);if(preview.result)applied=await mcp(f.root,'rename_apply',{...args,selection_id:preview.result.selection_id});}
 const after=compile(f.file);t.diagnostic(JSON.stringify({encoding,before:before.status,previewError:!!shown.isError,applyError:applied?.isError??null,after:after.status}));
 if(['utf-8','bom-utf8'].includes(encoding)){assert.ok(applied&&!applied.isError,JSON.stringify(applied));assert.equal(after.status,0,after.stderr);assert.match(await fs.readFile(f.file,'utf8'),/café/);}
 else{assert.ok(shown.isError||applied?.isError,'unsupported declaration must not be an applicable preview');assert.deepEqual(await fs.readFile(f.file),original,'source bytes must remain unchanged');assert.equal(after.status,before.status);}
});
