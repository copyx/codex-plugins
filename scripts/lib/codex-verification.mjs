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
export function navigationTools(tools, { installed = false } = {}) {
  const baseline = ['definition', 'references', 'hover'];
  const added = ['document_symbols', 'type_definition', 'implementation', 'project_symbols', 'code_actions_preview', 'rename_preview'];
  const required = installed ? baseline : [...baseline, ...added];
  assert.ok(required.every(name => tools?.[name]), 'Expected MCP navigation tools are missing');
  // An older installed package may legitimately expose only the original tools.
  // Check new tools when advertised, but require all of them for the checkout.
  return [...baseline, ...added.filter(name => tools?.[name])];
}
function contexts(request, language = 'TypeScript') {
  return (request?.input ?? []).filter(i => i.role === 'developer').map(i => (i.content ?? []).filter(c => c.type === 'input_text').map(c => c.text).join('\n')).filter(text => text.includes(`${language} LSP post-patch diagnostics`));
}
export function verifyPythonTransition(errorRequest, fixedRequest) {
  const errors = contexts(errorRequest, 'Python'), fixed = contexts(fixedRequest, 'Python');
  assert.match(errors.at(-1) ?? '', /invalid-argument-type/, 'Error patch must deliver Python invalid-argument-type in developer context');
  assert.ok(fixed.length > errors.length, 'Fix must deliver a fresh Python hook context');
  assert.doesNotMatch(fixed.at(-1), /invalid-argument-type/, 'Fresh Python clean result must not contain invalid-argument-type');
  assert.match(fixed.at(-1), /main\.py: no diagnostics published for this snapshot/, 'Fix must deliver a clean Python result');
  return { pythonErrorContexts: errors.length, pythonFixedContexts: fixed.length };
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
    if (options.python) {
      const pythonHook = hooks.data.flatMap(d => d.hooks).find(h => h.pluginId === 'python-lsp@copyx-codex-plugins' && h.eventName === 'postToolUse');
      assert.ok(pythonHook?.enabled, 'Independent Python hook must be discovered and enabled');
      if (installed) assert.equal(pythonHook.trustStatus, 'trusted', 'Python hook must be reviewed in the selected isolated profile before trusted verification');
      state.pythonTrustStatus = pythonHook.trustStatus;
      state.pythonCurrentHash = pythonHook.currentHash;
      const cached = path.dirname(path.dirname(pythonHook.sourcePath));
      const relative = path.relative(path.join(env.CODEX_HOME, 'plugins/cache/copyx-codex-plugins/python-lsp'), cached);
      assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Python hook must run from the selected profile cache');
      async function hashes(dir, prefix = '') {
        const found = {};
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          const file = path.join(dir, entry.name), key = path.join(prefix, entry.name);
          if (entry.isDirectory()) Object.assign(found, await hashes(file, key));
          else found[key] = createHash('sha256').update(await readFile(file)).digest('hex');
        }
        return found;
      }
      const expected = await hashes(path.join(repo, 'plugins/python-lsp'));
      assert.deepEqual(await hashes(cached), expected, 'Cached Python bundle must exactly match this checkout, including all runtime files');
      state.pythonBundleFiles = Object.keys(expected).length;
    }
    if (!navigate) return state;
    const thread = await rpc('thread/start', { cwd: work, ephemeral: true, approvalPolicy: 'never', sandbox: 'workspace-write' });
    const threadId = thread.thread.id;
    const inventory = await rpc('mcpServerStatus/list', { threadId, serverName: 'typescript-lsp' });
    const server = inventory.data.find(s => s.name === 'typescript-lsp');
    if (options.python) {
      const pythonInventory = await rpc('mcpServerStatus/list', { threadId, serverName: 'python-lsp' });
      const pythonServer = pythonInventory.data.find(s => s.name === 'python-lsp');
      const pythonManifest = JSON.parse(await readFile(path.join(repo, 'plugins/python-lsp/.codex-plugin/plugin.json'), 'utf8'));
      assert.equal(pythonServer?.serverInfo?.version, pythonManifest.version);
      assert.deepEqual(Object.keys(pythonServer.tools).sort(), ['definition', 'document_symbols', 'hover', 'project_symbols', 'references']);
      for (const tool of ['definition', 'references', 'hover', 'document_symbols', 'project_symbols']) {
        assert.equal(pythonServer.tools[tool].annotations.readOnlyHint, true);
        const arguments_ = tool === 'document_symbols' ? { workspace_root: work, file: 'symbols.py' } : tool === 'project_symbols' ? { workspace_root: work, file: 'search-a/main.py', query: 'HiddenAlpha' } : { workspace_root: work, file: 'main.py', line: 3, character: 2 };
        const result = await rpc('mcpServer/tool/call', { threadId, server: 'python-lsp', tool, arguments: arguments_ });
        assert.ok(!result.isError, `Python MCP ${tool} failed: ${result.content?.[0]?.text ?? 'no content'}`);
        const output = JSON.parse(result.content[0].text);
        if (options.useRuntimeConfig) {
          assert.equal(output.server.configuration_source, 'user_config');
          assert.equal(output.server.executable, options.ty);
        }
        const data = output.result;
        if (tool === 'definition') assert.equal((data[0].range ?? data[0].targetSelectionRange).start.line, 0);
        if (tool === 'references') assert.ok(data.length >= 2);
        if (tool === 'hover') assert.match(data.contents.value, /name: str/);
        if (tool === 'document_symbols') {
          assert.deepEqual(pythonServer.tools[tool].inputSchema.required, ['workspace_root', 'file']);
          const greeter = data.find(s => s.name === 'Greeter');
          assert.equal(greeter.kind, 5); assert.equal(greeter.children.find(s => s.name === 'greet').kind, 6);
          assert.equal(data.find(s => s.name === 'decorate').kind, 12);
          const empty = await rpc('mcpServer/tool/call', { threadId, server: 'python-lsp', tool, arguments: { workspace_root: work, file: 'empty.py' } });
          assert.ok(!empty.isError); assert.deepEqual(JSON.parse(empty.content[0].text).result, []);
        }
        if (tool === 'project_symbols') {
          assert.deepEqual(pythonServer.tools[tool].inputSchema.required, ['workspace_root', 'file', 'query']);
          assert.equal(output.search_scope.project_root, path.join(work, 'search-a'));
          assert.equal(output.search_scope.config, path.join(work, 'search-a/ty.toml'));
          assert.equal(output.search_scope.anchor_file, path.join(work, 'search-a/main.py'));
          assert.ok(data.some(s => s.name === 'HiddenAlpha' && s.kind === 5 && s.location.uri.endsWith('/search-a/hidden.py')));
          const search = async (file, query) => {
            const result = await rpc('mcpServer/tool/call', { threadId, server: 'python-lsp', tool, arguments: { workspace_root: work, file, query } });
            assert.ok(!result.isError); return JSON.parse(result.content[0].text).result;
          };
          assert.deepEqual(await search('search-a/main.py', 'NoSuchSymbolAnywhere'), []);
          assert.deepEqual(await search('search-a/main.py', 'HiddenBeta'), []);
          assert.ok((await search('search-b/main.py', 'HiddenBeta')).some(s => s.name === 'HiddenBeta'));
        }
      }
    }
    const bundleRoot = path.dirname(path.dirname(hook.sourcePath));
    const manifest = JSON.parse(await readFile(path.join(bundleRoot, '.codex-plugin/plugin.json'), 'utf8'));
    assert.equal(server?.serverInfo?.version, manifest.version, 'Actual MCP server version must match the installed manifest');
    const checked = navigationTools(server?.tools, { installed: installed && !options.python });
    const call = (tool, args) => rpc('mcpServer/tool/call', { threadId, server: 'typescript-lsp', tool, arguments: { workspace_root: work, ...args } });
    for (const tool of checked) {
      assert.equal(server.tools[tool].annotations?.readOnlyHint, true, `${tool} must remain read-only`);
      if (['project_symbols', 'code_actions_preview', 'rename_preview'].includes(tool)) {
        const args = tool === 'project_symbols' ? { file: 'main.ts', query: 'square' }
          : tool === 'code_actions_preview' ? { file: 'quickfix.ts', range: { start: { line: 1, character: 1 }, end: { line: 1, character: 33 } } }
            : { file: 'navigation.ts', line: 1, character: 18, new_name: 'Greeting' };
        const response = await call(tool, args);
        assert.ok(!response.isError, `MCP ${tool} failed`);
        const data = JSON.parse(response.content[0].text);
        if (tool === 'project_symbols') {
          assert.equal(data.search_scope.kind, 'selected_project_session');
          assert.ok(data.result.some(s => s.name === 'square' && s.location.uri.endsWith('/utils.ts')));
          const other = await call(tool, { file: 'main.ts', query: 'SiblingSymbol' });
          assert.deepEqual(JSON.parse(other.content[0].text).result, []);
          const sibling = await call(tool, { file: 'sibling/other.ts', query: 'SiblingSymbol' });
          assert.ok(JSON.parse(sibling.content[0].text).result.some(s => s.name === 'SiblingSymbol'));
        } else {
          const preview = tool === 'code_actions_preview' ? data.result.find(a => a.title.includes('Add import')) : data.result;
          assert.ok(preview, `MCP ${tool} returned no preview`);
          assert.equal(preview.preview_only, true);
          assert.match(preview.selection_id, /^sha256:[a-f0-9]{64}$/);
          assert.ok(preview.edit.files.every(f => f.sha256 && f.workspace_boundary === 'inside'));
          if (tool === 'code_actions_preview') {
            assert.ok(data.diagnostics.some(d => d.code === 2304));
            assert.equal(preview.status, 'requires_command');
          } else { assert.equal(preview.status, 'edit_available'); assert.ok(preview.edit.files.length >= 2); }
        }
        const outside = await call(tool, { ...args, file: '../outside.ts' });
        assert.equal(outside.isError, true, `MCP ${tool} must reject files outside the root`);
        continue;
      }
      const file = ['definition', 'references', 'hover'].includes(tool) ? 'main.ts' : 'navigation.ts';
      const args = tool === 'document_symbols' ? { file } : { file, line: tool === 'type_definition' ? 5 : tool === 'implementation' ? 1 : 2, character: tool === 'type_definition' ? 14 : tool === 'implementation' ? 18 : 3 };
      const result = await call(tool, args);
      assert.ok(!result.isError, `MCP ${tool} failed`);
      const data = JSON.parse(result.content[0].text).result;
      if (tool === 'definition') assert.equal(data[0].range.start.line, 0);
      if (tool === 'references') assert.ok(data.length >= 2);
      if (tool === 'hover') assert.match(data.contents.value, /name: string/);
      if (tool === 'document_symbols') {
        for (const [name, kind] of [['Greeter', 11], ['FriendlyGreeter', 5], ['decorate', 12], ['greet', 6]]) {
          assert.ok(data.some(s => s.name === name && s.kind === kind && s.location.uri.endsWith('/navigation.ts')), `MCP symbol ${name} missing`);
        }
      }
      if (tool === 'type_definition') { assert.equal(data.length, 1); assert.equal(data[0].range.start.line, 0); }
      if (tool === 'implementation') { assert.equal(data.length, 2); assert.deepEqual(data.map(r => r.range.start.line).sort(), [1, 2]); }
      if (['document_symbols', 'type_definition', 'implementation'].includes(tool)) {
        const emptyArgs = tool === 'document_symbols' ? { file: 'empty.ts' } : tool === 'type_definition' ? { file: 'empty.ts', line: 1, character: 4 } : { file, line: 6, character: 18 };
        const empty = await call(tool, emptyArgs);
        assert.ok(!empty.isError, `MCP ${tool} empty-result request failed`);
        assert.deepEqual(JSON.parse(empty.content[0].text).result, [], `MCP ${tool} must return an empty result`);
        const outside = await call(tool, { ...args, file: '../outside.ts' });
        assert.equal(outside.isError, true, `MCP ${tool} must reject files outside the root`);
      }
    }
    const applications = ['code_action_apply', 'rename_apply'].filter(name => server.tools[name]);
    if (!installed) assert.equal(applications.length, 2, 'Checkout must advertise both explicit write tools');
    for (const tool of applications) {
      assert.equal(server.tools[tool].annotations?.readOnlyHint, false, `${tool} is a write tool`);
      assert.equal(server.tools[tool].annotations?.destructiveHint, true);
    }
    if (applications.includes('code_action_apply')) {
      const args = { file: 'apply-project/quickfix.ts', range: { start: { line: 1, character: 23 }, end: { line: 1, character: 29 } } };
      const shown = await call('code_actions_preview', args);
      const selected = JSON.parse(shown.content[0].text).result.find(a => a.title.includes('Add import'));
      assert.ok(selected, 'Actual write fixture needs an import candidate');
      const response = await call('code_action_apply', { ...args, selection_id: selected.selection_id });
      assert.ok(!response.isError, 'Actual Codex quickfix apply failed');
      const result = JSON.parse(response.content[0].text);
      assert.equal(result.status, 'applied'); assert.equal(result.command_effect.status, 'proven_noop');
      assert.equal(result.diagnostics_status, 'received'); assert.equal(result.diagnostics.length, result.files.length);
      assert.ok(result.diagnostics.every(d => d.status === 'received' && !d.diagnostics.some(e => e.code === 2304)));
      assert.match(await readFile(path.join(work, args.file), 'utf8'), /import \{ square \} from/);
      assert.equal((await call('code_action_apply', { ...args, selection_id: selected.selection_id })).isError, true, 'Repeat/stale quickfix must be rejected');
    }
    if (applications.includes('rename_apply')) {
      const args = { file: 'apply-project/model.ts', line: 1, character: 14, new_name: 'NamedGreeter' };
      const shown = await call('rename_preview', args);
      const selected = JSON.parse(shown.content[0].text).result;
      const beforeOther = await readFile(path.join(work, 'apply-project/unrelated.ts'), 'utf8');
      const response = await call('rename_apply', { ...args, selection_id: selected.selection_id });
      assert.ok(!response.isError, 'Actual Codex rename apply failed');
      const result = JSON.parse(response.content[0].text);
      assert.equal(result.status, 'applied'); assert.equal(result.files.length, 2);
      assert.equal(result.diagnostics_status, 'received'); assert.equal(result.diagnostics.length, 2);
      assert.match(await readFile(path.join(work, args.file), 'utf8'), /class NamedGreeter/);
      assert.match(await readFile(path.join(work, 'apply-project/consumer.ts'), 'utf8'), /import \{ NamedGreeter \}/);
      assert.equal(await readFile(path.join(work, 'apply-project/unrelated.ts'), 'utf8'), beforeOther);
      assert.equal((await call('rename_apply', { ...args, selection_id: selected.selection_id })).isError, true, 'Repeat/stale rename must be rejected');
    }
    return { ...state, navigationTools: checked, applicationTools: applications };
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
      const pythonDisk = options.python ? await readFile(path.join(work, 'main.py'), 'utf8') : null;
      observed.push({ input: [...contexts(payload), ...(options.python ? contexts(payload, 'Python') : [])].map(text => ({ role: 'developer', content: [{ type: 'input_text', text }] })), disk, pythonDisk });
      const stage = observed.length;
      assert.ok(stage <= 3, 'Unexpected extra model request');
      const before = stage === 1 ? 'greet("hello");' : 'greet(123);';
      const after = stage === 1 ? 'greet(123);' : 'greet("hello");';
      const pythonPatch = options.python ? `\n*** Update File: ${path.join(work, 'main.py')}\n@@\n-${before.slice(0, -1)}\n+${after.slice(0, -1)}` : '';
      const item = stage <= 2
        ? { type: 'custom_tool_call', id: `ct_${stage}`, call_id: `call_${stage}`, name: 'apply_patch', input: `*** Begin Patch\n*** Update File: ${path.join(work, 'main.ts')}\n@@\n-${before}\n+${after}${pythonPatch}\n*** End Patch` }
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
    if (options.python) {
      assert.match(observed[1].pythonDisk, /greet\(123\)/);
      assert.match(observed[2].pythonDisk, /greet\("hello"\)/);
    }
    const events = result.stdout.trim().split('\n').map(line => JSON.parse(line));
    assert.equal(events.filter(e => e.type === 'item.completed' && e.item?.type === 'file_change' && e.item.status === 'completed').length, 2, 'Expected two completed real apply_patch events');
    return { ...verifyTransition(observed[1], observed[2]), ...(options.python ? verifyPythonTransition(observed[1], observed[2]) : {}), modelRequests: observed.length, completedPatches: 2 };
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

