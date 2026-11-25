import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
test('Python 0.2.0 public release metadata matches actual MCP version and read/write inventory',async()=>{
  const root=new URL('../plugins/python-lsp/',import.meta.url),manifest=JSON.parse(await readFile(new URL('.codex-plugin/plugin.json',root),'utf8'));
  const result=spawnSync(process.execPath,[fileURLToPath(new URL('server.mjs',root))],{input:[{jsonrpc:'2.0',id:1,method:'initialize'},{jsonrpc:'2.0',id:2,method:'tools/list'}].map(JSON.stringify).join('\n')+'\n',encoding:'utf8',timeout:5000});
  assert.equal(result.status,0,result.stderr);const [initialized,listed]=result.stdout.trim().split('\n').map(JSON.parse).map(r=>r.result);
  assert.equal(manifest.version,'0.2.0','release candidate must identify its added write APIs');assert.equal(initialized.serverInfo.version,manifest.version);
  assert.deepEqual(manifest.interface.capabilities,['Read','Write']);
  assert.equal(listed.tools.filter(t=>t.annotations.readOnlyHint).length,9);assert.deepEqual(listed.tools.filter(t=>!t.annotations.readOnlyHint).map(t=>t.name),['code_action_apply','rename_apply']);
});
