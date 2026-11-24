import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inside, resolveProject } from './project.mjs';

function ordered(value) {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => [k, ordered(value[k])]));
  return value;
}
export const fingerprint = value => `sha256:${createHash('sha256').update(JSON.stringify(ordered(value))).digest('hex')}`;
const textHash = text => `sha256:${createHash('sha256').update(text).digest('hex')}`;

export function offsetAt(text, position) {
  if (!Number.isInteger(position?.line) || position.line < 0 || !Number.isInteger(position?.character) || position.character < 0) throw new Error('Invalid UTF-16 position');
  const starts = [0];
  for (const match of text.matchAll(/\r\n|\r|\n/g)) starts.push(match.index + match[0].length);
  if (position.line >= starts.length) throw new Error('Position is outside the file');
  const start = starts[position.line];
  const end = position.line + 1 < starts.length ? starts[position.line + 1] : text.length;
  const length = text.slice(start, end).replace(/[\r\n]+$/, '').length;
  if (position.character > length) throw new Error('Character is outside the line');
  return start + position.character;
}
export function toLspRange(input, text) {
  const point = p => {
    if (!Number.isInteger(p?.line) || p.line < 1 || !Number.isInteger(p?.character) || p.character < 1) throw new Error('Range positions must be positive 1-based UTF-16 line/character values');
    return { line: p.line - 1, character: p.character - 1 };
  };
  const range = { start: point(input?.start), end: point(input?.end) };
  if (offsetAt(text, range.start) > offsetAt(text, range.end)) throw new Error('Range end must not precede start');
  return range;
}

export async function captureBasis(project, tool, request, anchorText, diagnostics = []) {
  const anchorBytes = await readFile(project.file);
  if (anchorBytes.toString('utf8') !== anchorText) throw new Error('Preview anchor changed while the language server was reading it');
  const packageText = await readFile(path.join(path.dirname(project.tsserver), '../package.json'), 'utf8');
  return {
    schema_version: 1, tool, request,
    scope: { workspace_root: project.workspace, project_root: project.root, config: project.config, anchor_file: project.file },
    anchor_sha256: textHash(anchorBytes), config_sha256: project.config ? textHash(await readFile(project.config)) : null,
    typescript: { tsserver_path: project.tsserver, tsserver_sha256: textHash(await readFile(project.tsserver)), package_sha256: textHash(packageText), version: JSON.parse(packageText).version },
    diagnostics,
  };
}
export async function assertBasisCurrent(basis) {
  const project = await resolveProject(basis.request.file, basis.request.workspace_root);
  const current = await captureBasis(project, basis.tool, basis.request, await readFile(project.file, 'utf8'), basis.diagnostics);
  const { targets, ...original } = basis;
  if (fingerprint(current) !== fingerprint(original)) throw new Error('Preview basis changed during the request');
  if (targets) for (const target of targets) {
    const { text, ...now } = await targetInfo(target.uri, basis.scope);
    if (fingerprint(now) !== fingerprint(target)) throw new Error('Preview target changed during the request');
  }
}

async function canonicalTarget(file) {
  let current = file;
  const tail = [];
  while (true) {
    try { return path.join(await realpath(current), ...tail.reverse()); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      tail.push(path.basename(current)); current = parent;
    }
  }
}
async function targetInfo(uri, scope) {
  const result = { uri, file: null, workspace_boundary: 'unknown', project_boundary: 'unknown', exists: null, sha256: null, read_status: 'unsupported_uri' };
  try {
    result.file = await canonicalTarget(fileURLToPath(uri));
    result.workspace_boundary = inside(scope.workspace_root, result.file) ? 'inside' : 'outside';
    result.project_boundary = inside(scope.project_root, result.file) ? 'inside' : 'outside';
    if (result.workspace_boundary === 'outside') { result.read_status = 'outside_workspace'; return result; }
    try {
      const bytes = await readFile(result.file);
      return { ...result, exists: true, sha256: textHash(bytes), read_status: 'read', text: bytes.toString('utf8') };
    } catch (error) {
      result.exists = error.code === 'ENOENT' ? false : null;
      result.read_status = error.code === 'ENOENT' ? 'missing' : 'unreadable';
      return result;
    }
  } catch { return result; }
}