async function hashConfig(home) {
  try { return createHash('sha256').update(await readFile(path.join(home, 'config.toml'))).digest('hex'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function installedFiles(home) {
  const root = path.join(home, 'plugins/cache/copyx-codex-plugins');
  const files = {};
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (dir === root && !['typescript-lsp', 'python-lsp'].includes(entry.name)) continue;
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
    const sources = {
      'tsconfig.json': '{"compilerOptions":{"strict":true},"include":["*.ts"]}',
      'main.ts': 'export function greet(name: string) { return name; }\ngreet("hello");\n',
      'navigation.ts': 'export interface Greeter { greet(name: string): string; }\nexport class FriendlyGreeter implements Greeter { greet(name: string) { return name; } }\nexport class FormalGreeter implements Greeter { greet(name: string) { return "Hello " + name; } }\nexport function decorate(text: string) { return text; }\nexport const service: Greeter = new FriendlyGreeter();\nexport interface Unused { nothing(): void; }\n',
      'empty.ts': '// No symbols here.\n',
      'utils.ts': 'export function square(value: number) { return value * value; }\n',
      'quickfix.ts': 'export const answer = square(2);\n',
      'rename-user.ts': 'import { Greeter } from "./navigation";\nexport type Alias = Greeter;\n',
      'sibling/tsconfig.json': '{"compilerOptions":{"strict":true},"include":["*.ts"]}',
      'sibling/other.ts': 'export function SiblingSymbol() { return true; }\n',
    };
    for (const [file, text] of Object.entries(sources)) { await mkdir(path.dirname(path.join(work, file)), { recursive: true }); await writeFile(path.join(work, file), text); }
    const applicationSources = {
      'tsconfig.json': '{"compilerOptions":{"strict":true},"include":["*.ts"]}',
      'quickfix.ts': 'export const answer = square(2);\n',
      'utils.ts': 'export function square(value: number) { return value * value; }\n',
      'model.ts': 'export class Greeter { value = 1; }\n',
      'consumer.ts': 'import { Greeter } from "./model";\nexport const instance = new Greeter();\n',
      'unrelated.ts': 'export function local() { class Greeter { value = 2; } return new Greeter(); }\n',
    };
    await mkdir(path.join(work, 'apply-project'));
    for (const [file, text] of Object.entries(applicationSources)) await writeFile(path.join(work, 'apply-project', file), text);
    await writeFile(path.join(temp, 'models.json'), JSON.stringify({ models: [options.model] }), { mode: 0o600 });
    const env = cleanEnvironment(home);
    if (options.python) {
      await symlink(options.pythonEnv, path.join(work, '.venv'), process.platform === 'win32' ? 'junction' : 'dir');
      sources['main.py'] = 'def greet(name: str) -> str:\n    return name\ngreet("hello")\n';
      sources['symbols.py'] = 'class Greeter:\n    def greet(self, name: str) -> str:\n        return name\n\ndef decorate(text: str) -> str:\n    return text\n';
      sources['empty.py'] = '# No symbols here.\n';
      for (const file of ['main.py', 'symbols.py', 'empty.py']) await writeFile(path.join(work, file), sources[file]);
      for (const [name, symbol] of [['search-a', 'HiddenAlpha'], ['search-b', 'HiddenBeta']]) {
        await mkdir(path.join(work, name));
        await symlink(options.pythonEnv, path.join(work, name, '.venv'), process.platform === 'win32' ? 'junction' : 'dir');
        for (const [file, text] of Object.entries({ 'ty.toml': '[environment]\nroot = ["."]\n', 'main.py': '# anchor\n', 'hidden.py': `class ${symbol}:\n    pass\n` })) {
          sources[`${name}/${file}`] = text; await writeFile(path.join(work, name, file), text);
        }
      }
      if (options.useRuntimeConfig) {
        env.HOME = path.join(temp, 'runtime-home');
        const directory = path.join(env.HOME, '.config/codex-python-lsp');
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await writeFile(path.join(directory, 'config.json'), JSON.stringify({ ty_path: options.ty }), { mode: 0o600 });
      } else env.PYTHON_LSP_TY = options.ty;
    }
    if (!installed) {
      for (const args of [['plugin', 'marketplace', 'add', repo, '--json'], ['plugin', 'list', '--available', '--marketplace', 'copyx-codex-plugins', '--json'], ['plugin', 'add', pluginId, '--json'], ...(options.python ? [['plugin', 'add', 'python-lsp@copyx-codex-plugins', '--json']] : [])]) {
        assert.ok(!interrupted, 'Verification interrupted');
        const result = await runProcess(options.codex, args, { cwd: work, env });
        assert.equal(result.code, 0, 'Isolated marketplace discovery/install failed');
        const response = JSON.parse(result.stdout);
        if (args[1] === 'list') for (const name of [pluginId, ...(options.python ? ['python-lsp@copyx-codex-plugins'] : [])]) assert.ok(response.available.some(p => p.pluginId === name), 'Marketplace catalog did not expose the plugin');
      }
    }
    assert.ok(!interrupted, 'Verification interrupted');
    const { navigationTools: checked, applicationTools: applied, ...hook } = await appServer(options, env, work, installed);
    for (const [file, text] of Object.entries(sources)) assert.equal(await readFile(path.join(work, file), 'utf8'), text, `Read-only MCP tools changed ${file}`);
    assert.ok(!interrupted, 'Verification interrupted');
    const transition = await patchFixture(options, env, work, temp, installed);
    for (const [file, text] of Object.entries(sources)) assert.equal(await readFile(path.join(work, file), 'utf8'), text, `Fixture did not restore ${file}`);
    assert.ok(!interrupted, 'Verification interrupted');
    if (installed) assert.deepEqual(await appServer(options, env, work, installed, false), hook, 'Installed hook trust or activation changed during verification');
    summary = { mode: installed ? 'installed' : 'isolated', enabled: hook.enabled, trustStatus: hook.trustStatus, navigationTools: checked, applicationTools: applied, ...(options.python ? { pythonTools: ['definition', 'references', 'hover', 'document_symbols', 'project_symbols'], pythonTrustStatus: hook.pythonTrustStatus, pythonBundleFiles: hook.pythonBundleFiles, hookExecution: installed ? 'trusted' : 'isolated_trust_bypass', mixedLanguagePatches: 2 } : {}), ...transition, configUnchanged: true, installationUnchanged: true, externalModelCalled: false, rawRequestLogsSaved: false };
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
