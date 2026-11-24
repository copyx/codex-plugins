import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const server = fileURLToPath(new URL('../../plugins/typescript-lsp/server.mjs', import.meta.url));
export async function mcp(root, calls) {
  const messages = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'navigation-test', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    ...calls.map((params, i) => ({ jsonrpc: '2.0', id: i + 3, method: 'tools/call', params })),
  ];
  const child = spawn(process.execPath, [server], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
  const timeout = setTimeout(() => child.kill('SIGTERM'), 45000);
  child.stdin.end(messages.map(m => JSON.stringify(m)).join('\n') + '\n');
  let code;
  try { code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }); }
  finally { clearTimeout(timeout); }
  assert.equal(code, 0, stderr);
  const responses = stdout.trim().split('\n').map(JSON.parse);
  assert.ok(responses.every(r => !r.error), stdout);
  return { tools: responses.find(r => r.id === 2).result.tools, calls: calls.map((_, i) => responses.find(r => r.id === i + 3).result) };
}
export function value(result) { assert.ok(!result.isError, JSON.stringify(result)); return JSON.parse(result.content[0].text); }