export async function buildPreview(basis, action) {
  const files = [], resource_operations = [], targets = new Map(), issues = new Set();
  const inspect = async uri => {
    const target = await targetInfo(uri, basis.scope);
    const { text, ...metadata } = target;
    targets.set(uri, metadata);
    if (target.workspace_boundary !== 'inside') issues.add(target.workspace_boundary === 'outside' ? 'outside_workspace' : 'unresolved_uri');
    if (target.project_boundary === 'outside') issues.add('outside_project');
    return target;
  };
  const textEdits = async (uri, edits, document_version, source) => {
    const { text, ...target } = await inspect(uri);
    const normalized = [];
    if (!Array.isArray(edits)) { issues.add('unsupported_edit'); edits = []; }
    for (const edit of edits) {
      let old_text = null;
      if (edit.annotationId !== undefined) issues.add('change_annotations_require_policy');
      try {
        if (typeof edit.newText !== 'string') throw new Error('Invalid replacement');
        if (text !== undefined) {
          const start = offsetAt(text, edit.range?.start), end = offsetAt(text, edit.range?.end);
          if (end < start) throw new Error('Invalid edit range');
          old_text = text.slice(start, end);
        }
      } catch { issues.add('invalid_text_edit'); }
      normalized.push({ range: edit.range ?? null, new_text: edit.newText ?? null, old_text });
    }
    if (target.read_status !== 'read') issues.add('target_snapshot_unavailable');
    files.push({ ...target, document_version, source, edits: normalized });
  };
  const edit = action.edit;
  if (edit?.changeAnnotations && Object.keys(edit.changeAnnotations).length) issues.add('change_annotations_require_policy');
  if (edit?.changes) for (const uri of Object.keys(edit.changes).sort()) await textEdits(uri, edit.changes[uri], null, 'changes');
  if (edit?.documentChanges) for (const change of edit.documentChanges) {
    if (change.textDocument) await textEdits(change.textDocument.uri, change.edits, change.textDocument.version ?? null, 'documentChanges');
    else {
      const uris = change.kind === 'rename' ? [change.oldUri, change.newUri] : [change.uri];
      const locations = [];
      for (const uri of uris) { const { text, ...target } = await inspect(uri); locations.push(target); }
      resource_operations.push({ kind: change.kind ?? 'unsupported', targets: locations, options: change.options ?? null });
      issues.add('resource_operations_require_policy');
    }
  }
  if (edit?.changes && edit?.documentChanges) issues.add('mixed_edit_forms');
  const command = typeof action.command === 'string' ? { command: action.command, arguments: action.arguments ?? [] } : action.command;
  const hasCommand = typeof command?.command === 'string';
  const hasEdits = files.some(f => f.edits.length) || resource_operations.length > 0;
  const needsResolve = action.data !== undefined;
  const status = action.disabled ? 'disabled' : hasCommand ? 'requires_command' : needsResolve ? 'requires_resolve' : hasEdits ? 'edit_available' : 'unavailable';
  const fullBasis = { ...basis, targets: [...targets.values()].sort((a, b) => String(a.uri).localeCompare(String(b.uri))) };
  const identity = { title: action.title ?? '', kind: action.kind ?? null, disabled: action.disabled ?? null, command: hasCommand ? command : null, edit: edit ?? null, resolve_data: action.data ?? null, needs_resolve: needsResolve };
  return {
    preview_version: 1, preview_only: true, title: action.title ?? '', kind: action.kind ?? null, status,
    selection_id: fingerprint({ basis: fullBasis, action: identity }),
    action_fingerprint: fingerprint(identity), basis: fullBasis,
    command: hasCommand ? { name: command.command, fingerprint: fingerprint(command) } : null,
    needs_resolve: needsResolve, resolve_data_fingerprint: needsResolve ? fingerprint(action.data) : null, disabled_reason: action.disabled?.reason ?? null,
    edit: { files, resource_operations }, issues: [...issues].sort(),
  };
}

export async function codeActionsPreview(project, session, args, uri, published, candidates = null) {
  const text = session.documents.get(uri).text;
  const range = toLspRange(args.range, text);
  const start = offsetAt(text, range.start), end = offsetAt(text, range.end);
  const diagnostics = published.filter(d => {
    const a = offsetAt(text, d.range.start), b = offsetAt(text, d.range.end);
    return start === end ? a <= start && start <= b : a === b ? start <= a && a < end : a < end && start < b;
  });
  const request = { workspace_root: project.workspace, file: project.file, range: {
    start: { line: range.start.line + 1, character: range.start.character + 1 },
    end: { line: range.end.line + 1, character: range.end.character + 1 },
  } };
  const basis = await captureBasis(project, 'code_actions_preview', request, text, diagnostics);
  const actions = await session.request('textDocument/codeAction', { textDocument: { uri }, range, context: { diagnostics, only: ['quickfix'] } });
  const result = [];
  for (const action of actions ?? []) {
    const preview = await buildPreview(basis, action);
    result.push(preview);
    if (candidates) candidates.push({ action, preview });
  }
  await assertBasisCurrent(basis);
  for (const preview of result) await assertBasisCurrent(preview.basis);
  return { project_root: project.root, config: project.config, diagnostics, result };
}

export async function renamePreview(project, session, args, uri) {
  const text = session.documents.get(uri).text;
  const position = { line: args.line - 1, character: args.character - 1 };
  offsetAt(text, position);
  const request = { workspace_root: project.workspace, file: project.file, line: args.line, character: args.character, new_name: args.new_name };
  const basis = await captureBasis(project, 'rename_preview', request, text);
  const edit = await session.request('textDocument/rename', { textDocument: { uri }, position, newName: args.new_name });
  const output = { project_root: project.root, config: project.config, status: 'not_renamable', reason: 'No rename edits are available at this position', result: null };
  if (edit) {
    const preview = await buildPreview(basis, { title: `Rename to ${args.new_name}`, edit });
    if (preview.status !== 'unavailable') { output.status = 'preview_available'; output.reason = null; output.result = preview; }
    await assertBasisCurrent(preview.basis);
  }
  await assertBasisCurrent(basis);
  return output;
}
