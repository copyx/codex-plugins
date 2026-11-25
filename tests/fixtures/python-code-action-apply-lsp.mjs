#!/usr/bin/env node
// Protocol fixture. post-change alone injects a separate fixture source edit.
import { readFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
if (process.argv.includes('--version')) { console.log('ty 0.0.109'); process.exit(0); }
const mode = readFileSync(path.join(process.cwd(), 'apply-mode'), 'utf8');
const source = path.join(process.cwd(), 'main.py'), after = readFileSync(source, 'utf8').includes('from utils import square');
const log = event => appendFileSync(path.join(process.cwd(), 'apply-audit.jsonl'), JSON.stringify({ pid: process.pid, phase: after ? 'post' : 'pre', ...event })+'\n');
let buffer = Buffer.alloc(0), uri;
const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
function send(message) { const body = JSON.stringify(message); process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`); }
function handle(message) {
  if (message.method) log({ method: message.method });
  if (message.id === 'server-edit') log({ applyEditResult: message.result });
  if (message.method === 'initialize') {
    if (after && ['post-error','post-big-error'].includes(mode)) return send({ jsonrpc:'2.0', id:message.id, error:{code:-32603,message:mode==='post-big-error'?'fixture oversized post error '+ 'X'.repeat(1100000):'fixture post-apply startup failure'} });
    return send({jsonrpc:'2.0',id:message.id,result:{capabilities:{definitionProvider:true,referencesProvider:true,hoverProvider:true,codeActionProvider:{codeActionKinds:['quickfix'],resolveProvider:true}}}});
  }
  if (['textDocument/didOpen','textDocument/didChange'].includes(message.method)) {
    uri = message.params.textDocument.uri;
    if (after && mode === 'post-timeout') return;
    const diagnostics = after ? mode === 'post-big' ? [{range,severity:1,code:'fixture-large',message:'X'.repeat(300000)}]
      : mode === 'post-many' ? Array.from({length:100},(_,i)=>({range,severity:1,code:'fixture-many',message:'issue '+i})) : []
      : [{range:{start:{line:0,character:9},end:{line:0,character:15}},severity:1,source:'fixture',code:'unresolved-reference',message:'square is undefined'}];
    send({jsonrpc:'2.0',method:'textDocument/publishDiagnostics',params:{uri,version:message.params.textDocument.version,diagnostics}});
    if (after && mode === 'post-change') appendFileSync(source,'# separate change during post diagnostics\n');
  } else if (message.method === 'textDocument/codeAction') {
    const edit = {changes:{[uri]:[{range,newText:'from utils import square\n'}]}};
    send({jsonrpc:'2.0',id:'server-edit',method:'workspace/applyEdit',params:{edit}});
    const actions = [
      {title:'Import square',kind:'quickfix',edit},
      {title:'Disabled',kind:'quickfix',edit,disabled:{reason:'fixture disabled'}},
      {title:'Deferred',kind:'quickfix',edit,data:{opaque:1}},
      {title:'Command only',command:'fixture.command',arguments:[1]},
      {title:'Command and edit',kind:'quickfix',edit,command:{command:'fixture.command',arguments:[2]}},
      {title:'Resource create',kind:'quickfix',edit:{documentChanges:[{kind:'create',uri:new URL('new.py',uri).href}]}},
      {title:'Annotated',kind:'quickfix',edit:{changes:{[uri]:[{range,newText:'from utils import square\n',annotationId:'a'}]},changeAnnotations:{a:{label:'must review',needsConfirmation:true}}}},
      {title:'External',kind:'quickfix',edit:{changes:{'file:///outside/secret.py':[{range,newText:'secret'}]}}},
    ];
    send({jsonrpc:'2.0',id:message.id,result:after?[]:mode==='duplicate'?[actions[0],actions[0]]:actions});
  } else if (['workspace/executeCommand','codeAction/resolve'].includes(message.method)) send({jsonrpc:'2.0',id:message.id,result:null});
  else if (message.method === 'shutdown') send({jsonrpc:'2.0',id:message.id,result:null});
  else if (message.method === 'exit') process.exit(0);
}
process.stdin.on('data',chunk=>{
  buffer=Buffer.concat([buffer,chunk]);
  while(true){const end=buffer.indexOf('\r\n\r\n');if(end<0)return;const length=Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0,end).toString())[1]);if(buffer.length<end+4+length)return;const message=JSON.parse(buffer.subarray(end+4,end+4+length));buffer=buffer.subarray(end+4+length);handle(message);}
});
