import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inside, supported, resolveProject } from './project.mjs';
import { readRegularBytes, protectedPath, pythonText } from './source.mjs';

const MAX_TEXT = 1024 * 1024;
const MAX_ACTIONS = 20, MAX_TARGETS = 20, MAX_EDITS = 200;
function ordered(value) {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => [k, ordered(value[k])]));
  return value;
}
const hash = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
export const fingerprint = value => hash(JSON.stringify(ordered(value)));
const clone = value => JSON.parse(JSON.stringify(value));
export function offsetAt(text, point) {
  if (!Number.isSafeInteger(point?.line) || point.line < 0 || !Number.isSafeInteger(point?.character) || point.character < 0) throw new Error('Invalid UTF-16 position');
  const starts = [0];
  for (const match of text.matchAll(/\r\n|\r|\n/g)) starts.push(match.index + match[0].length);
  if (point.line >= starts.length) throw new Error('Position is outside the file');
  const start = starts[point.line], end = point.line + 1 < starts.length ? starts[point.line + 1] : text.length;
  const line = text.slice(start, end).replace(/[\r\n]+$/, '');
  if (point.character > line.length) throw new Error('Character is outside the line');
  if (point.character > 0 && /[\uD800-\uDBFF]/.test(line[point.character - 1]) && /[\uDC00-\uDFFF]/.test(line[point.character] ?? '')) throw new Error('UTF-16 position splits a surrogate pair');
  return start + point.character;
}
function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k));
}
export function toLspRange(input, text) {
  if (!exactKeys(input, ['start', 'end'])) throw new Error('Expected only range.start and range.end');
  const point = p => {
    if (!exactKeys(p, ['line', 'character']) || !Number.isSafeInteger(p.line) || p.line < 1 || !Number.isSafeInteger(p.character) || p.character < 1) throw new Error('Range requires positive 1-based UTF-16 line/character');
    return { line: p.line - 1, character: p.character - 1 };
  };
  const range = { start: point(input.start), end: point(input.end) };
  if (offsetAt(text, range.start) > offsetAt(text, range.end)) throw new Error('Range end must not precede start');
  return range;
}
export function selectDiagnostics(text, range, diagnostics) {
  const start = offsetAt(text, range.start), end = offsetAt(text, range.end);
  return diagnostics.filter(d => {
    const a = offsetAt(text, d.range?.start), b = offsetAt(text, d.range?.end);
    if (a > b) throw new Error('Invalid published diagnostic range');
    return start === end ? (a === b ? a === start : a <= start && start < b) : (a === b ? start <= a && a < end : a < end && start < b);
  });
}
async function readSnapshot(file, limit = MAX_TEXT) {
  const { bytes, stat } = await readRegularBytes(file, limit);
  return { bytes, metadata: { sha256: hash(bytes), byte_length: bytes.length, mode: stat.mode & 0o777, device: stat.dev, inode: stat.ino } };
}
async function fileIdentity(file, { optional = false, workspace = null, limit = MAX_TEXT } = {}) {
  try {
    const canonical = await realpath(file);
    if (workspace && (!inside(workspace, path.resolve(file)) || !inside(workspace, canonical))) throw new Error('Preview metadata is outside workspace');
    const { metadata } = await readSnapshot(canonical, limit);
    return { file: path.resolve(file), canonical_file: canonical, exists: true, ...metadata };
  } catch (error) {
    if (optional && error.code === 'ENOENT') return { file: path.resolve(file), exists: false, sha256: null };
    throw error;
  }
}
async function canonicalTarget(file) {
  let current = file; const tail = [];
  while (true) {
    try { return path.join(await realpath(current), ...tail.reverse()); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(current); if (parent === current) throw error;
      tail.push(path.basename(current)); current = parent;
    }
  }
}
async function targetInfo(uri, basis) {
  const result = { uri, file: null, workspace_boundary: 'unknown', project_boundary: 'unknown', exists: null, sha256: null, read_status: 'unsupported_uri' };
  let lexical;
  try {
    const parsed = new URL(uri); if (parsed.protocol !== 'file:' || parsed.search || parsed.hash) return result;
    lexical = fileURLToPath(parsed);
    if (!inside(basis.scope.workspace_root, lexical)) return { ...result, file: lexical, workspace_boundary: 'outside', project_boundary: 'outside', read_status: 'outside_workspace' };
    result.file = await canonicalTarget(lexical);
    result.workspace_boundary = inside(basis.scope.workspace_root, result.file) ? 'inside' : 'outside';
    result.project_boundary = inside(basis.scope.project_root, lexical) && inside(basis.scope.project_root, result.file) ? 'inside' : 'outside';
    if (result.workspace_boundary !== 'inside') return { ...result, read_status: 'outside_workspace' };
    if (protectedPath(basis.scope.workspace_root, lexical) || protectedPath(basis.scope.workspace_root, result.file)) return { ...result, read_status: 'protected_path' };
    if (result.file !== basis.scope.anchor_file && basis.environment?.path && inside(basis.environment.path, result.file)) return { ...result, read_status: 'environment_source' };
    if (!supported.test(lexical) || !supported.test(result.file)) return { ...result, read_status: 'unsupported_source' };
  } catch { return result; }
  try {
    const { bytes, metadata } = await readSnapshot(result.file);
    if (await realpath(lexical) !== result.file) throw new Error('Target symlink changed while snapshotting');
    let text;
    try { text = pythonText(bytes); }
    catch (error) { return { ...result, exists: true, read_status: error.code === 'INVALID_UTF8' ? 'invalid_utf8' : 'unsupported_encoding', source_error: error.message }; }
    return { ...result, exists: true, ...metadata, bom: bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), read_status: 'read', text };
  } catch (error) {
    if (/changed while/.test(error.message)) throw error;
    return { ...result, exists: error.code === 'ENOENT' ? false : null, read_status: error.code === 'ENOENT' ? 'missing' : 'unreadable' };
  }
}
export async function captureBasis(project, session, tool, request, anchorText, diagnostics = [], operationContext = null) {
  const scope = { workspace_root: project.workspace, project_root: project.root, config: project.config, anchor_file: project.file };
  const environment = { ...project.environment,
    interpreter: await fileIdentity(project.environment.interpreter, { limit: 128 * MAX_TEXT }),
    pyvenv_config: await fileIdentity(path.join(project.environment.path, 'pyvenv.cfg')),
    identity_scope: 'venv_metadata_and_interpreter_not_all_packages',
  };
  const anchor = await targetInfo(pathToFileURL(project.file).href, { scope, environment });
  if (anchor.read_status !== 'read' || anchor.text !== anchorText) throw new Error(`Preview anchor changed or is unavailable (${anchor.read_status}${anchor.source_error ? ': ' + anchor.source_error : ''})`);
  const metadata = []; let count = 0;
  for (let dir = path.dirname(project.file); inside(project.workspace, dir); dir = path.dirname(dir)) {
    if (++count > 64) throw new Error('Preview metadata directory limit exceeded');
    for (const name of ['pyproject.toml', 'ty.toml']) metadata.push(await fileIdentity(path.join(dir, name), { optional: true, workspace: project.workspace }));
    if (dir === project.workspace) break;
  }
  const executable = await fileIdentity(session.command, { limit: 128 * MAX_TEXT });
  const { text, ...anchorMetadata } = anchor;
  return {
    schema_version: 1, tool, request: clone(request), scope, anchor: anchorMetadata, anchor_sha256: anchor.sha256,
    ...(operationContext === null ? {} : { operation_context: clone(operationContext) }),
    document_version: session.documents.get(pathToFileURL(project.file).href)?.version ?? null,
    project_metadata: metadata, configuration_file: project.configurationFile ? await fileIdentity(project.configurationFile) : null,
    environment,
    server: { name: 'ty', version: session.serverVersion ?? 'ty 0.0.109', executable: executable.canonical_file, executable_sha256: executable.sha256,
      arguments: ['server'], untrusted_workspace: true, use_uv: 'off', settings: clone(session.settings), code_action_capability: clone(session.capabilities.codeActionProvider ?? null),
      runtime_source: session.runtime.source, runtime_config: session.runtime.config ? await fileIdentity(session.runtime.config, { limit: 16384 }) : null },
    preview_bridge_sha256: (await fileIdentity(fileURLToPath(import.meta.url))).sha256,
    diagnostics: clone(diagnostics).sort((a, b) => fingerprint(a).localeCompare(fingerprint(b))),
  };
}
export async function assertBasisCurrent(basis, session) {
  const project = await resolveProject(basis.request.file, basis.request.workspace_root);
  const uri = pathToFileURL(project.file).href, document = session.documents.get(uri);
  if (!document) throw new Error('Preview anchor session changed');
  const current = await captureBasis(project, session, basis.tool, basis.request, document.text, basis.diagnostics, basis.operation_context ?? null);
  const { targets, ...original } = basis;
  if (fingerprint(current) !== fingerprint(original)) throw new Error('Preview basis changed during request');
  for (const target of targets ?? []) {
    const { text, ...now } = await targetInfo(target.uri, basis);
    if (fingerprint(now) !== fingerprint(target)) throw new Error('Preview target changed during request');
  }
}
function rangeShape(range) {
  const point = p => Number.isSafeInteger(p?.line) && p.line >= 0 && Number.isSafeInteger(p?.character) && p.character >= 0;
  return range && point(range.start) && point(range.end) && (range.start.line < range.end.line || (range.start.line === range.end.line && range.start.character <= range.end.character));
}
export async function buildPreview(basis, action) {
  if (!action || typeof action !== 'object' || Array.isArray(action) || typeof action.title !== 'string' || (action.kind !== undefined && typeof action.kind !== 'string')) throw new Error('Invalid codeAction candidate');
  if (action.disabled !== undefined && (typeof action.disabled !== 'object' || typeof action.disabled?.reason !== 'string')) throw new Error('Invalid disabled codeAction');
  const files = [], resource_operations = [], targets = new Map(), spans = new Map(), issues = new Set(); let editCount = 0, textBytes = 0;
  const inspect = async uri => {
    if (!targets.has(uri)) {
      if (targets.size >= MAX_TARGETS) throw new Error('Preview target limit exceeded (20); narrow the range');
      const target = await targetInfo(uri, basis); targets.set(uri, target);
    }
    const target = targets.get(uri);
    if (target.workspace_boundary !== 'inside') issues.add(target.workspace_boundary === 'outside' ? 'outside_workspace' : 'unresolved_uri');
    if (target.project_boundary === 'outside') issues.add('outside_project');
    return target;
  };
  const textEdits = async (uri, edits, document_version, source) => {
    const { text, ...target } = await inspect(uri), normalized = [], replacements = []; let valid = true;
    if (!Array.isArray(edits)) { issues.add('unsupported_text_edits'); edits = []; }
    if (document_version !== null && (!Number.isSafeInteger(document_version) || document_version < 0 || target.file !== basis.scope.anchor_file || document_version !== basis.document_version)) issues.add('unverified_document_version');
    if (target.read_status !== 'read') issues.add('target_snapshot_unavailable');
    for (const edit of edits) {
      if (++editCount > MAX_EDITS) throw new Error('Preview edit limit exceeded (200)');
      let old_text = null;
      if (edit?.annotationId !== undefined) issues.add('change_annotations_require_policy');
      try {
        if (!rangeShape(edit?.range) || typeof edit.newText !== 'string') throw new Error('Invalid edit');
        if (text !== undefined) {
          const start = offsetAt(text, edit.range.start), end = offsetAt(text, edit.range.end);
          replacements.push({ start, end, newText: edit.newText });
          old_text = text.slice(start, end);
          if (!spans.has(target.file)) spans.set(target.file, []);
          const previous = spans.get(target.file);
          if (previous.some(p => start === end ? (p.start === p.end ? start === p.start : p.start <= start && start < p.end) : p.start === p.end ? start <= p.start && p.start < end : p.start < end && start < p.end)) issues.add('overlapping_text_edits');
          previous.push({ start, end });
        }
      } catch { issues.add('invalid_text_edit'); valid = false; }
      textBytes += Buffer.byteLength(typeof edit?.newText === 'string' ? edit.newText : '') + Buffer.byteLength(old_text ?? '');
      if (textBytes > MAX_TEXT) throw new Error('Preview text limit exceeded (1 MiB); narrow the range');
      normalized.push({ range: edit?.range ?? null, new_text: edit?.newText ?? null, old_text, ...(edit?.annotationId === undefined ? {} : { annotation_id: edit.annotationId }) });
    }
    if (text !== undefined && valid && !issues.has('overlapping_text_edits')) {
      let output = text;
      for (const edit of replacements.sort((a, b) => b.start - a.start || b.end - a.end)) output = output.slice(0, edit.start) + edit.newText + output.slice(edit.end);
      try { pythonText(Buffer.from((target.bom ? '\uFEFF' : '') + output, 'utf8')); }
      catch { issues.add('unsupported_result_encoding'); }
    }
    files.push({ ...target, document_version, source, edits: normalized });
  };
  const edit = action.edit;
  if (edit !== undefined && (!edit || typeof edit !== 'object' || Array.isArray(edit))) issues.add('unsupported_workspace_edit');
  if (edit && typeof edit === 'object' && Object.keys(edit).some(k => !['changes', 'documentChanges', 'changeAnnotations'].includes(k))) issues.add('unsupported_workspace_edit');
  if (edit?.changeAnnotations && Object.keys(edit.changeAnnotations).length) issues.add('change_annotations_require_policy');
  if (edit?.changes) {
    if (typeof edit.changes !== 'object' || Array.isArray(edit.changes)) issues.add('unsupported_workspace_edit');
    else for (const uri of Object.keys(edit.changes).sort()) await textEdits(uri, edit.changes[uri], null, 'changes');
  }
  if (edit?.documentChanges) {
    if (!Array.isArray(edit.documentChanges)) issues.add('unsupported_workspace_edit');
    else for (const change of edit.documentChanges) {
      if (change?.textDocument) {
        if (!Object.hasOwn(change.textDocument, 'version')) issues.add('unverified_document_version');
        await textEdits(change.textDocument.uri, change.edits, change.textDocument.version ?? null, 'documentChanges');
      }
      else {
        if (resource_operations.length >= MAX_TARGETS) throw new Error('Preview resource limit exceeded (20)');
        const kind = change?.kind ?? 'unsupported', uris = kind === 'rename' ? [change.oldUri, change.newUri] : [change?.uri];
        const locations = [];
        for (const uri of uris) { const { text, ...target } = await inspect(uri); locations.push(target); }
        resource_operations.push({ kind, targets: locations, options: change?.options ?? null, annotation_id: change?.annotationId ?? null });
        issues.add('resource_operations_require_policy');
      }
    }
  }
  if (edit?.changes && edit?.documentChanges) issues.add('mixed_edit_forms');
  if (basis.tool === 'code_actions_preview' && action.kind && action.kind !== 'quickfix' && !action.kind.startsWith('quickfix.')) issues.add('not_quickfix');
  const command = typeof action.command === 'string' ? { command: action.command, arguments: action.arguments ?? [] } : action.command;
  const hasCommand = typeof command?.command === 'string' && command.command.length > 0;
  if (command !== undefined && !hasCommand) issues.add('invalid_command');
  const needsResolve = Object.hasOwn(action, 'data');
  const hasEdits = files.some(f => f.edits.length) || resource_operations.length > 0;
  const status = action.disabled ? 'disabled' : hasCommand ? 'requires_command' : needsResolve ? 'requires_resolve' : issues.size ? 'unsupported_edit' : hasEdits ? 'edit_available' : 'unavailable';
  const newText = files.flatMap(f => f.edits.map(e => typeof e.new_text === 'string' ? e.new_text : '')).join('\n');
  const category = /(?:ty|type):\s*ignore/.test(newText) ? 'suppression' : /^(?:from\s+\S+\s+import\s+|import\s+)/m.test(newText) ? 'import' : action.kind?.startsWith('quickfix') ? 'quickfix' : 'unclassified';
  const fullBasis = { ...basis, targets: [...targets.values()].map(({ text, ...metadata }) => metadata).sort((a, b) => String(a.uri) < String(b.uri) ? -1 : String(a.uri) > String(b.uri) ? 1 : 0) };
  const action_fingerprint = fingerprint(action);
  return {
    preview_version: 1, preview_only: true, title: action.title, kind: action.kind ?? null, category,
    category_evidence: category === 'suppression' ? 'ignore_directive_in_edit' : category === 'import' ? 'import_statement_in_edit' : 'server_kind_or_unknown',
    status, selection_id: fingerprint({ basis: fullBasis, action_fingerprint }), action_fingerprint, basis: fullBasis,
    command: hasCommand ? { name: command.command, fingerprint: fingerprint(command) } : null,
    needs_resolve: needsResolve, resolve_data_fingerprint: needsResolve ? fingerprint(action.data) : null, disabled_reason: action.disabled?.reason ?? null,
    edit: { files, resource_operations, annotations: edit?.changeAnnotations ?? null }, issues: [...issues].sort(),
  };
}
export async function codeActionsPreview(project, session, args) {
  const provider = session.capabilities.codeActionProvider;
  if (!provider || (Array.isArray(provider.codeActionKinds) && !provider.codeActionKinds.some(k => k === '' || k === 'quickfix' || k.startsWith('quickfix.')))) throw new Error('ty server does not support quickfix codeAction');
  const [publication] = await session.diagnostics([project.file]);
  if (publication?.status !== 'received') throw new Error('Diagnostics incomplete: fresh publishDiagnostics timed out; not an empty quickfix result');
  const uri = pathToFileURL(project.file).href, document = session.documents.get(uri);
  const range = toLspRange(args.range, document.text), diagnostics = selectDiagnostics(document.text, range, publication.diagnostics);
  const request = { workspace_root: project.workspace, file: project.file, range: { start: { line: range.start.line + 1, character: range.start.character + 1 }, end: { line: range.end.line + 1, character: range.end.character + 1 } } };
  const basis = await captureBasis(project, session, 'code_actions_preview', request, document.text, diagnostics);
  const actions = await session.request('textDocument/codeAction', { textDocument: { uri }, range, context: { diagnostics, only: ['quickfix'] } });
  if (actions !== null && !Array.isArray(actions)) throw new Error('Invalid codeAction response: expected array or null');
  if ((actions?.length ?? 0) > MAX_ACTIONS) throw new Error('Preview candidate limit exceeded (20); narrow the range');
  const output = {
    workspace_root: project.workspace, project_root: project.root, config: project.config, environment: project.environment,
    server: { name: 'ty', version: '0.0.109', executable: session.command, configuration_source: session.runtime.source },
    diagnostics_status: 'received', diagnostics_version: publication.version, diagnostics, basis, result: [],
  };
  let outputBytes = Buffer.byteLength(JSON.stringify(output));
  if (outputBytes > MAX_TEXT) throw new Error('Preview output limit exceeded (1 MiB); narrow the range');
  for (const action of actions ?? []) {
    const preview = await buildPreview(basis, action);
    outputBytes += Buffer.byteLength(JSON.stringify(preview)) + 1;
    if (outputBytes > MAX_TEXT) throw new Error('Preview output limit exceeded (1 MiB); narrow the range');
    output.result.push(preview);
  }
  await assertBasisCurrent(basis, session);
  for (const preview of output.result) await assertBasisCurrent(preview.basis, session);
  return output;
}
