import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { inside, supported, resolveProject } from './project.mjs';
import { assertBasisCurrent, fingerprint, offsetAt } from './preview.mjs';
import { protectedPath, pythonText } from './source.mjs';

const MAX_TEXT = 1024 * 1024;
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const hash = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const identity = s => ({ dev: s.dev, ino: s.ino });
const stamp = s => ({ ...identity(s), size: s.size, mode: s.mode, uid: s.uid, gid: s.gid, mtime: s.mtimeMs, ctime: s.ctimeMs, nlink: s.nlink });
const replacementStamp = s => { const { ctime, ...rest } = stamp(s); return rest; };
const same = (a, b) => fingerprint(a) === fingerprint(b);
function requireValue(value, message) { if (!value) throw new Error(message); }
async function parentCheck(io, file, expected) {
  const parent = path.dirname(file);
  requireValue(await io.realpath(parent) === parent, 'Symlink parent is unsupported');
  const current = identity(await io.lstat(parent));
  if (expected) requireValue(same(current, expected), 'Parent directory changed');
  return current;
}
async function readRegular(io, file, expected = null) {
  const handle = await io.open(file, READ_FLAGS);
  try {
    const before = await handle.stat();
    requireValue(before.isFile() && before.nlink === 1, 'Only regular single-link files are supported');
    if (expected) requireValue(same(identity(before), identity(expected)), 'Transaction artifact was replaced');
    requireValue(before.size <= MAX_TEXT, 'File exceeds 1 MiB');
    // Bounded even if another process grows the file after stat.
    const buffer = Buffer.alloc(MAX_TEXT + 1); let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const after = await handle.stat();
    requireValue(length <= MAX_TEXT && same(stamp(before), stamp(after)), 'File changed during read or exceeds 1 MiB');
    requireValue(same(stamp(after), stamp(await io.lstat(file))), 'File path changed during read');
    const bytes = buffer.subarray(0, length);
    return { bytes, sha256: hash(bytes), stat: after };
  } finally { await handle.close(); }
}
async function snapshot(io, project, file, expectedParent = null) {
  requireValue(inside(project.workspace, file) && inside(project.root, file), 'Target is outside selected project/workspace');
  requireValue(supported.test(file) && !protectedPath(project.workspace, file), 'Unsupported or protected source path');
  requireValue(!inside(project.environment.path, file), 'Python environment sources are not writable');
  requireValue(await io.realpath(file) === file, 'Symlink source is unsupported');
  const parent = await parentCheck(io, file, expectedParent);
  const current = await readRegular(io, file);
  await parentCheck(io, file, parent);
  return { ...current, parent };
}
function metadata(snapshot) {
  return { sha256: snapshot.sha256, byte_length: snapshot.bytes.length, mode: snapshot.stat.mode & 0o777, device: snapshot.stat.dev, inode: snapshot.stat.ino,
    bom: snapshot.bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) };
}
function compose(bytes, edits) {
  const text = pythonText(bytes);
  const spans = edits.map(edit => {
    requireValue(typeof edit.new_text === 'string' && Buffer.from(edit.new_text, 'utf8').toString('utf8') === edit.new_text, 'Invalid Unicode replacement text');
    requireValue(edit.annotation_id === undefined, 'Annotated edits are unsupported');
    const start = offsetAt(text, edit.range?.start), end = offsetAt(text, edit.range?.end);
    requireValue(end >= start && text.slice(start, end) === edit.old_text, 'Expected edit content/range does not match');
    return { start, end, replacement: edit.new_text };
  }).sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 1; i < spans.length; i++) requireValue(spans[i].start >= spans[i - 1].end && spans[i].start !== spans[i - 1].start, 'Overlapping or ambiguous edits');
  let output = text;
  for (const span of spans.reverse()) output = output.slice(0, span.start) + span.replacement + output.slice(span.end);
  const bom = bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]));
  const result = Buffer.from((bom ? '\uFEFF' : '') + output, 'utf8');
  requireValue(result.length <= MAX_TEXT, 'Result exceeds 1 MiB');
  pythonText(result);
  return result;
}

