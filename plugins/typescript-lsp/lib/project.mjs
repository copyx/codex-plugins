import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

export const supported = /\.(?:[cm]?[jt]sx?)$/i;
export function inside(root, file) {
  const relative = path.relative(root, file);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
async function isFile(file) {
  try { return (await stat(file)).isFile(); } catch { return false; }
}

export async function resolveProject(input, workspace) {
  if (!path.isAbsolute(workspace)) throw new Error('workspace_root must be absolute');
  const boundary = await realpath(workspace);
  const lexical = path.resolve(boundary, input);
  if (!inside(boundary, lexical)) throw new Error(`File is outside workspace_root: ${input}`);
  const file = await realpath(lexical);
  if (!inside(boundary, file)) throw new Error(`File symlink is outside workspace_root: ${input}`);
  if (!supported.test(file) || !(await isFile(file))) throw new Error(`Unsupported source file: ${input}`);
  let root, config, tsserver;
  for (let dir = path.dirname(file); inside(boundary, dir); dir = path.dirname(dir)) {
    if (!config) {
      for (const name of ['tsconfig.json', 'jsconfig.json']) {
        if (await isFile(path.join(dir, name))) { root = dir; config = path.join(dir, name); break; }
      }
    }
    if (!tsserver) {
      const candidate = path.join(dir, 'node_modules/typescript/lib/tsserver.js');
      if (await isFile(candidate)) tsserver = await realpath(candidate);
    }
    if (dir === boundary) break;
  }
  if (!tsserver) throw new Error('Project TypeScript not found in node_modules; install TypeScript in this workspace');
  return { file, workspace: boundary, root: root ?? boundary, config: config ?? null, tsserver };
}

export function patchFiles(patch) {
  const files = new Set();
  let current;
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
