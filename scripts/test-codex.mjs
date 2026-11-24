// Real Codex runtime with a deterministic local Responses fixture, no account
// credentials and no requests to a real model. Captures the model request after
// apply_patch to prove hook context delivery, rather than inferring it from stdout.
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, symlink, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const repo = fileURLToPath(new URL('../', import.meta.url));
if (!process.env.TEST_TYPESCRIPT_DIR || !process.env.TEST_MODEL_CATALOG) throw new Error('Set TEST_TYPESCRIPT_DIR to an existing TypeScript package and TEST_MODEL_CATALOG to public Codex model capability metadata (models_cache.json)');
const temp = await realpath(await mkdtemp(path.join(tmpdir(), 'typescript-lsp-codex-')));
const home = path.join(temp, 'codex-home');
const work = path.join(temp, 'sample');
await mkdir(home);
await mkdir(path.join(work, 'node_modules'), { recursive: true });
await symlink(process.env.TEST_TYPESCRIPT_DIR, path.join(work, 'node_modules/typescript'));
await writeFile(path.join(work, 'tsconfig.json'), '{"compilerOptions":{"strict":true},"include":["*.ts"]}');
await writeFile(path.join(work, 'main.ts'), 'function greet(name: string) { return name; }\ngreet("hello");\n');
const env = { ...process.env, CODEX_HOME: home };
// Prevent inherited account/provider credentials reaching the test process.
for (const key of Object.keys(env)) if (/TOKEN|API_KEY|SECRET/.test(key) || key.startsWith('ORCA_') || (key.startsWith('CODEX_') && key !== 'CODEX_HOME')) delete env[key];
// Only public model capability metadata is copied; identity/cache envelope and
// authentication data are excluded. The local fixture never contacts this model.
if (process.env.TEST_MODEL_CATALOG) {
  const catalog = JSON.parse(await readFile(process.env.TEST_MODEL_CATALOG, 'utf8'));
  await writeFile(path.join(temp, 'models.json'), JSON.stringify({ models: catalog.models }));
}
async function cli(args, { timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('codex', args, { cwd: work, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); }, timeout);
    child.stdout.on('data', b => { stdout += b; });
    child.stderr.on('data', b => { stderr += b; });
    child.on('error', reject);
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

async function checkAppServer() {
  const child = spawn('codex', ['app-server'], { cwd: work, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let id = 0, stderr = '';
  child.stderr.on('data', b => { stderr += b; });
  const input = createInterface({ input: child.stdout });
  input.on('line', line => {
    const message = JSON.parse(line);
    if (pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
  });
  const rpc = async (method, params) => {
    const response = await new Promise((resolve, reject) => {
      const n = ++id;
      const timer = setTimeout(() => { pending.delete(n); reject(new Error(`app-server timeout: ${method}: ${stderr}`)); }, 15000);
      pending.set(n, message => { clearTimeout(timer); resolve(message); });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n');
    });
    assert.ok(!response.error, JSON.stringify(response));
    return response.result;
  };
  try {
    await rpc('initialize', { clientInfo: { name: 'typescript-lsp-test', version: '1' }, capabilities: { experimentalApi: true } });
    const hooks = await rpc('hooks/list', { cwds: [work] });
    assert.match(JSON.stringify(hooks), /postToolUse/, 'Installed plugin hook must be discovered by Codex');
    const thread = await rpc('thread/start', { cwd: work, approvalPolicy: 'never', sandbox: 'workspace-write' });
    const threadId = thread.thread.id;
    const inventory = await rpc('mcpServerStatus/list', { threadId });
    assert.match(JSON.stringify(inventory), /"hover"/, 'Codex must discover installed MCP navigation tools');
    const calls = [];
    for (const tool of ['definition', 'references', 'hover']) {
      const result = await rpc('mcpServer/tool/call', { threadId, server: 'typescript-lsp', tool, arguments: { workspace_root: work, file: 'main.ts', line: 2, character: 3 } });
      assert.ok(!result.isError, JSON.stringify(result));
      const data = JSON.parse(result.content[0].text).result;
      if (tool === 'definition') assert.equal(data[0].range.start.line, 0);
      if (tool === 'references') assert.ok(data.length >= 2);
      if (tool === 'hover') assert.match(data.contents.value, /name: string/);
      calls.push({ tool, result });
    }
    assert.match(JSON.stringify(calls.at(-1)), /name: string/);
    await writeFile(path.join(temp, 'app-server-evidence.json'), JSON.stringify({ hooks, inventory, calls }, null, 2));
    console.log('PASS: actual Codex app-server discovered plugin hook and called definition/references/hover');
  } finally { child.kill('SIGTERM'); input.close(); }
}

const requests = [];
let stage = 0;
const server = createServer(async (request, response) => {
  let body = '';
  for await (const chunk of request) body += chunk;
  let payload;
  try { payload = JSON.parse(body); } catch { response.writeHead(400).end(); return; }
  requests.push(payload);
  const responseId = `resp_${stage}`;
  let item;
  if (stage === 0) {
    item = { type: 'custom_tool_call', id: 'ct_patch', call_id: 'call_patch', name: 'apply_patch', input: '*** Begin Patch\n*** Update File: ' + path.join(work, 'main.ts') + '\n@@\n-greet("hello");\n+greet(123);\n*** End Patch' };
  } else {
    item = { type: 'message', id: 'msg_done', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Local fixture completed.', annotations: [] }] };
  }
  stage++;
  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  const emit = event => response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  emit({ type: 'response.created', response: { id: responseId, object: 'response', status: 'in_progress', output: [] } });
  emit({ type: 'response.output_item.added', output_index: 0, item });
  emit({ type: 'response.output_item.done', output_index: 0, item });
  emit({ type: 'response.completed', response: { id: responseId, object: 'response', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
  response.end();
});

try {
  for (const args of [
    ['plugin', 'marketplace', 'add', repo, '--json'],
    ['plugin', 'list', '--available', '--marketplace', 'copyx-codex-plugins', '--json'],
    ['plugin', 'add', 'typescript-lsp@copyx-codex-plugins', '--json'],
    ['plugin', 'list', '--json'],
    ['mcp', 'list', '--json'],
  ]) {
    const result = await cli(args);
    assert.equal(result.code, 0, JSON.stringify(result));
    console.log(args.slice(0, 3).join(' '), result.stdout.trim());
  }
  await checkAppServer();
  await new Promise((resolve, reject) => { server.on('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const result = await cli([
    '-c', 'model="gpt-6.1-sol"', '-c', 'model_provider="fixture"',
    ...(process.env.TEST_MODEL_CATALOG ? ['-c', `model_catalog_json="${path.join(temp, 'models.json')}"`] : []),
    '-c', 'model_providers.fixture.name="Local test fixture"',
    '-c', `model_providers.fixture.base_url="http://127.0.0.1:${server.address().port}/v1"`,
    '-c', 'model_providers.fixture.wire_api="responses"',
    '-c', 'model_providers.fixture.requires_openai_auth=false',
    '-c', 'features.hooks=true', '-c', 'features.multi_agent=false',
    'exec', '--skip-git-repo-check', '--sandbox', 'workspace-write',
    '--dangerously-bypass-hook-trust', '--json', 'Run the local fixture tools and finish.',
  ], { timeout: 45000 });
  await writeFile(path.join(temp, 'codex-output.jsonl'), result.stdout);
  await writeFile(path.join(temp, 'codex-stderr.txt'), result.stderr);
  await writeFile(path.join(temp, 'model-requests.json'), JSON.stringify(requests, null, 2));
  console.log('Runtime exit:', result.code, 'model requests:', requests.length, 'evidence:', temp);
  assert.equal(result.code, 0, result.stderr);
  assert.match(await readFile(path.join(work, 'main.ts'), 'utf8'), /greet\(123\)/, 'Actual apply_patch must edit the file');
  const modelContext = JSON.stringify(requests.at(-1)?.input);
  assert.match(modelContext, /TypeScript LSP post-patch diagnostics/, 'Hook additionalContext must enter the next model request');
  assert.match(modelContext, /TS2345/, 'Published LSP error must enter the next model request');
  console.log('PASS: catalog -> install -> Codex app-server navigation; actual apply_patch -> PostToolUse -> TS2345 in next model request');
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  if (process.env.KEEP_CODEX_TEST !== '1') await rm(temp, { recursive: true, force: true });
}
