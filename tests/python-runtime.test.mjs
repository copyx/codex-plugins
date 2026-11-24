import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveTyRuntime, runtimeConfigPath } from '../plugins/python-lsp/lib/runtime.mjs';

async function fixture(t) {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), 'python-runtime-home-')));
  t.after(() => rm(home, { recursive:true, force:true }));
  await mkdir(path.dirname(runtimeConfigPath(home)), { recursive:true, mode:0o700 });
  return home;
}
const save = (home, text) => writeFile(runtimeConfigPath(home), text, { mode:0o600 });
test('Python runtime config uses fixed Node user home and explicit environment has highest priority', async t => {
  const home = await fixture(t);
  assert.equal(runtimeConfigPath(home), path.join(home,'.config/codex-python-lsp/config.json'));
  await save(home, '{"ty_path":"/tools/config/ty"}');
  assert.deepEqual(await resolveTyRuntime({ env:{}, home }), { command:'/tools/config/ty', source:'user_config', config:runtimeConfigPath(home) });
  await save(home, 'invalid JSON');
  assert.deepEqual(await resolveTyRuntime({ env:{PYTHON_LSP_TY:'/tools/env/ty'}, home }), { command:'/tools/env/ty', source:'environment', config:null });
});
test('Python runtime never falls back from an invalid explicit environment or to PATH/workspace config', async t => {
  const home = await fixture(t);
  await save(home, '{"ty_path":"/tools/config/ty"}');
  for (const value of ['', 'ty', './bin/ty']) await assert.rejects(resolveTyRuntime({ env:{PYTHON_LSP_TY:value,PATH:'/tools'}, home }), /PYTHON_LSP_TY.*absolute/);
  await rm(runtimeConfigPath(home));
  await assert.rejects(resolveTyRuntime({ env:{PATH:'/tools',XDG_CONFIG_HOME:'/workspace/config',CODEX_HOME:'/workspace/.codex'}, home }), /PYTHON_LSP_TY.*config.json/);
});
test('Python runtime config rejects malformed, unknown, relative and oversized settings with no fallback', async t => {
  const home = await fixture(t);
  for(const text of ['not json','null','[]','{}','{"ty_path":"ty"}','{"ty_path":12}','{"ty_path":"/ty","extra":true}','{"ty_path":"/ty\\n"}']) {
    await save(home,text); await assert.rejects(resolveTyRuntime({env:{},home}), /config.json|ty_path/);
  }
  await save(home,' '.repeat(16385));
  await assert.rejects(resolveTyRuntime({env:{},home}), /16 KiB/);
});
test('Python runtime settings must be a user-owned private-write regular file in a private-write config directory', async t => {
  const home = await fixture(t), config=runtimeConfigPath(home);
  await save(home,'{"ty_path":"/ty"}'); await chmod(config,0o666);
  await assert.rejects(resolveTyRuntime({env:{},home}), /writable/);
  await chmod(config,0o600); await chmod(path.dirname(config),0o777);
  await assert.rejects(resolveTyRuntime({env:{},home}), /writable/);
  await chmod(path.dirname(config),0o700); await rm(config);
  const target=path.join(home,'other.json'); await writeFile(target,'{"ty_path":"/ty"}'); await symlink(target,config);
  await assert.rejects(resolveTyRuntime({env:{},home}), /symlink|regular/);
  await rm(config); await mkdir(config);
  await assert.rejects(resolveTyRuntime({env:{},home}), /regular/);
});
test('Python runtime refuses absent/relative Node home instead of reading workspace .config', async () => {
  for(const home of ['', '.', 'relative-home']) {
    assert.throws(()=>runtimeConfigPath(home),/absolute user home/);
    await assert.rejects(resolveTyRuntime({env:{},home}),/absolute user home/);
    assert.equal((await resolveTyRuntime({env:{PYTHON_LSP_TY:'/tools/ty'},home})).source,'environment');
  }
});
