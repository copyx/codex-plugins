import { readdir, readFile, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import assert from 'node:assert/strict';

async function walk(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (['.git', '.omx', 'node_modules'].includes(entry.name)) continue;
    const file = path.join(dir, entry.name);
    files.push(...(entry.isDirectory() ? await walk(file) : [file]));
  }
  return files;
}
const files = await walk('.');
for (const file of files) {
  if (file.endsWith('.mjs')) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  if (file.endsWith('.json')) JSON.parse(await readFile(file, 'utf8'));
  if (file.endsWith('.md')) {
    for (const [, target] of (await readFile(file, 'utf8')).matchAll(/\]\(([^)]+)\)/g)) {
      if (/^(?:https?:|#)/.test(target)) continue;
      await access(path.resolve(path.dirname(file), target.split('#')[0]));
    }
  }
}
const catalog = JSON.parse(await readFile('.agents/plugins/marketplace.json', 'utf8'));
for (const entry of catalog.plugins) {
  assert.ok(entry.source.path.startsWith('./plugins/'));
  const manifest = JSON.parse(await readFile(path.join(entry.source.path, '.codex-plugin/plugin.json'), 'utf8'));
  assert.equal(entry.name, manifest.name);
  const hooks = JSON.parse(await readFile(path.join(entry.source.path, manifest.hooks), 'utf8'));
  assert.equal(hooks.hooks.PostToolUse[0].matcher, '^apply_patch$');
  const mcp = JSON.parse(await readFile(path.join(entry.source.path, manifest.mcpServers), 'utf8'));
  assert.equal(mcp.mcpServers[entry.name].command, 'node');
}
console.log(`PASS: ${files.length} files checked for syntax/JSON/local Markdown links; catalog, manifest, MCP, and hook paths connected`);
