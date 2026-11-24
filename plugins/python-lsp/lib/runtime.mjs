import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export function runtimeConfigPath(home = homedir()) {
  if (typeof home !== 'string' || !path.isAbsolute(home)) throw new Error('Cannot locate an absolute user home; set PYTHON_LSP_TY explicitly');
  return path.join(home, '.config/codex-python-lsp/config.json');
}
const MAX_CONFIG = 16 * 1024;
function absoluteCommand(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\0\r\n]/.test(value)) throw new Error(`${label} must be an absolute ty 0.0.109 executable path`);
  return value;
}
function ownedPrivateWrite(info, label) {
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) throw new Error(`${label} must be owned by the current user`);
  if (info.mode & 0o022) throw new Error(`${label} must not be group/world writable`);
}
// Both MCP and PostToolUse create LspSession instances, so they share this
// user-only configuration. No workspace, PATH, CODEX_HOME or XDG lookup occurs.
// Read per session rather than caching: a running bridge can use updated settings.
export async function resolveTyRuntime({ env = process.env, home = homedir() } = {}) {
  if (env.PYTHON_LSP_TY !== undefined) return { command: absoluteCommand(env.PYTHON_LSP_TY, 'PYTHON_LSP_TY'), source: 'environment', config: null };
  const config = runtimeConfigPath(home);
  let handle;
  try {
    const directory = await lstat(path.dirname(config));
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error(`${path.dirname(config)} must be a regular directory, not a symlink`);
    ownedPrivateWrite(directory, path.dirname(config));
    const info = await lstat(config);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${config} must be a regular file, not a symlink`);
    handle = await open(config, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile()) throw new Error(`${config} must be a regular file`);
    ownedPrivateWrite(opened, config);
    if (opened.size > MAX_CONFIG) throw new Error(`${config} exceeds 16 KiB`);
    const bytes = await handle.readFile();
    if (bytes.length > MAX_CONFIG) throw new Error(`${config} exceeds 16 KiB`);
    let settings;
    try { settings = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw new Error(`${config} must contain UTF-8 JSON: {"ty_path":"/absolute/path/to/ty"}`); }
    if (!settings || Array.isArray(settings) || typeof settings !== 'object' || Object.keys(settings).length !== 1 || !Object.hasOwn(settings, 'ty_path')) throw new Error(`${config} accepts exactly one key: ty_path`);
    return { command: absoluteCommand(settings.ty_path, `${config} ty_path`), source: 'user_config', config };
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`Set PYTHON_LSP_TY to the absolute ty 0.0.109 executable path, or create ${config} with {"ty_path":"/absolute/path/to/ty"}; no automatic install or PATH fallback`);
    throw error;
  } finally { await handle?.close(); }
}