// Internal only: the caller must regenerate the server candidate and compare its
// selection ID first. This is not an API for accepting client edits or bases.
export async function applyPreview(project, session, preview, { io = fs } = {}) {
  const plans = [], artifacts = [], written = [];
  let result;
  async function artifact(file, bytes, mode, role, parent, owner = null) {
    await parentCheck(io, file, parent);
    const handle = await io.open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
    const item = { file, parent, role, stat: null, sha256: hash(bytes), keep: false };
    artifacts.push(item);
    try {
      item.stat = await handle.stat();
      await parentCheck(io, file, parent);
      if (owner && (item.stat.uid !== owner.uid || item.stat.gid !== owner.gid)) await handle.chown(owner.uid, owner.gid);
      await handle.writeFile(bytes); await handle.chmod(mode); await handle.sync(); item.stat = await handle.stat();
    } finally { await handle.close(); }
    return item;
  }
  async function ownArtifact(item) {
    await parentCheck(io, item.file, item.parent);
    requireValue(item.stat, 'Artifact identity is unavailable');
    const current = await readRegular(io, item.file, item.stat);
    requireValue(current.sha256 === item.sha256 && same(stamp(current.stat), stamp(item.stat)), 'Transaction artifact content or metadata changed');
  }
  async function requireSnapshot(plan, expected) {
    const current = await snapshot(io, project, plan.file, plan.original.parent);
    requireValue(expected.stat && current.sha256 === expected.sha256 && same(stamp(current.stat), stamp(expected.stat)), 'Concurrent file or metadata change');
    return current;
  }
  function checkVersion(file) {
    if (file.document_version !== null) requireValue(Number.isSafeInteger(file.document_version) && file.document_version >= 0 && session.documents.get(file.uri)?.version === file.document_version, 'Document version unavailable or stale');
  }
  async function checkProject(file) {
    const selected = await resolveProject(file, project.workspace);
    requireValue(selected.root === project.root && selected.config === project.config && selected.configurationFile === project.configurationFile && same(selected.environment, project.environment), 'Target selects a different Python project/environment');
  }
  async function criticalCheck() {
    const owned = new Map(written.map(p => [p.file, p.after]));
    const basis = preview.basis, anchor = owned.get(basis.scope.anchor_file);
    // Only known engine-owned source identities may change. Preserve all other
    // original config/environment/server/operation evidence during the batch.
    const currentBasis = { ...basis,
      anchor: anchor ? { ...basis.anchor, ...metadata(anchor) } : basis.anchor,
      anchor_sha256: anchor?.sha256 ?? basis.anchor_sha256,
      targets: basis.targets.map(t => owned.has(t.file) ? { ...t, ...metadata(owned.get(t.file)) } : t),
    };
    const documents = new Map(session.documents);
    if (anchor) documents.set(basis.anchor.uri, { ...documents.get(basis.anchor.uri), text: new TextDecoder('utf-8', { fatal: true }).decode(anchor.bytes) });
    await assertBasisCurrent(currentBasis, { ...session, documents });
    for (const plan of plans) { checkVersion(plan.target); await checkProject(plan.file); await requireSnapshot(plan, plan.committed ? plan.after : plan.original); }
  }
  function markWritten(plan) { plan.committed = true; written.push(plan); }
  try {
    requireValue(typeof constants.O_NOFOLLOW === 'number' && typeof constants.O_NONBLOCK === 'number', 'Required no-symlink/nonblocking guards are unavailable');
    requireValue(preview?.preview_version === 1 && preview.preview_only === true && preview.basis?.schema_version === 1, 'Unsupported preview version');
    requireValue(['rename_preview', 'code_actions_preview'].includes(preview.basis.tool), 'Unsupported preview operation');
    requireValue(preview.selection_id === fingerprint({ basis: preview.basis, action_fingerprint: preview.action_fingerprint }), 'Preview selection identity differs');
    requireValue(preview.status === 'edit_available' && !preview.command && !preview.needs_resolve && preview.disabled_reason === null, 'Only standalone immediate edits are supported');
    requireValue(preview.issues.length === 0 && preview.edit.resource_operations.length === 0 && preview.edit.annotations === null, 'Resources, annotations or edit boundaries unsupported');
    requireValue(preview.basis.scope.project_root === project.root && preview.basis.scope.workspace_root === project.workspace && preview.basis.scope.anchor_file === project.file, 'Preview project context differs');
    requireValue(Array.isArray(preview.edit.files) && preview.edit.files.length > 0 && preview.edit.files.length <= 20, 'Expected 1..20 existing files');
    await assertBasisCurrent(preview.basis, session);
    const seen = new Set(); let count = 0;
    for (const target of preview.edit.files) {
      const url = new URL(target.uri);
      requireValue(url.protocol === 'file:' && !url.search && !url.hash, 'Unsupported source URI');
      const file = path.resolve(fileURLToPath(url));
      requireValue(file === target.file && !seen.has(file), 'Aliased or duplicate target'); seen.add(file);
      requireValue(target.workspace_boundary === 'inside' && target.project_boundary === 'inside' && target.exists === true && target.read_status === 'read', 'Target boundary/snapshot unavailable');
      const { document_version, source, edits, ...sourceMetadata } = target;
      requireValue(same(sourceMetadata, preview.basis.targets.find(t => t.uri === target.uri)), 'Target differs from preview preimage');
      requireValue(Array.isArray(edits) && (count += edits.length) <= 200, 'Edit count exceeds 200');
      checkVersion(target);
      const original = await snapshot(io, project, file);
      requireValue(file !== session.command && file !== project.environment.interpreter, 'Runtime sources are not writable');
      await checkProject(file);
      requireValue(same(metadata(original), Object.fromEntries(Object.keys(metadata(original)).map(k => [k, target[k]]))), 'Expected file hash/identity/BOM differs');
      requireValue((original.stat.mode & 0o222) !== 0 && (original.stat.mode & 0o7000) === 0, 'Read-only or special file permissions unsupported');
      if (process.getuid) requireValue(original.stat.uid === process.getuid(), 'File must be owned by current user');
      const bytes = compose(original.bytes, edits);
      if (hash(bytes) !== original.sha256) plans.push({ file, target, original, after: { bytes, sha256: hash(bytes) }, committed: false });
    }
    requireValue(plans.length > 0, 'No text changes to apply');
    plans.sort((a, b) => a.file.localeCompare(b.file));
    for (const plan of plans) await artifact(path.join(path.dirname(plan.file), `.${path.basename(plan.file)}.python-lsp.lock`), Buffer.alloc(0), 0o600, 'lock', plan.original.parent);
    for (const plan of plans) {
      const base = path.join(path.dirname(plan.file), `.${path.basename(plan.file)}.python-lsp-${randomUUID()}`);
      plan.backup = await artifact(`${base}.backup`, plan.original.bytes, 0o600, 'backup', plan.original.parent);
      plan.next = await artifact(`${base}.next`, plan.after.bytes, plan.original.stat.mode & 0o777, 'next', plan.original.parent, plan.original.stat);
    }
    await criticalCheck();
    for (const plan of plans) {
      await criticalCheck(); await ownArtifact(plan.next); await ownArtifact(plan.backup);
      await requireSnapshot(plan, plan.original);
      try { await io.rename(plan.next.file, plan.file); }
      catch (error) {
        // A rejected rename can still have committed. Observe instead of
        // assuming no write, and retain backups for any uncertain outcome.
        let observed;
        try { observed = await snapshot(io, project, plan.file, plan.original.parent); } catch { /* uncertain */ }
        if (!observed || observed.sha256 !== plan.original.sha256 || !same(stamp(observed.stat), stamp(plan.original.stat))) {
          markWritten(plan); plan.write_outcome = 'uncertain';
          if (observed?.sha256 === plan.after.sha256 && same(replacementStamp(observed.stat), replacementStamp(plan.next.stat))) { plan.after.stat = observed.stat; plan.write_outcome = 'committed'; }
        }
        throw error;
      }
      markWritten(plan);
      const after = await snapshot(io, project, plan.file, plan.original.parent);
      requireValue(after.sha256 === plan.after.sha256 && same(replacementStamp(after.stat), replacementStamp(plan.next.stat)), 'File changed at commit');
      plan.after.stat = after.stat;
    }
    await criticalCheck();
    result = { status: 'applied', files: plans.map(p => ({ file: p.file, before_sha256: p.original.sha256, after_sha256: p.after.sha256 })), recovery: [] };
  } catch (error) {
    const recovery = [];
    for (const plan of [...written].reverse()) {
      try {
        requireValue(plan.after.stat, 'Commit outcome was not verified; refusing automatic rollback');
        const current = await requireSnapshot(plan, plan.after);
        await ownArtifact(plan.backup);
        const handle = await io.open(plan.backup.file, READ_FLAGS);
        try {
          const s = await handle.stat(); requireValue(same(stamp(s), stamp(plan.backup.stat)), 'Recovery backup was replaced or changed');
          if (s.uid !== plan.original.stat.uid || s.gid !== plan.original.stat.gid) await handle.chown(plan.original.stat.uid, plan.original.stat.gid);
          await handle.chmod(plan.original.stat.mode & 0o777);
          plan.backup.stat = await handle.stat();
        } finally { await handle.close(); }
        await ownArtifact(plan.backup); await requireSnapshot(plan, current);
        await io.rename(plan.backup.file, plan.file);
        const restored = await snapshot(io, project, plan.file, plan.original.parent);
        requireValue(restored.sha256 === plan.original.sha256 && same(identity(restored.stat), identity(plan.backup.stat)), 'Recovery content/identity could not be verified');
        recovery.push({ file: plan.file, status: 'restored', original_sha256: plan.original.sha256 });
      } catch (restoreError) {
        plan.backup.keep = true;
        let backup_verified = false;
        try { await ownArtifact(plan.backup); backup_verified = true; } catch { /* retained path is not necessarily valid */ }
        recovery.push({ file: plan.file, status: 'not_restored_conflict', reason: restoreError.message, backup_path: plan.backup.file, backup_verified, original_sha256: plan.original.sha256 });
      }
    }
    result = { status: !written.length ? 'rejected' : recovery.every(r => r.status === 'restored') ? 'rolled_back' : 'recovery_incomplete', reason: error.message,
      files: written.map(p => ({ file: p.file, write_outcome: p.write_outcome ?? 'committed' })), recovery };
  } finally {
    const retained = [];
    for (const item of [...artifacts].reverse()) {
      if (item.keep) { retained.push(item.file); continue; }
      try { await ownArtifact(item); await io.unlink(item.file); }
      catch (error) { if (error.code !== 'ENOENT') retained.push(item.file); }
    }
    if (result) result.retained_artifacts = retained;
  }
  return result;
}
