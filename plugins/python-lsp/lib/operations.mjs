import { open, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolveProject } from './project.mjs';
import { LspSession } from './lsp.mjs';
import { codeActionsPreview, fingerprint } from './preview.mjs';
import { applyPreview } from './apply.mjs';

function requireValue(value, message) { if (!value) throw new Error(message); }
const selection = /^sha256:[a-f0-9]{64}$/;
const same = (a, b) => fingerprint(a) === fingerprint(b);
const errorText = error => { const text = String(error?.message ?? error); return text.length > 4096 ? `${text.slice(0, 4096)} [truncated]` : text; };
async function checkProject(project, file) {
  const current = await resolveProject(file, project.workspace);
  requireValue(current.file === file && current.root === project.root && current.config === project.config && current.configurationFile === project.configurationFile && same(current.environment, project.environment), 'Post-apply project/environment changed');
  return current;
}
async function verifyAppliedSnapshot(file, session) {
  const handle = await open(file.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat(); requireValue(before.isFile() && before.size <= 1024 * 1024, 'Post-apply source is unavailable');
    const buffer = Buffer.alloc(1024 * 1024 + 1); let length = 0;
    while (length < buffer.length) { const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null); if (!bytesRead) break; length += bytesRead; }
    const after = await handle.stat(), disk = await lstat(file.file), bytes = buffer.subarray(0, length);
    for (const key of ['dev','ino','size','mode','mtimeMs','ctimeMs']) requireValue(before[key] === after[key] && after[key] === disk[key], 'Post-apply source changed during diagnostics');
    requireValue(length <= 1024 * 1024 && `sha256:${createHash('sha256').update(bytes).digest('hex')}` === file.after_sha256, 'Post-apply source differs from applied snapshot');
    requireValue(session.documents.get(pathToFileURL(file.file).href)?.text === new TextDecoder('utf-8', { fatal: true }).decode(bytes), 'Post-apply LSP snapshot differs from disk');
  } finally { await handle.close(); }
}
function boundedDiagnostics(publications) {
  let budget = 256 * 1024, truncated = false;
  const diagnostics = publications.map(publication => {
    const selected = [];
    for (const diagnostic of publication.diagnostics.slice(0, 30)) {
      const size = Buffer.byteLength(JSON.stringify(diagnostic)); if (size > budget) break;
      selected.push(diagnostic); budget -= size;
    }
    const omitted = publication.diagnostics.length - selected.length;
    truncated ||= omitted > 0;
    return { ...publication, diagnostics: selected, omitted_diagnostics: omitted };
  });
  return { diagnostics, diagnostics_truncated: truncated };
}
export async function postApplyDiagnostics(project, session, result) {
  if (result.status !== 'applied') return { ...result, diagnostics_status: 'not_run', diagnostics: [], diagnostics_reason: 'No successful application; no post-apply LSP session started' };
  let fresh, output = { ...result, diagnostics_status: 'incomplete', diagnostics: [] };
  try {
    await session.close();
    const current = await checkProject(project, project.file);
    for (const file of result.files) await checkProject(project, file.file);
    fresh = new LspSession(current, { command: session.command }); await fresh.start();
    const publications = await fresh.diagnostics(result.files.map(file => file.file));
    for (const file of result.files) { await checkProject(project, file.file); await verifyAppliedSnapshot(file, fresh); }
    const received = publications.every(p => p.status === 'received');
    output = { ...result, diagnostics_status: received ? 'received' : 'incomplete', ...boundedDiagnostics(publications),
      diagnostics_scope: 'applied_snapshot_in_new_session', diagnostics_server: { name: 'ty', version: fresh.serverVersion, executable: fresh.command },
      ...(!received ? { diagnostics_error: 'Fresh post-apply publishDiagnostics was not received for every changed file' } : {}) };
  } catch (error) {
    output.diagnostics_error = errorText(error);
    try { session.kill?.(); } catch (cleanupError) { output.diagnostics_cleanup_error = errorText(cleanupError); }
  }
  finally {
    try { await fresh?.close(); }
    catch (error) {
      output = { ...output, diagnostics_status: 'incomplete', diagnostics_cleanup_error: errorText(error) };
      try { fresh?.kill(); } catch (cleanupError) { output.diagnostics_cleanup_error += `; ${errorText(cleanupError)}`; }
    }
  }
  return output;
}
export async function applyCodeAction(project, session, args, options = {}) {
  requireValue(typeof args.selection_id === 'string' && selection.test(args.selection_id), 'selection_id must be a preview sha256 ID');
  const shown = await codeActionsPreview(project, session, args);
  const matches = shown.result.filter(candidate => candidate.selection_id === args.selection_id);
  requireValue(matches.length === 1, 'Selected preview is stale or unavailable; request a new selection');
  const selected = matches[0];
  requireValue(selected.status === 'edit_available' && !selected.command && !selected.needs_resolve && selected.disabled_reason === null, 'Selected candidate is not a standalone immediate edit; command/resolve/disabled selections are unsupported');
  const applied = await applyPreview(project, session, selected, options);
  const result = await postApplyDiagnostics(project, session, { ...applied, selection_id: args.selection_id });
  return { workspace_root: shown.workspace_root, project_root: shown.project_root, config: shown.config, environment: shown.environment, server: shown.server, result };
}
