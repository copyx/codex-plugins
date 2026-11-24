import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { inside } from './project.mjs';
import { assertBasisCurrent, fingerprint, offsetAt } from './preview.mjs';

const hash = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const identity = s => ({ dev: s.dev, ino: s.ino });
const stamp = s => ({ ...identity(s), size: s.size, mode: s.mode, mtime: s.mtimeMs, ctime: s.ctimeMs, nlink: s.nlink });
const same = (a, b) => fingerprint(a) === fingerprint(b);
function requireValue(value, message) { if (!value) throw new Error(message); }

async function parentCheck(io, file, expected) {
  const parent = path.dirname(file);
  requireValue(await io.realpath(parent) === parent, 'Symlink parent is not supported');
  const current = identity(await io.stat(parent));
  if (expected) requireValue(same(current, expected), 'Parent directory changed');
  return current;
}
async function snapshot(io, project, file) {
  requireValue(inside(project.root, file) && inside(project.workspace, file), 'Edit is outside the selected project/workspace');
  requireValue(await io.realpath(file) === file, 'Symlink target is not supported');
  const parent = await parentCheck(io, file);
  const handle = await io.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    requireValue(before.isFile() && before.nlink === 1, 'Only regular single-link files are supported');
    const bytes = await handle.readFile();
    const after = await handle.stat();
    requireValue(same(stamp(before), stamp(after)), 'File changed during read');
    requireValue(same(identity(after), identity(await io.lstat(file))), 'File path changed during read');
    await parentCheck(io, file, parent);
    return { bytes, sha256: hash(bytes), stat: after, parent };
  } finally { await handle.close(); }
}
function validBoundary(text, offset) {
  const a = text.charCodeAt(offset - 1), b = text.charCodeAt(offset);
  return !(a >= 0xd800 && a <= 0xdbff && b >= 0xdc00 && b <= 0xdfff);
}
function compose(bytes, edits) {
  const text = bytes.toString('utf8');
  requireValue(Buffer.from(text, 'utf8').equals(bytes), 'Only valid UTF-8 files are supported');
  const spans = edits.map(e => {
    requireValue(typeof e.new_text === 'string', 'Invalid replacement text');
    const start = offsetAt(text, e.range?.start), end = offsetAt(text, e.range?.end);
    requireValue(end >= start && validBoundary(text, start) && validBoundary(text, end), 'Invalid UTF-16 edit range');
    requireValue(text.slice(start, end) === e.old_text, 'Expected edit content does not match');
    return { start, end, replacement: e.new_text };
  }).sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 1; i < spans.length; i++) requireValue(spans[i].start >= spans[i - 1].end && spans[i].start !== spans[i - 1].start, 'Overlapping or ambiguous text edits');
  let output = text;
  for (const span of spans.reverse()) output = output.slice(0, span.start) + span.replacement + output.slice(span.end);
  return Buffer.from(output, 'utf8');
}

