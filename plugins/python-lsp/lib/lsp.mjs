import { spawn, spawnSync } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { boundedText, inside, supported } from './project.mjs';
import { resolveTyRuntime } from './runtime.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const MAX_FRAME = 8 * 1024 * 1024;
const bundle = fileURLToPath(new URL('../', import.meta.url));
export class LspSession {
  constructor(project, { timeoutMs = 8000, diagnosticMs = 6000, settleMs = 100, command, checkVersion = true, requireCapabilities = true } = {}) {
    Object.assign(this, { project, timeoutMs, diagnosticMs, settleMs, command, checkVersion, requireCapabilities });
    this.pending = new Map(); this.documents = new Map(); this.publications = new Map();
    this.buffer = Buffer.alloc(0); this.sequence = 0; this.id = 0;
    this.settings = { diagnosticMode: 'openFilesOnly', configuration: { environment: { python: project.environment?.path } },
      ...(project.configurationFile ? { configurationFile: project.configurationFile } : {}) };
  }
  async start() {
    if (this.closed) throw new Error('LSP session closed');
    this.runtime = this.command === undefined ? await resolveTyRuntime() : { command: this.command, source: 'explicit_command', config: null };
    this.command = this.runtime.command;
    if (!this.command || !path.isAbsolute(this.command)) throw new Error('ty executable must be an absolute path; no automatic install or PATH fallback');
    const env = {};
    for (const key of ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'LANG', 'LC_ALL']) if (process.env[key]) env[key] = process.env[key];
    Object.assign(env, { VIRTUAL_ENV: this.project.environment.path, XDG_CONFIG_HOME: path.join(bundle, '.no-user-config'), APPDATA: path.join(bundle, '.no-user-config') });
    if (this.checkVersion) {
      const result = spawnSync(this.command, ['--version'], { env, encoding: 'utf8', timeout: 2000, maxBuffer: 8192 });
      const label = this.runtime.source === 'environment' ? 'PYTHON_LSP_TY' : this.runtime.config ?? 'ty executable';
      if (result.error || result.status !== 0) throw new Error(`Cannot execute ${label} (${result.error?.code ?? result.status}); install ty 0.0.109 separately`);
      if (!/^ty 0\.0\.109(?:\s|$)/.test(result.stdout)) throw new Error(`${label} must be ty 0.0.109; found ${result.stdout.trim().slice(0, 160)}`);
    }
    this.child = spawn(this.command, ['server'], { cwd: this.project.root, env, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stderr.on('data', b => { this.stderr = ((this.stderr ?? '') + b).slice(-4000); });
    this.child.stdin.on('error', error => this.fail(error));
    this.child.on('error', error => this.fail(error));
    this.child.on('exit', (code, signal) => this.fail(new Error(`ty server exited (${code ?? signal}): ${this.stderr ?? ''}`)));
    this.child.stdout.on('data', b => { try { this.consume(b); } catch (e) { this.fail(e); this.kill(); } });
    const initialized = await this.request('initialize', {
      processId: process.pid, clientInfo: { name: 'codex-python-lsp', version: '0.1.1' },
      rootUri: pathToFileURL(this.project.root).href,
      workspaceFolders: [{ uri: pathToFileURL(this.project.root).href, name: path.basename(this.project.root) }],
      capabilities: { general: { positionEncodings: ['utf-16'] }, workspace: { configuration: true, workspaceFolders: true },
        textDocument: { synchronization: { didSave: false }, publishDiagnostics: { relatedInformation: true, versionSupport: true },
          definition: { linkSupport: true }, typeDefinition: { linkSupport: true }, implementation: { linkSupport: true }, hover: { contentFormat: ['markdown', 'plaintext'] }, documentSymbol: { hierarchicalDocumentSymbolSupport: true } } },
      initializationOptions: { untrustedWorkspace: true, experimental: { useUv: 'off' }, settings: this.settings },
    });
    this.capabilities = initialized.capabilities ?? {};
    if (this.capabilities.positionEncoding && this.capabilities.positionEncoding !== 'utf-16') throw new Error('ty did not negotiate UTF-16 positions');
    if (this.requireCapabilities && ['definitionProvider', 'referencesProvider', 'hoverProvider'].some(c => !this.capabilities[c])) throw new Error('ty server does not support the three required navigation capabilities');
    this.notify('initialized', {});
  }
  consume(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > MAX_FRAME) throw new Error('LSP message exceeds 8 MiB');
    while (true) {
      const end = this.buffer.indexOf('\r\n\r\n');
      if (end < 0) { if (this.buffer.length > 8192) throw new Error('LSP header exceeds 8 KiB'); return; }
      const headers = this.buffer.subarray(0, end).toString();
      const matches = [...headers.matchAll(/^content-length:\s*(\d+)\s*$/gim)];
      if (matches.length !== 1) throw new Error('Invalid LSP Content-Length');
      const length = Number(matches[0][1]);
      if (!Number.isSafeInteger(length) || length > MAX_FRAME) throw new Error('LSP message exceeds 8 MiB');
      if (this.buffer.length < end + 4 + length) return;
      const message = JSON.parse(this.buffer.subarray(end + 4, end + 4 + length));
      this.buffer = this.buffer.subarray(end + 4 + length);
      if (message.method === 'textDocument/publishDiagnostics' && message.id === undefined) {
        if (this.documents.has(message.params?.uri) && Array.isArray(message.params.diagnostics))
          this.publications.set(message.params.uri, { ...message.params, sequence: ++this.sequence, at: Date.now() });
      } else if (message.method && message.id !== undefined) this.serverRequest(message);
      else if (this.pending.has(message.id)) {
        const entry = this.pending.get(message.id); this.pending.delete(message.id); clearTimeout(entry.timer);
        if (message.error) entry.reject(new Error(`LSP ${message.error.code}: ${message.error.message}`)); else entry.resolve(message.result);
      }
    }
  }
  serverRequest(message) {
    let result;
    if (message.method === 'workspace/configuration') result = (message.params?.items ?? []).map(item => {
      if (!item.section || item.section === 'ty') return this.settings;
      if (!item.section.startsWith('ty.')) return null;
      return item.section.slice(3).split('.').reduce((o, k) => o?.[k], this.settings) ?? null;
    });
    else if (message.method === 'workspace/workspaceFolders') result = [{ uri: pathToFileURL(this.project.root).href, name: path.basename(this.project.root) }];
    else if (message.method === 'workspace/applyEdit') result = { applied: false, failureReason: 'Python LSP MVP is read-only; workspace edits are forbidden' };
    else if (['client/registerCapability', 'client/unregisterCapability', 'window/workDoneProgress/create'].includes(message.method)) result = null;
    else { this.send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Unsupported server request' } }); return; }
    this.send({ jsonrpc: '2.0', id: message.id, result });
  }
  send(message) {
    if (this.failure) throw this.failure;
    const body = Buffer.from(JSON.stringify(message));
    this.child.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
  }
  notify(method, params) { this.send({ jsonrpc: '2.0', method, params }); }
  request(method, params, timeout = this.timeoutMs) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`LSP timeout: ${method}`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ jsonrpc: '2.0', id, method, params }); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  fail(error) {
    this.failure ??= error;
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    this.pending.clear();
  }
  async sync(file) {
    const canonical = await realpath(file);
    if (!inside(this.project.root, file) || !inside(this.project.root, canonical) || !inside(this.project.workspace, canonical) || !supported.test(canonical)) throw new Error('Cannot mix LSP project roots or follow source symlinks outside the workspace');
    const text = await boundedText(canonical);
    const uri = pathToFileURL(canonical).href, previous = this.documents.get(uri), version = (previous?.version ?? 0) + 1;
    this.documents.set(uri, { version, text });
    if (previous) this.notify('textDocument/didChange', { textDocument: { uri, version }, contentChanges: [{ text }] });
    else this.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'python', version, text } });
    return uri;
  }
  position(uri, line, character) {
    const lines = this.documents.get(uri).text.split(/\r\n|\n|\r/);
    const text = lines[line - 1], column = character - 1;
    if (!Number.isInteger(line) || !Number.isInteger(character) || line < 1 || character < 1 || text === undefined || column > text.length) throw new Error('Position is outside the file; use 1-based UTF-16 line/character');
    if (column > 0 && /[\uD800-\uDBFF]/.test(text[column - 1]) && /[\uDC00-\uDFFF]/.test(text[column] ?? '')) throw new Error('UTF-16 position splits a surrogate pair');
    return { line: line - 1, character: column };
  }
  freshPublication(uri, floor) {
    const p = this.publications.get(uri);
    return Boolean(p && p.sequence > floor && p.version === this.documents.get(uri)?.version && Date.now() - p.at >= this.settleMs);
  }
  async diagnostics(files) {
    const floor = this.sequence, targets = [];
    for (const file of files) targets.push({ file, uri: await this.sync(file) });
    const deadline = Date.now() + this.diagnosticMs;
    while (Date.now() < deadline) {
      if (this.failure) throw this.failure;
      if (targets.every(({ uri }) => this.freshPublication(uri, floor))) break;
      await sleep(20);
    }
    return targets.map(({ file, uri }) => {
      const received = this.freshPublication(uri, floor), publication = this.publications.get(uri);
      return { file, status: received ? 'received' : 'timeout', version: this.documents.get(uri).version, diagnostics: received ? publication.diagnostics : [] };
    });
  }
  kill() {
    if (!this.child?.pid || this.child.exitCode !== null || this.child.signalCode !== null) return;
    try { if (process.platform !== 'win32') process.kill(-this.child.pid, 'SIGKILL'); else this.child.kill('SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  async close() {
    if (this.closed) return; this.closed = true;
    if (!this.child) return;
    if (this.child.exitCode === null && !this.failure) {
      try { await this.request('shutdown', null, 400); this.notify('exit'); } catch { /* force cleanup below */ }
    }
    if (this.child.exitCode === null && this.child.signalCode === null) await Promise.race([new Promise(r => this.child.once('close', r)), sleep(100)]);
    this.kill(); this.child.stdin.destroy(); this.fail(new Error('LSP session closed'));
  }
}
