import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { captureBasis, buildPreview, assertBasisCurrent, offsetAt, fingerprint } from './preview.mjs';

const hardKeywords = new Set('False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield'.split(' '));
const excludedNames = new Set(['match', 'case', 'type', 'lazy', '_', '__debug__']);
const identifier = /^[_\p{XID_Start}][\p{XID_Continue}]*$/u;
export const namePolicy = Object.freeze({ policy_version: 1, unicode_version: process.versions.unicode, normalization: 'require_NFKC_stable', default_ignorables: 'excluded', max_codepoints: 256, keywords: 'Python_3.15_hard_and_soft_plus___debug__', validation: 'Node_XID_subset_not_all_Python_versions' });
export function validatePythonName(value) {
  if (typeof value !== 'string' || !value || value.length > 512 || [...value].length > namePolicy.max_codepoints) throw new Error('new_name must contain 1..256 identifier code points');
  if (value !== value.normalize('NFKC')) throw new Error('new_name must already be NFKC-normalized; no automatic normalization is performed');
  if (!identifier.test(value) || /\p{Default_Ignorable_Code_Point}/u.test(value)) throw new Error('new_name must be a Python identifier within the supported Unicode XID policy, without default-ignorable code points');
  if (hardKeywords.has(value) || excludedNames.has(value)) throw new Error('new_name is reserved or excluded by the conservative Python rename policy');
  return value;
}
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const only = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
function checkedRange(range, text, position) {
  if (!only(range, ['start', 'end']) || !range.start || !range.end) throw new Error('Invalid prepareRename range');
  const start = offsetAt(text, range.start), end = offsetAt(text, range.end), point = offsetAt(text, position);
  if (start >= end || point < start || point > end) throw new Error('Invalid prepareRename range for this position');
  const old_name = text.slice(start, end);
  if (!identifier.test(old_name) || hardKeywords.has(old_name)) throw new Error('prepareRename range does not contain an identifier');
  return { range, old_name };
}
function identifierAt(text, position) {
  const offset = offsetAt(text, position), lineStart = offsetAt(text, { line: position.line, character: 0 });
  for (const match of text.matchAll(/[_\p{XID_Start}][\p{XID_Continue}]*/gu)) {
    if (match.index > offset) break;
    if (match.index >= lineStart && match.index <= offset && offset <= match.index + match[0].length) {
      return checkedRange({ start: { line: position.line, character: match.index - lineStart }, end: { line: position.line, character: match.index + match[0].length - lineStart } }, text, position);
    }
  }
  throw new Error('prepareRename default identifier is unavailable at this position');
}
function preparedResult(result, text, position) {
  if (result === null) return { status: 'not_renamable', result: null, range: null, old_name: null };
  if (only(result, ['start', 'end']) && result.start && result.end) return { status: 'range', result, ...checkedRange(result, text, position) };
  if (only(result, ['range', 'placeholder']) && result.range && typeof result.placeholder === 'string') return { status: 'range', result, ...checkedRange(result.range, text, position) };
  if (only(result, ['defaultBehavior']) && typeof result.defaultBehavior === 'boolean') {
    return { status: 'default_behavior', result, ...(result.defaultBehavior ? identifierAt(text, position) : { range: null, old_name: null }) };
  }
  throw new Error('Invalid prepareRename response');
}
function workspaceEdit(edit) {
  if (!only(edit, ['changes', 'documentChanges', 'changeAnnotations'])) throw new Error('Invalid rename WorkspaceEdit response');
  if (Object.hasOwn(edit, 'changes') && (!object(edit.changes) || Object.values(edit.changes).some(edits => !Array.isArray(edits)))) throw new Error('Invalid rename WorkspaceEdit changes');
  if (Object.hasOwn(edit, 'documentChanges')) {
    if (!Array.isArray(edit.documentChanges)) throw new Error('Invalid rename WorkspaceEdit documentChanges');
    for (const change of edit.documentChanges) {
      if (!object(change)) throw new Error('Invalid rename WorkspaceEdit operation');
      if (change.textDocument) {
        if (!only(change, ['textDocument', 'edits']) || !only(change.textDocument, ['uri', 'version']) || typeof change.textDocument.uri !== 'string' || !Array.isArray(change.edits)) throw new Error('Invalid rename WorkspaceEdit text document');
      } else if (!['create', 'rename', 'delete'].includes(change.kind) || (change.kind === 'rename' ? typeof change.oldUri !== 'string' || typeof change.newUri !== 'string' : typeof change.uri !== 'string')) throw new Error('Invalid rename WorkspaceEdit resource operation');
    }
  }
  if (Object.hasOwn(edit, 'changeAnnotations') && !object(edit.changeAnnotations)) throw new Error('Invalid rename WorkspaceEdit annotations');
  return Object.values(edit.changes ?? {}).some(edits => edits.length) || (edit.documentChanges ?? []).some(change => change.kind || change.edits.length);
}
export async function renamePreview(project, session, args) {
  const newName = validatePythonName(args.new_name), provider = session.capabilities.renameProvider;
  if (!provider) throw new Error('ty server does not support rename');
  if (provider !== true && (!object(provider) || (provider.prepareProvider !== undefined && typeof provider.prepareProvider !== 'boolean'))) throw new Error('Invalid renameProvider capability');
  const uri = await session.sync(project.file), text = session.documents.get(uri).text;
  const position = session.position(uri, args.line, args.character);
  const request = { workspace_root: project.workspace, file: project.file, line: position.line + 1, character: position.character + 1, new_name: newName };
  const context = { rename_capability: provider, name_policy: namePolicy, rename_bridge_fingerprint: fingerprint(await readFile(fileURLToPath(import.meta.url), 'utf8')), prepare: { status: 'not_advertised', result: null, range: null, old_name: null } };
  let basis = await captureBasis(project, session, 'rename_preview', request, text, [], context);
  if (provider.prepareProvider) {
    let result;
    try { result = await session.request('textDocument/prepareRename', { textDocument: { uri }, position }); }
    catch (error) { throw new Error(`prepareRename failed: ${error.message}`); }
    context.prepare = preparedResult(result, text, position);
    basis = { ...basis, operation_context: structuredClone(context) };
  }
  await assertBasisCurrent(basis, session);
  const output = { workspace_root: project.workspace, project_root: project.root, config: project.config, environment: project.environment,
    server: { name: 'ty', version: '0.0.109', executable: session.command, configuration_source: session.runtime.source },
    status: 'no_changes', reason: 'Server returned no rename changes', prepare: context.prepare, name_policy: namePolicy, basis, result: null };
  if (context.prepare.status === 'not_renamable') return { ...output, status: 'not_renamable', reason: 'prepareRename returned no renameable symbol at this position' };
  let edit;
  try { edit = await session.request('textDocument/rename', { textDocument: { uri }, position, newName }); }
  catch (error) { throw new Error(`rename failed: ${error.message}`); }
  if (edit !== null && workspaceEdit(edit)) {
    const preview = await buildPreview(basis, { title: `Rename to ${newName}`, kind: 'refactor.rename', edit });
    await assertBasisCurrent(preview.basis, session);
    const changed = preview.edit.resource_operations.length || preview.issues.length || preview.edit.files.some(file => file.edits.some(e => e.old_text === null || e.old_text !== e.new_text));
    if (changed) { output.status = 'preview_available'; output.reason = null; output.result = preview; }
  }
  await assertBasisCurrent(basis, session);
  return output;
}
