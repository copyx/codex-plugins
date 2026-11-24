import { access, readFile, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { codeActionsPreview, renamePreview, fingerprint } from './preview.mjs';
import { applyPreview } from './apply.mjs';
import { LspSession } from './lsp.mjs';
import { resolveProject } from './project.mjs';

// Audited v6.0.3 CLI bundle installed for the direct protocol proof. Other
// artifacts fail closed for wrapper commands; command-free edits need no gate.
const audited603 = 'sha256:9d9193d6b7d8d92b291d0f1cae8ca3588a5481d8dd6bdf18bd93a43bd49c2916';
function requireValue(value, message) { if (!value) throw new Error(message); }
async function serverIdentity(command, cwd) {
  let executable;
  const choices = /[/\\]/.test(command) ? [path.resolve(cwd, command)] : (process.env.PATH ?? '').split(path.delimiter).map(p => path.resolve(p || cwd, command));
  for (const candidate of choices) { try { await access(candidate, constants.X_OK); executable = await realpath(candidate); break; } catch { /* next PATH entry */ } }
  if (!executable) return {};
  let folder = path.dirname(executable), version;
  while (true) {
    try { const pkg = JSON.parse(await readFile(path.join(folder, 'package.json'), 'utf8')); if (pkg.name === 'typescript-language-server') { version = pkg.version; break; } } catch { /* parent */ }
    const parent = path.dirname(folder); if (parent === folder) break; folder = parent;
  }
  return { version, executable_sha256: `sha256:${createHash('sha256').update(await readFile(executable)).digest('hex')}` };
}
export function commandEffect(action, preview, identity) {
  if (!action.command) return { status: 'none' };
  const command = action.command;
  requireValue(identity.version === '6.0.3' && identity.executable_sha256 === audited603 && command.command === '_typescript.applyCodeActionCommand', 'Unsupported server command or unaudited server artifact');
  requireValue(Array.isArray(command.arguments) && command.arguments.length === 1 && command.arguments[0]?.action, 'Unsupported command arguments');
  const codeFix = command.arguments[0].action;
  requireValue(codeFix.commands === undefined || Array.isArray(codeFix.commands) && codeFix.commands.length === 0, 'Server action requires additional execution');
  requireValue(Array.isArray(codeFix.changes), 'Unsupported command edits');
  const tsEdits = codeFix.changes.map(change => {
    requireValue(!change.isNewFile && typeof change.fileName === 'string' && Array.isArray(change.textChanges), 'Unsupported command file changes');
    return { file: path.resolve(change.fileName), edits: change.textChanges.map(e => {
      for (const p of [e.start, e.end]) requireValue(Number.isInteger(p?.line) && p.line >= 1 && Number.isInteger(p?.offset) && p.offset >= 1, 'Unsupported command range');
      return { range: { start: { line: e.start.line - 1, character: e.start.offset - 1 }, end: { line: e.end.line - 1, character: e.end.offset - 1 } }, new_text: e.newText };
    }) };
  }).sort((a, b) => a.file.localeCompare(b.file));
  const lspEdits = preview.edit.files.map(f => ({ file: f.file, edits: f.edits.map(e => ({ range: e.range, new_text: e.new_text })) })).sort((a, b) => a.file.localeCompare(b.file));
  requireValue(fingerprint(tsEdits) === fingerprint(lspEdits), 'Command edits differ from the selected immediate edit');
  return { status: 'proven_noop', server_version: identity.version, executable_sha256: identity.executable_sha256, command: command.command, reason: 'Audited handler only iterates action.commands, which is empty; immediate edits match action.changes' };
}
export async function postApplyDiagnostics(project, session, result) {
  if (result.status !== 'applied') return result;
  await session.close();
  let fresh;
  try {
    const current = await resolveProject(project.file, project.workspace);
    requireValue(current.root === project.root && current.file === project.file, 'Post-apply project boundary changed');
    for (const file of result.files) {
      const target = await resolveProject(file.file, project.workspace);
      requireValue(target.file === file.file && target.root === project.root, 'Post-apply file/project boundary changed');
    }
    fresh = new LspSession(current);
    await fresh.start();
    const diagnostics = await fresh.diagnostics(result.files.map(f => f.file));
    return { ...result, diagnostics_status: diagnostics.every(d => d.status === 'received') ? 'received' : 'incomplete', diagnostics };
  } catch (error) { return { ...result, diagnostics_status: 'incomplete', diagnostics: [], diagnostics_error: error.message }; }
  finally { await fresh?.close(); }
}
function versions(session) { return new Map([...session.documents].map(([uri, doc]) => [uri, doc.version])); }
export async function applyCodeAction(project, session, args, uri, published) {
  const candidates = [];
  await codeActionsPreview(project, session, args, uri, published, candidates);
  const selected = candidates.find(c => c.preview.selection_id === args.selection_id);
  requireValue(selected, 'Selected preview is stale or unavailable; request a new selection');
  requireValue(!selected.preview.needs_resolve && !selected.action.disabled, 'Deferred or disabled selection cannot be applied');
  const effect = commandEffect(selected.action, selected.preview, selected.action.command ? await serverIdentity(session.command, project.root) : {});
  const immediate = { ...selected.preview, status: selected.preview.status === 'requires_command' && effect.status === 'proven_noop' ? 'edit_available' : selected.preview.status, command: null };
  const result = await applyPreview(project, immediate, { versions: versions(session) });
  return postApplyDiagnostics(project, session, { ...result, selection_id: args.selection_id, command_effect: effect });
}
export async function applyRename(project, session, args, uri) {
  const ts = createRequire(import.meta.url)(path.join(path.dirname(project.tsserver), 'typescript.js'));
  requireValue(ts.isIdentifierText(args.new_name, ts.ScriptTarget.Latest, ts.LanguageVariant.Standard) && ts.stringToToken(args.new_name) === undefined, 'new_name must be a TypeScript identifier, not a keyword');
  const output = await renamePreview(project, session, args, uri);
  requireValue(output.result?.selection_id === args.selection_id, 'Selected rename preview is stale or unavailable; request a new selection');
  const result = await applyPreview(project, output.result, { versions: versions(session) });
  return postApplyDiagnostics(project, session, { ...result, selection_id: args.selection_id });
}
