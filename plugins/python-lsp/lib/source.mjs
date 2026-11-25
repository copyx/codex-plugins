import { open, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

// Reserved components are case-folded conservatively on every volume so aliases
// on case-insensitive filesystems cannot bypass the shared read/write policy.
export function protectedPath(workspace, file) {
  return path.relative(workspace, file).split(path.sep).some(part => {
    const name = part.toLowerCase();
    return ['.git', '.codex', '.agents', '.aws'].includes(name) || /^\.env(?:\.|$)/.test(name);
  });
}
export async function readRegularBytes(file, limit = 1024 * 1024) {
  if (typeof constants.O_NOFOLLOW !== 'number' || typeof constants.O_NONBLOCK !== 'number') throw new Error('Guarded regular-file reads are unavailable on this platform');
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error('Expected a regular file');
    if (before.size > limit) throw new Error(`File exceeds ${limit} bytes`);
    const buffer = Buffer.alloc(before.size + 1); let length = 0;
    while (length < buffer.length) { const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null); if (!bytesRead) break; length += bytesRead; }
    if (length !== before.size) throw new Error('File changed while snapshotting');
    const after = await handle.stat(), disk = await lstat(file);
    for (const key of ['dev', 'ino', 'size', 'mode', 'mtimeMs', 'ctimeMs']) if (before[key] !== after[key] || after[key] !== disk[key]) throw new Error('File changed while snapshotting');
    return { bytes: buffer.subarray(0, length), stat: after };
  } finally { await handle.close(); }
}
export function pythonText(bytes) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw Object.assign(new Error('Expected UTF-8 Python source'), { code: 'INVALID_UTF8' }); }
  if (text.startsWith('\uFEFF')) throw Object.assign(new Error('Multiple leading Python BOM signatures are unsupported'), { code: 'UNSUPPORTED_ENCODING' });
  const bom = bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]));
  const lines = text.split(/\r\n|\r|\n/, 2), cookie = /^[ \t\f]*#[^\r\n]*?coding[:=][ \t]*([-_.a-zA-Z0-9]+)/;
  // PEP 263: first cookie wins; inspect line two only after a blank/comment
  // first line. Inactive later comments are not encoding declarations.
  const first = lines[0].replace(/^[ \t\f]*/, '');
  const declared = cookie.exec(lines[0])?.[1] ?? (first === '' || first.startsWith('#') ? cookie.exec(lines[1] ?? '')?.[1] : undefined);
  if (declared) {
    const normalized = declared.toLowerCase().replaceAll('_', '-');
    const standard = normalized === 'utf-8' || normalized.startsWith('utf-8-');
    if (!standard && !(normalized === 'utf8' && !bom)) throw Object.assign(new Error(`Unsupported Python source encoding/BOM declaration: ${declared.slice(0, 80)}; use coding: utf-8 (UTF-8-only policy)`), { code: 'UNSUPPORTED_ENCODING' });
  }
  return text;
}
