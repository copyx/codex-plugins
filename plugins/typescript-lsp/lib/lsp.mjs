import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Each instance has one canonical project root and never accepts files outside it.
export class LspSession {
  constructor(project, { timeoutMs = 10000, diagnosticMs = 6000, settleMs = 400, command = process.env.TYPESCRIPT_LANGUAGE_SERVER ?? 'typescript-language-server' } = {}) {
    this.project = project;
    this.timeoutMs = timeoutMs;
    this.diagnosticMs = diagnosticMs;
    this.settleMs = settleMs;
    this.command = command;
    this.pending = new Map();
    this.documents = new Map();
    this.publications = new Map();
    this.sequence = 0;
    this.id = 0;
    this.buffer = Buffer.alloc(0);
  }

  async start() {
    if (this.closed) throw new Error('LSP session closed');
    this.child = spawn(this.command, ['--stdio'], { cwd: this.project.root, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stderr.on('data', b => { this.stderr = ((this.stderr ?? '') + b).slice(-4000); });
    this.child.stdin.on('error', error => this.fail(error));
    this.child.on('error', error => this.fail(error));
    this.child.on('exit', (code, signal) => this.fail(new Error(`LSP exited (${code ?? signal}): ${this.stderr ?? ''}`)));
    this.child.stdout.on('data', b => {
      try { this.consume(b); } catch (error) { this.fail(error); this.kill(); }
    });
    await this.request('initialize', {
      processId: process.pid,
      rootUri: pathToFileURL(this.project.root).href,
      workspaceFolders: [{ uri: pathToFileURL(this.project.root).href, name: path.basename(this.project.root) }],
      capabilities: { textDocument: { publishDiagnostics: { relatedInformation: true, versionSupport: true } } },
      initializationOptions: { tsserver: { path: this.project.tsserver }, preferences: { includeInlayParameterNameHints: 'none' } },
    });
    this.notify('initialized', {});
  }

  consume(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > 16 * 1024 * 1024) throw new Error('LSP message exceeds 16 MiB');
    while (true) {
      const end = this.buffer.indexOf('\r\n\r\n');
      if (end < 0) return;
      const match = /content-length:\s*(\d+)/i.exec(this.buffer.subarray(0, end).toString());
      if (!match) throw new Error('Invalid LSP Content-Length');
      const length = Number(match[1]);
      if (length > 16 * 1024 * 1024) throw new Error('LSP message exceeds 16 MiB');
      if (this.buffer.length < end + 4 + length) return;
      const message = JSON.parse(this.buffer.subarray(end + 4, end + 4 + length));
      this.buffer = this.buffer.subarray(end + 4 + length);
      if (message.method === 'textDocument/publishDiagnostics') {
        this.publications.set(message.params.uri, { ...message.params, sequence: ++this.sequence, at: Date.now() });
      } else if (message.method && message.id !== undefined) {
        const result = message.method === 'workspace/configuration' ? message.params.items.map(() => ({}))
          : message.method === 'workspace/workspaceFolders' ? [{ uri: pathToFileURL(this.project.root).href, name: path.basename(this.project.root) }] : null;
        this.send({ jsonrpc: '2.0', id: message.id, result });
      } else if (this.pending.has(message.id)) {
        const entry = this.pending.get(message.id);
        this.pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.error) entry.reject(new Error(message.error.message));
        else entry.resolve(message.result);
      }
    }
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
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP timeout: ${method}`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ jsonrpc: '2.0', id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  fail(error) {
    this.failure ??= error;
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    this.pending.clear();
  }

  async sync(file) {
    const relative = path.relative(this.project.root, file);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Cannot mix LSP project roots');
    const text = await readFile(file, 'utf8');
    const uri = pathToFileURL(file).href;
    const previous = this.documents.get(uri);
    const version = (previous?.version ?? 0) + 1;
    if (previous) this.notify('textDocument/didChange', { textDocument: { uri, version }, contentChanges: [{ text }] });
    else {
      const ext = path.extname(file).toLowerCase();
      const languageId = ext === '.tsx' ? 'typescriptreact' : ext === '.jsx' ? 'javascriptreact' : /\.[cm]?js$/.test(ext) ? 'javascript' : 'typescript';
      this.notify('textDocument/didOpen', { textDocument: { uri, languageId, version, text } });
    }
    this.documents.set(uri, { version });
    return uri;
  }

  async diagnostics(files) {
    const floor = this.sequence;
    const targets = [];
    for (const file of files) targets.push({ file, uri: await this.sync(file) });
    const deadline = Date.now() + this.diagnosticMs;
    while (Date.now() < deadline) {
      if (this.failure) throw this.failure;
      if (targets.every(({ uri }) => {
        const p = this.publications.get(uri);
        return p && p.sequence > floor && (p.version === undefined || p.version === this.documents.get(uri).version) && Date.now() - p.at >= this.settleMs;
      })) break;
      await sleep(40);
    }
    return targets.map(({ file, uri }) => {
      const p = this.publications.get(uri);
      const received = p && p.sequence > floor && (p.version === undefined || p.version === this.documents.get(uri).version) && Date.now() - p.at >= this.settleMs;
      return { file, status: received ? 'received' : 'timeout', diagnostics: received ? p.diagnostics : [] };
    });
  }

  kill() {
    if (!this.child?.pid) return;
    try {
      if (process.platform !== 'win32') process.kill(-this.child.pid, 'SIGKILL');
      else this.child.kill('SIGKILL');
    } catch { /* already exited */ }
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    if (!this.child) return;
    if (this.child.exitCode === null && !this.failure) {
      try { await this.request('shutdown', null, 600); this.notify('exit'); } catch { /* force cleanup below */ }
    }
    await Promise.race([new Promise(resolve => this.child.once('close', resolve)), sleep(300)]);
    this.kill();
    this.child.stdin.destroy();
    this.fail(new Error('LSP session closed'));
  }
}
