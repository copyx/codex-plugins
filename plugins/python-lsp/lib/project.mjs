import { realpath, stat, readFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const supported = /\.pyi?$/;
export function inside(root, file) {
  const relative = path.relative(root, file);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
async function exists(file) {
  try { await stat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
async function boundedText(file, limit = 1024 * 1024) {
  if ((await stat(file)).size > limit) throw new Error(`File exceeds ${limit} bytes: ${file}`);
  const bytes = await readFile(file);
  if (bytes.length > limit) throw new Error(`File exceeds ${limit} bytes: ${file}`);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Error(`Expected a UTF-8 file: ${file}`); }
}
// This is a conservative metadata preflight, not a TOML configuration parser.
// ty parses and validates the complete file. Ambiguous environment encodings
// fail closed rather than silently overriding a project environment.
function configMetadata(text, pyproject) {
  const prefix = pyproject ? ['tool', 'ty'] : [];
  let table = [], hasTy = !pyproject, python;
  const keyPath = value => {
    const parts = value.match(/"(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+|\./g);
    if (!parts || parts.filter(p => p !== '.').length * 2 - 1 !== parts.length) throw new Error('Unsupported TOML key; use conventional [tool.ty.environment] / [environment] tables');
    return parts.filter(p => p !== '.').map(p => p.startsWith('"') ? JSON.parse(p) : p.startsWith("'") ? p.slice(1, -1) : p);
  };
  // Remove comments and string contents from structural scanning; preserve
  // newlines and quotes for single-line environment string extraction below.
  let clean = '', quote = null, triple = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (triple && text.slice(i, i + 3) === quote.repeat(3) && !escaped) { clean += '   '; i += 2; quote = null; triple = false; }
      else if (!triple && c === quote && !escaped) { clean += c; quote = null; }
      else { clean += c === '\n' ? '\n' : triple ? ' ' : c; }
      if (quote === '"' && c === '\\') escaped = !escaped; else escaped = false;
    } else if (c === '#') { while (i < text.length && text[i] !== '\n') i++; clean += '\n'; }
    else if (c === '"' || c === "'") {
      quote = c; triple = text.slice(i, i + 3) === c.repeat(3);
      if (triple) { clean += '   '; i += 2; } else clean += c;
    } else clean += c;
  }
  for (const raw of clean.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('[')) {
      if (line.startsWith('[[')) { table = ['__array_table__']; continue; }
      if (!line.endsWith(']')) continue; // multiline array values, validated by ty
      table = keyPath(line.slice(1, -1));
      if (table.slice(0, prefix.length).join('.') === prefix.join('.')) hasTy = true;
      continue;
    }
    const assignment = /^((?:"(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_. -])+?)\s*=\s*(.*)$/.exec(line);
    if (!assignment) continue;
    const keys = [...table, ...keyPath(assignment[1].trim())];
    if (pyproject && (keys.join('.') === 'tool' || keys.join('.') === 'tool.ty')) throw new Error('Use an explicit [tool.ty.environment] table instead of inline tool/ty tables');
    if (keys.slice(0, prefix.length).join('.') !== prefix.join('.')) continue;
    hasTy = true;
    const local = keys.slice(prefix.length).join('.');
    if (local === 'environment') throw new Error('Use an explicit environment table instead of an inline environment table');
    if (local === 'environment.python') {
      const value = assignment[2].trim();
      if (/^"(?:[^"\\]|\\.)*"$/.test(value)) python = JSON.parse(value);
      else if (/^'[^']*'$/.test(value)) python = value.slice(1, -1);
      else throw new Error('Use a single-line literal environment.python path in the environment table');
      if (!python || /[$~\0\r\n]/.test(python)) throw new Error('environment.python must be a concrete path without variable/tilde expansion');
    }
  }
  return { hasTy, python };
}

async function environmentAt(input, base, source) {
  const candidate = path.resolve(base, input);
  let directory = candidate;
  if (!(await exists(candidate))) throw new Error(`Python environment not found: ${candidate}; set PYTHON_LSP_PYTHON to a venv directory or its Python interpreter`);
  if (!(await stat(candidate)).isDirectory()) {
    if (!/^python(?:3(?:\.\d+)?)?(?:\.exe)?$/.test(path.basename(candidate))) throw new Error('Python environment interpreter must be named python/python3');
    directory = path.dirname(path.dirname(candidate));
  }
  directory = await realpath(directory);
  const config = path.join(directory, 'pyvenv.cfg');
  if (!(await exists(config))) throw new Error(`Python environment is not a verifiable venv (pyvenv.cfg missing): ${directory}`);
  const interpreter = (await stat(candidate)).isDirectory()
    ? path.join(directory, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python') : candidate;
  try { await access(interpreter, constants.X_OK); } catch { throw new Error(`Python environment interpreter missing or not executable: ${interpreter}`); }
  const metadata = await boundedText(config, 65536);
  const version = /^version\s*=\s*(\d+\.\d+(?:\.\d+)?)/m.exec(metadata)?.[1] ?? null;
  return { path: directory, interpreter, version, source };
}

export async function resolveProject(input, workspace, { env = process.env } = {}) {
  if (typeof workspace !== 'string' || !path.isAbsolute(workspace)) throw new Error('workspace_root must be absolute');
  const lexicalBoundary = path.resolve(workspace), boundary = await realpath(workspace);
  const lexical = path.resolve(lexicalBoundary, input);
  if (!inside(lexicalBoundary, lexical) && !inside(boundary, lexical)) throw new Error(`File is outside workspace_root: ${input}`);
  const file = await realpath(lexical);
  if (!inside(boundary, file)) throw new Error(`File symlink is outside workspace_root: ${input}`);
  if (!supported.test(file) || !(await stat(file)).isFile()) throw new Error('Expected a .py or .pyi source file');
  if (/^# \/\/\/ script\s*$/m.test(await boundedText(file))) throw new Error('PEP 723 standalone-script environments are not supported in this MVP; use a regular project config and explicit venv');
  let root = boundary, config = null, metadata = {}, generic = null;
  for (let dir = path.dirname(file); inside(boundary, dir); dir = path.dirname(dir)) {
    for (const name of ['ty.toml', 'pyproject.toml']) {
      const candidate = path.join(dir, name);
      if (!(await exists(candidate))) continue;
      if (!inside(boundary, await realpath(candidate))) throw new Error('Project config symlink is outside workspace_root');
      const info = configMetadata(await boundedText(candidate), name === 'pyproject.toml');
      generic ??= { root: dir, config: candidate };
      if (info.hasTy) { root = dir; config = candidate; metadata = info; break; }
    }
    if (config || dir === boundary) break;
  }
  if (!config && generic) root = generic.root;
  // Without ty-specific config, pin an empty bundled file to stop ty from
  // inheriting arbitrary ancestor config outside the selected workspace.
  const configurationFile = config?.endsWith('ty.toml') ? config : config ? null : fileURLToPath(new URL('../defaults.toml', import.meta.url));
  const explicit = env.PYTHON_LSP_PYTHON ? await environmentAt(env.PYTHON_LSP_PYTHON, root, 'PYTHON_LSP_PYTHON') : null;
  const configured = metadata.python ? await environmentAt(metadata.python, root, 'project config') : null;
  if (explicit && configured && explicit.path !== configured.path) throw new Error(`Python environment conflict: PYTHON_LSP_PYTHON=${explicit.path}, project config=${configured.path}`);
  const environment = explicit ?? configured ?? (await exists(path.join(root, '.venv')) ? await environmentAt('.venv', root, 'project .venv') : null);
  if (!environment) throw new Error('Set PYTHON_LSP_PYTHON to the project venv, or prepare a project .venv; no global Python fallback or automatic installation is used');
  if (env.VIRTUAL_ENV && !explicit) {
    const active = await realpath(env.VIRTUAL_ENV).catch(() => path.resolve(env.VIRTUAL_ENV));
    if (active !== environment.path) throw new Error('VIRTUAL_ENV points to a different environment (mismatch); unset it or explicitly set PYTHON_LSP_PYTHON');
  }
  return { file, workspace: boundary, root, config, environment, configurationFile };
}

export function patchFiles(patch) {
  const files = new Set(); let current;
  for (const line of patch.split(/\r?\n/)) {
    const match = /^\*\*\* (Add File|Update File|Delete File|Move to): (.+)$/.exec(line);
    if (!match) continue;
    const [, kind, file] = match;
    if (kind === 'Delete File') { files.delete(file); current = undefined; }
    else if (kind === 'Move to') { if (current) files.delete(current); files.add(file); current = file; }
    else { files.add(file); current = file; }
  }
  return [...files].filter(file => supported.test(file));
}

export async function markLocations(result, workspace) {
  if (Array.isArray(result)) return Promise.all(result.map(r => markLocations(r, workspace)));
  if (!result || typeof result !== 'object') return result;
  const uri = result.uri ?? result.targetUri ?? result.location?.uri;
  if (!uri) return result;
  let boundary = 'external_uri';
  try {
    const file = fileURLToPath(uri);
    if (!inside(workspace, file)) boundary = 'outside';
    else boundary = inside(workspace, await realpath(file)) ? 'inside' : 'outside';
  } catch { if (uri.startsWith('file:')) boundary = 'unresolved'; }
  return { ...result, workspace_boundary: boundary };
}

export { boundedText };