// Internal engine: callers must supply a freshly regenerated server proposal,
// never a WorkspaceEdit or basis supplied by an MCP client.
export async function applyPreview(project, preview, { versions = new Map(), io = fs } = {}) {
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
    }
    finally { await handle.close(); }
    return item;
  }
  async function requireSnapshot(plan, expected) {
    await parentCheck(io, plan.file, plan.original.parent);
    const now = await snapshot(io, project, plan.file);
    requireValue(now.sha256 === expected.sha256 && same(stamp(now.stat), stamp(expected.stat)), 'Concurrent file change detected');
    return now;
  }
  async function criticalCheck() {
    const owned = new Map(written.map(p => [p.file, p.after.sha256]));
    const basis = preview.basis;
    await assertBasisCurrent({
      ...basis, anchor_sha256: owned.get(basis.scope.anchor_file) ?? basis.anchor_sha256,
      config_sha256: owned.get(basis.scope.config) ?? basis.config_sha256,
      targets: basis.targets.map(t => ({ ...t, sha256: owned.get(t.file) ?? t.sha256 })),
    });
    for (const plan of plans) await requireSnapshot(plan, plan.committed ? plan.after : plan.original);
  }
  async function ownArtifact(item) {
    await parentCheck(io, item.file, item.parent);
    requireValue(item.stat, 'Transaction artifact identity is unavailable');
    requireValue(same(identity(await io.lstat(item.file)), identity(item.stat)), 'Transaction artifact was replaced');
    requireValue(hash(await io.readFile(item.file)) === item.sha256, 'Transaction artifact content changed');
  }
  try {
    requireValue(typeof constants.O_NOFOLLOW === 'number', 'This platform does not support the required no-symlink file open guard');
    requireValue(preview?.preview_version === 1 && preview.basis?.schema_version === 1, 'Unsupported preview version');
    requireValue(preview.status === 'edit_available' && !preview.command, 'Preview is not a standalone immediate edit');
    requireValue(!preview.needs_resolve && !preview.disabled_reason, 'Deferred or disabled edits are unsupported');
    requireValue(preview.issues.length === 0 && preview.edit.resource_operations.length === 0, 'Unsupported resources, annotations, or edit boundaries');
    requireValue(preview.basis.scope.project_root === project.root && preview.basis.scope.workspace_root === project.workspace, 'Preview project context differs');
    await assertBasisCurrent(preview.basis);
    const seen = new Set();
    for (const f of preview.edit.files) {
      if (!f.edits.length) continue;
      const url = new URL(f.uri);
      requireValue(url.protocol === 'file:' && !url.search && !url.hash, 'Unsupported edit URI');
      const file = path.resolve(fileURLToPath(url));
      requireValue(file === f.file && !seen.has(file), 'Aliased or duplicate edit target'); seen.add(file);
      requireValue(f.workspace_boundary === 'inside' && f.project_boundary === 'inside' && f.exists === true, 'Edit target is outside the selected project or missing');
      requireValue(!inside(path.dirname(project.tsserver), file) && file !== path.resolve(path.dirname(project.tsserver), '../package.json'), 'TypeScript runtime edits are unsupported');
      if (f.document_version !== null) requireValue(Number.isInteger(f.document_version) && f.document_version >= 0 && versions.get(f.uri) === f.document_version, 'Document version is unavailable or stale');
      const original = await snapshot(io, project, file);
      requireValue(original.sha256 === f.sha256, 'Expected file hash does not match');
      requireValue((original.stat.mode & 0o222) !== 0, 'Read-only file is unsupported');
      requireValue((original.stat.mode & 0o7000) === 0, 'Special file permissions are unsupported');
      if (process.getuid) requireValue(original.stat.uid === process.getuid(), 'File must be owned by the current user');
      const bytes = compose(original.bytes, f.edits);
      if (hash(bytes) === original.sha256) continue;
      plans.push({ file, original, after: { bytes, sha256: hash(bytes) }, committed: false });
    }
    requireValue(plans.length > 0 && plans.some(p => p.after.sha256 !== p.original.sha256), 'No text changes to apply');
    plans.sort((a, b) => a.file.localeCompare(b.file));
    for (const plan of plans) {
      const file = path.join(path.dirname(plan.file), `.${path.basename(plan.file)}.typescript-lsp.lock`);
      await artifact(file, Buffer.alloc(0), 0o600, 'lock', plan.original.parent);
    }
    for (const plan of plans) {
      const base = path.join(path.dirname(plan.file), `.${path.basename(plan.file)}.typescript-lsp-${randomUUID()}`);
      plan.backup = await artifact(`${base}.backup`, plan.original.bytes, 0o600, 'backup', plan.original.parent);
      plan.next = await artifact(`${base}.next`, plan.after.bytes, plan.original.stat.mode & 0o777, 'next', plan.original.parent, plan.original.stat);
    }
    await criticalCheck();
    for (const plan of plans) {
      await criticalCheck();
      await ownArtifact(plan.next);
      // Final content/path recheck directly before atomic per-file replacement.
      await requireSnapshot(plan, plan.original);
      try { await io.rename(plan.next.file, plan.file); }
      catch (error) {
        // Some I/O failures have an uncertain outcome. Inspect the destination
        // rather than assuming that a rejected rename did not commit.
        let observed;
        try { observed = await snapshot(io, project, plan.file); } catch { /* uncertain */ }
        if (!observed || observed.sha256 !== plan.original.sha256 || !same(stamp(observed.stat), stamp(plan.original.stat))) {
          plan.committed = true; written.push(plan);
          plan.write_outcome = 'uncertain';
          if (observed?.sha256 === plan.after.sha256 && same(identity(observed.stat), identity(plan.next.stat))) { plan.after.stat = observed.stat; plan.write_outcome = 'committed'; }
        }
        throw error;
      }
      plan.committed = true; written.push(plan);
      const after = await snapshot(io, project, plan.file);
      requireValue(after.sha256 === plan.after.sha256 && same(identity(after.stat), identity(plan.next.stat)), 'File changed at commit');
      plan.after.stat = after.stat;
    }
    await criticalCheck();
    result = { status: 'applied', files: plans.map(p => ({ file: p.file, before_sha256: p.original.sha256, after_sha256: p.after.sha256 })), recovery: [] };
  } catch (error) {
    const recovery = [];
    for (const plan of [...written].reverse()) {
      try {
        const current = await snapshot(io, project, plan.file);
        requireValue(current.sha256 === plan.after.sha256 && same(identity(current.stat), identity(plan.next.stat)), 'Separate edit prevents rollback');
        if (plan.after.stat) requireValue(same(stamp(current.stat), stamp(plan.after.stat)), 'Separate metadata change prevents rollback');
        await ownArtifact(plan.backup);
        const handle = await io.open(plan.backup.file, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const s = await handle.stat();
          if (s.uid !== plan.original.stat.uid || s.gid !== plan.original.stat.gid) await handle.chown(plan.original.stat.uid, plan.original.stat.gid);
          await handle.chmod(plan.original.stat.mode & 0o777);
        } finally { await handle.close(); }
        await parentCheck(io, plan.file, plan.original.parent);
        const again = await snapshot(io, project, plan.file);
        requireValue(again.sha256 === current.sha256 && same(stamp(again.stat), stamp(current.stat)), 'Separate edit prevents rollback');
        await io.rename(plan.backup.file, plan.file);
        requireValue(hash(await io.readFile(plan.file)) === plan.original.sha256, 'Recovery content could not be verified');
        recovery.push({ file: plan.file, status: 'restored' });
      } catch (restoreError) {
        plan.backup.keep = true;
        let backup_verified = false;
        try { await ownArtifact(plan.backup); backup_verified = true; } catch { /* retain, but do not claim a valid path */ }
        recovery.push({ file: plan.file, status: 'not_restored_conflict', reason: restoreError.message, backup_path: plan.backup.file, backup_verified, original_sha256: plan.original.sha256 });
      }
    }
    result = { status: !written.length ? 'rejected' : recovery.every(r => r.status === 'restored') ? 'rolled_back' : 'recovery_incomplete', reason: error.message, files: written.map(p => ({ file: p.file, write_outcome: p.write_outcome ?? 'committed' })), recovery };
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
