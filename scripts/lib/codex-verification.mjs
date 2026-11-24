import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { mkdtemp, mkdir, readFile, writeFile, symlink, realpath, rm, stat, readdir } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repo = fileURLToPath(new URL('../../', import.meta.url));
const pluginId = 'typescript-lsp@copyx-codex-plugins';
const children = new Set();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const quote = value => JSON.stringify(value); // TOML basic string, not shell text.

function childProcess(command, args, options) {
  const child = spawn(command, args, { ...options, detached: process.platform !== 'win32', stdio: options?.stdio ?? ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  child.completion = new Promise(resolve => {
    child.once('error', error => resolve({ error }));
    child.once('close', code => { child.closed = true; children.delete(child); resolve({ code }); });
  });
  return child;
}
async function stop(child) {
  if (child.closed) return;
  child.stopping ??= (async () => {
    const kill = signal => {
      if (!child.pid) return;
      try { if (process.platform === 'win32') child.kill(signal); else process.kill(-child.pid, signal); }
      catch (error) { if (error.code !== 'ESRCH') throw new Error(`Subprocess cleanup ${signal} failed for ${path.basename(child.spawnfile)}: ${error.code}`); }
    };
    kill('SIGTERM');
    // Do not signal a process group again after its owned child has closed.
    const graceful = await Promise.race([child.completion.then(() => true), delay(350).then(() => false)]);
    if (!graceful) {
      kill('SIGKILL');
      const closed = await Promise.race([child.completion.then(() => true), delay(1000).then(() => false)]);
      assert.ok(closed, 'Verification subprocess cleanup failed');
    }
  })();
  await child.stopping;
}
export async function runProcess(command, args, { timeoutMs = 30000, ...options } = {}) {
  const child = childProcess(command, args, options);
  let interrupted = false;
  // The awaited finally reports cleanup errors; event callbacks must not create
  // unhandled rejections that bypass temporary-directory cleanup.
  const interrupt = () => { interrupted = true; void stop(child).catch(() => {}); };
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  let stdout = '', stderr = '', overflow = false;
  for (const [stream, append] of [[child.stdout, b => { stdout += b; }], [child.stderr, b => { stderr += b; }]]) {
    stream.on('data', b => {
      if (stdout.length + stderr.length < 2 * 1024 * 1024) append(b);
      else { overflow = true; void stop(child).catch(() => {}); }
    });
  }
  let timer;
  try {
    const result = await Promise.race([child.completion, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${path.basename(command)} timed out after ${timeoutMs}ms`)), timeoutMs); })]);
    if (result.error) throw new Error(`Cannot execute ${command}: ${result.error.code}`);
    assert.ok(!interrupted, 'Verification interrupted');
    assert.ok(!overflow, 'Verification subprocess output exceeded limit');
    return { ...result, stdout, stderr };
  } finally {
    clearTimeout(timer);
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
    await stop(child);
  }
}

export function cleanEnvironment(home) {
  const env = { CODEX_HOME: home };
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'SystemRoot', 'COMSPEC']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}
export async function prerequisites({ installed = false } = {}) {
  assert.ok(process.env.TEST_TYPESCRIPT_DIR, 'Set TEST_TYPESCRIPT_DIR to the TypeScript package directory (containing lib/tsserver.js)');
  assert.ok(process.env.TEST_MODEL_CATALOG, 'Set TEST_MODEL_CATALOG to public Codex model capability metadata (models_cache.json)');
  let typescript, ts, catalog;
  try {
    typescript = await realpath(path.resolve(process.env.TEST_TYPESCRIPT_DIR));
    await readFile(path.join(typescript, 'lib/tsserver.js'));
    ts = JSON.parse(await readFile(path.join(typescript, 'package.json'), 'utf8'));
  } catch { throw new Error('Invalid TEST_TYPESCRIPT_DIR: expected a TypeScript package with lib/tsserver.js and package.json'); }
  assert.ok(ts.name === 'typescript', 'TEST_TYPESCRIPT_DIR must be a TypeScript package');
  try { catalog = JSON.parse(await readFile(path.resolve(process.env.TEST_MODEL_CATALOG), 'utf8')); }
  catch { throw new Error('Invalid TEST_MODEL_CATALOG: expected a readable JSON model catalog'); }
  const model = (Array.isArray(catalog.models) ? catalog.models : []).find(m => typeof m?.slug === 'string' && m.apply_patch_tool_type === 'freeform');
  assert.ok(model, 'TEST_MODEL_CATALOG must contain a model with freeform apply_patch capability');
  const binary = process.env.TEST_CODEX_BIN || 'codex';
  const codex = /[/\\]/.test(binary) ? path.resolve(binary) : binary;
  const env = cleanEnvironment(path.resolve(process.env.CODEX_HOME || path.join(homedir(), '.codex')));
  // Codex itself can initialize a new home even for discovery commands. Reject
  // missing installed state before starting any CLI in the user-profile mode.
  if (installed) {
    assert.ok(await stat(env.CODEX_HOME).then(s => s.isDirectory()).catch(() => false), 'Current Codex profile does not exist; verify:installed never creates or installs a profile');
    assert.ok(Object.keys(await installedFiles(env.CODEX_HOME)).some(file => file.endsWith('plugin.json')), `${pluginId} is not installed in this profile; verify:installed never installs it`);
  }
  const version = await runProcess(codex, ['--version'], { env });
  assert.equal(version.code, 0, 'Codex CLI is required');
  const help = await runProcess(codex, ['exec', '--help'], { env });
  assert.match(help.stdout, /--ephemeral/, 'Codex must support --ephemeral to avoid saving request history');
  const lsp = await runProcess('typescript-language-server', ['--version'], { env });
  assert.equal(lsp.code, 0, 'typescript-language-server must be on PATH');
  return { typescript, model, codex, home: env.CODEX_HOME, tsVersion: ts.version, codexVersion: version.stdout.trim(), lspVersion: lsp.stdout.trim() };
}

export function requireTrustedHook(hooks) {
  const hook = hooks.find(h => h.pluginId === pluginId && h.eventName === 'postToolUse');
  assert.ok(hook, `${pluginId} is not installed or its hook is not discovered; install it before verify:installed`);
  assert.ok(hook.enabled, 'TypeScript diagnostics hook is disabled; review the installed plugin before verification');
  assert.equal(hook.trustStatus, 'trusted', 'Hook is not trusted: open /hooks → PostToolUse → Checking TypeScript diagnostics and review this hook; verification never changes trust');
  return hook;
}
function contexts(request) {
  return (request?.input ?? []).filter(i => i.role === 'developer').map(i => (i.content ?? []).filter(c => c.type === 'input_text').map(c => c.text).join('\n')).filter(text => text.includes('TypeScript LSP post-patch diagnostics'));
}
export function verifyTransition(errorRequest, fixedRequest) {
  const errors = contexts(errorRequest), fixed = contexts(fixedRequest);
  assert.match(errors.at(-1) ?? '', /TS2345/, 'Error patch must deliver TS2345 in developer context');
  assert.ok(fixed.length > errors.length, 'Fix must deliver a fresh hook context');
  assert.doesNotMatch(fixed.at(-1), /TS2345/, 'Fresh clean result must not contain TS2345');
  assert.match(fixed.at(-1), /main\.ts: no diagnostics published for this snapshot/, 'Fix must deliver a clean result, not a timeout or missing result');
  return { errorContexts: errors.length, fixedContexts: fixed.length };
}

async function appServer(options, env, work, installed, navigate = true) {
  const child = childProcess(options.codex, ['app-server'], { cwd: work, env, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.resume();
  const waiting = new Map();
  let id = 0;
  const lines = createInterface({ input: child.stdout });
  const fail = error => { for (const entry of waiting.values()) { clearTimeout(entry.timer); entry.reject(error); } waiting.clear(); };
  child.stdin.on('error', () => fail(new Error('Codex app-server input closed')));
  child.completion.then(() => fail(new Error('Codex app-server exited before responding')));
  lines.on('line', line => {
    try {
      const message = JSON.parse(line), entry = waiting.get(message.id);
      if (entry) { clearTimeout(entry.timer); waiting.delete(message.id); entry.resolve(message); }
    } catch { fail(new Error('Invalid app-server JSON')); }
  });
  const rpc = async (method, params) => {
    const response = await new Promise((resolve, reject) => {
      const n = ++id;
      const timer = setTimeout(() => { waiting.delete(n); reject(new Error(`Codex app-server timed out: ${method}`)); }, 25000);
      waiting.set(n, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ id: n, method, params }) + '\n');
    });
    assert.ok(!response.error, `Codex app-server ${method} failed (code ${response.error?.code}); no raw response was saved`);
    return response.result;
  };
  try {
    await rpc('initialize', { clientInfo: { name: 'typescript-lsp-verification', version: '1' }, capabilities: { experimentalApi: true } });
    const hooks = await rpc('hooks/list', { cwds: [work] });
    const own = hooks.data.flatMap(d => d.hooks).filter(h => h.pluginId === pluginId);
    const hook = installed ? requireTrustedHook(own) : own.find(h => h.eventName === 'postToolUse');
    assert.ok(hook?.enabled, 'Isolated installation must discover an enabled PostToolUse hook');
    const state = { enabled: hook.enabled, trustStatus: hook.trustStatus, currentHash: hook.currentHash };
    if (installed) {
      const relative = path.relative(path.join(options.home, 'plugins/cache/copyx-codex-plugins/typescript-lsp'), hook.sourcePath ?? '');
      assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Installed verification must use the cached plugin hook');
    }
    if (!navigate) return state;
    const thread = await rpc('thread/start', { cwd: work, ephemeral: true, approvalPolicy: 'never', sandbox: 'workspace-write' });
    const threadId = thread.thread.id;
    const inventory = await rpc('mcpServerStatus/list', { threadId, serverName: 'typescript-lsp' });
    const server = inventory.data.find(s => s.name === 'typescript-lsp');
    assert.ok(server?.tools?.definition && server.tools.references && server.tools.hover, 'Installed MCP navigation tools are missing');
    for (const tool of ['definition', 'references', 'hover']) {
      const result = await rpc('mcpServer/tool/call', { threadId, server: 'typescript-lsp', tool, arguments: { workspace_root: work, file: 'main.ts', line: 2, character: 3 } });
      assert.ok(!result.isError, `MCP ${tool} failed`);
      const data = JSON.parse(result.content[0].text).result;
      if (tool === 'definition') assert.equal(data[0].range.start.line, 0);
      if (tool === 'references') assert.ok(data.length >= 2);
      if (tool === 'hover') assert.match(data.contents.value, /name: string/);
    }
    return state;
  } finally { fail(new Error('Verification finished')); lines.close(); await stop(child); }
}

async function patchFixture(options, env, work, temp, installed) {
  // Keep only extracted hook context in memory; never save original requests.
  const observed = [];
  let failure;
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== 'POST') { response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"models":[]}'); return; }
      assert.ok(!request.headers.authorization && !request.headers['x-api-key'], 'Local fixture must not receive credentials');
      let body = '';
      for await (const chunk of request) { body += chunk; assert.ok(body.length < 8 * 1024 * 1024, 'Model fixture input exceeded limit'); }
      const payload = JSON.parse(body);
      const disk = await readFile(path.join(work, 'main.ts'), 'utf8');
      observed.push({ input: contexts(payload).map(text => ({ role: 'developer', content: [{ type: 'input_text', text }] })), disk });
      const stage = observed.length;
      assert.ok(stage <= 3, 'Unexpected extra model request');
      const before = stage === 1 ? 'greet("hello");' : 'greet(123);';
      const after = stage === 1 ? 'greet(123);' : 'greet("hello");';
      const item = stage <= 2
        ? { type: 'custom_tool_call', id: `ct_${stage}`, call_id: `call_${stage}`, name: 'apply_patch', input: `*** Begin Patch\n*** Update File: ${path.join(work, 'main.ts')}\n@@\n-${before}\n+${after}\n*** End Patch` }
        : { type: 'message', id: 'msg_done', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Verification complete.', annotations: [] }] };
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const emit = event => response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      emit({ type: 'response.created', response: { id: `resp_${stage}`, object: 'response', status: 'in_progress', output: [] } });
      emit({ type: 'response.output_item.added', output_index: 0, item });
      emit({ type: 'response.output_item.done', output_index: 0, item });
      emit({ type: 'response.completed', response: { id: `resp_${stage}`, object: 'response', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
      response.end();
    } catch { failure = new Error('Local Responses fixture failed; raw request was discarded'); response.writeHead(400).end(); }
  });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    // A unique provider cannot inherit credential settings from a user table.
    const provider = `verification_fixture_${randomUUID().replaceAll('-', '')}`;
    const args = ['--no-daemon', '-c', `model=${quote(options.model.slug)}`, '-c', `model_provider=${quote(provider)}`,
      '-c', `model_catalog_json=${quote(path.join(temp, 'models.json'))}`, '-c', `log_dir=${quote(path.join(temp, 'logs'))}`,
      '-c', 'analytics.enabled=false', '-c', 'check_for_update_on_startup=false',
      '-c', `model_providers.${provider}.name="Local verification fixture"`,
      '-c', `model_providers.${provider}.base_url="http://127.0.0.1:${server.address().port}/v1"`,
      '-c', `model_providers.${provider}.wire_api="responses"`, '-c', `model_providers.${provider}.requires_openai_auth=false`,
      ...(!installed ? ['-c', 'features.hooks=true'] : []),
      'exec', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'workspace-write',
      ...(!installed ? ['--dangerously-bypass-hook-trust'] : []), '--json', 'Run the local verification fixture, then finish.'];
    const result = await runProcess(options.codex, args, { cwd: work, env, timeoutMs: 60000 });
    if (failure) throw failure;
    assert.equal(result.code, 0, 'Codex fixture execution failed; raw child output was discarded');
    assert.equal(observed.length, 3, 'Expected initial, error, and fixed model requests');
    assert.match(observed[1].disk, /greet\(123\)/, 'First real apply_patch did not introduce the error');
    assert.match(observed[2].disk, /greet\("hello"\)/, 'Second real apply_patch did not fix the error');
    const events = result.stdout.trim().split('\n').map(line => JSON.parse(line));
    assert.equal(events.filter(e => e.type === 'item.completed' && e.item?.type === 'file_change' && e.item.status === 'completed').length, 2, 'Expected two completed real apply_patch events');
    return { ...verifyTransition(observed[1], observed[2]), modelRequests: observed.length, completedPatches: 2 };
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

async function hashConfig(home) {
  try { return createHash('sha256').update(await readFile(path.join(home, 'config.toml'))).digest('hex'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function installedFiles(home) {
  const root = path.join(home, 'plugins/cache/copyx-codex-plugins/typescript-lsp');
  const files = {};
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(file);
      else files[path.relative(root, file)] = createHash('sha256').update(await readFile(file)).digest('hex');
    }
  }
  try { await walk(root); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return files;
}
export async function runCodexVerification(options, { installed = false } = {}) {
  if (installed) {
    assert.ok(await stat(options.home).then(s => s.isDirectory()).catch(() => false), 'Current Codex profile does not exist; verify:installed never creates or installs a profile');
  }
  const cacheBefore = await installedFiles(options.home);
  if (installed) assert.ok(Object.keys(cacheBefore).some(file => file.endsWith('plugin.json')), `${pluginId} is not installed in this profile; verify:installed never installs it`);
  const configBefore = await hashConfig(options.home);
  const temp = await realpath(await mkdtemp(path.join(tmpdir(), 'typescript-lsp-verify-')));
  let summary;
  let interrupted = false;
  const interrupt = () => { interrupted = true; for (const child of children) void stop(child).catch(() => {}); };
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  try {
    const home = installed ? options.home : path.join(temp, 'codex-home');
    const work = path.join(temp, 'sample');
    if (!installed) await mkdir(home, { recursive: true });
    await mkdir(path.join(work, 'node_modules'), { recursive: true });
    await symlink(options.typescript, path.join(work, 'node_modules/typescript'), process.platform === 'win32' ? 'junction' : 'dir');
    await writeFile(path.join(work, 'tsconfig.json'), '{"compilerOptions":{"strict":true}}');
    await writeFile(path.join(work, 'main.ts'), 'export function greet(name: string) { return name; }\ngreet("hello");\n');
    await writeFile(path.join(temp, 'models.json'), JSON.stringify({ models: [options.model] }), { mode: 0o600 });
    const env = cleanEnvironment(home);
    if (!installed) {
      for (const args of [['plugin', 'marketplace', 'add', repo, '--json'], ['plugin', 'list', '--available', '--marketplace', 'copyx-codex-plugins', '--json'], ['plugin', 'add', pluginId, '--json']]) {
        assert.ok(!interrupted, 'Verification interrupted');
        const result = await runProcess(options.codex, args, { cwd: work, env });
        assert.equal(result.code, 0, 'Isolated marketplace discovery/install failed');
        const response = JSON.parse(result.stdout);
        if (args[1] === 'list') assert.ok(response.available.some(p => p.pluginId === pluginId), 'Marketplace catalog did not expose the plugin');
      }
    }
    assert.ok(!interrupted, 'Verification interrupted');
    const hook = await appServer(options, env, work, installed);
    assert.ok(!interrupted, 'Verification interrupted');
    const transition = await patchFixture(options, env, work, temp, installed);
    assert.ok(!interrupted, 'Verification interrupted');
    if (installed) assert.deepEqual(await appServer(options, env, work, installed, false), hook, 'Installed hook trust or activation changed during verification');
    summary = { mode: installed ? 'installed' : 'isolated', enabled: hook.enabled, trustStatus: hook.trustStatus, ...transition, configUnchanged: true, installationUnchanged: true, externalModelCalled: false, rawRequestLogsSaved: false };
  } finally {
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
    try { await Promise.all([...children].map(stop)); }
    finally {
      await rm(temp, { recursive: true, force: true });
      assert.equal(await hashConfig(options.home), configBefore, 'Current profile config.toml changed during verification');
      assert.deepEqual(await installedFiles(options.home), cacheBefore, 'Current profile installed plugin files changed during verification');
    }
  }
  console.log(`PASS: ${JSON.stringify(summary)}; temporary files and subprocesses cleaned`);
  return summary;
}
