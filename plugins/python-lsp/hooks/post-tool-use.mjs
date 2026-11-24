import { resolveProject, patchFiles } from '../lib/project.mjs';
import { LspSession } from '../lib/lsp.mjs';
import path from 'node:path';

let active;
process.on('exit', () => active?.kill());
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { active?.kill(); process.exit(0); });
const output = context => console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: context.length > 10000 ? context.slice(0, 9900) + '\nIncomplete: remaining diagnostic context omitted.' : context } }));

try {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 2 * 1024 * 1024) throw new Error('Hook input exceeds 2 MiB');
  }
  const event = JSON.parse(input);
  if (event.hook_event_name === 'PostToolUse' && event.tool_name === 'apply_patch') {
    const patch = typeof event.tool_input === 'string' ? event.tool_input : event.tool_input?.command ?? event.tool_input?.patch;
    if (typeof patch !== 'string') throw new Error('apply_patch command missing; diagnostics incomplete');
    const files = patchFiles(patch);
    if (files.length) {
      const lines = ['Python LSP post-patch diagnostics (changed files only; disk snapshot):'];
      const groups = new Map();
      const deadline = Date.now() + 20000;
      const watchdog = setTimeout(() => {
        output([...lines, 'Incomplete: total diagnostic deadline reached; remaining files were not checked.'].join('\n'));
        active?.kill(); process.exit(0);
      }, 20000);
      watchdog.unref();
      if (files.length > 20) lines.push('Incomplete: only the first 20 changed source files were checked.');
      for (const file of files.slice(0, 20)) {
        try {
          const project = await resolveProject(file, event.cwd);
          const key = JSON.stringify([project.root, project.config, project.environment.path]);
          if (!groups.has(key)) groups.set(key, { project, files: [] });
          groups.get(key).files.push(project.file);
        } catch (error) { lines.push(`${file}: not checked: ${error.message}`); }
      }
      for (const { project, files: groupFiles } of groups.values()) {
        if (Date.now() > deadline - 1000) { lines.push('Incomplete: total diagnostic deadline reached.'); break; }
        try {
          active = new LspSession(project, { timeoutMs: Math.min(8000, deadline - Date.now() - 1000) });
          await active.start();
          active.diagnosticMs = Math.max(1, Math.min(6000, deadline - Date.now() - 1000));
          const results = await active.diagnostics([...new Set(groupFiles)]);
          for (const result of results) {
            const file = path.relative(event.cwd, result.file);
            if (result.status === 'timeout') lines.push(`${file}: incomplete (publishDiagnostics timed out; not a clean result)`);
            else if (!result.diagnostics.length) lines.push(`${file}: no diagnostics published for this snapshot`);
            else for (const d of result.diagnostics.slice(0, 30)) lines.push(`${file}:${d.range.start.line + 1}:${d.range.start.character + 1}: ${['unknown', 'error', 'warning', 'information', 'hint'][d.severity ?? 0] ?? 'unknown'} ${d.source ?? 'ty'} ${d.code ?? '?'} ${d.message}`);
            if (result.diagnostics.length > 30) lines.push(`${file}: incomplete (remaining diagnostics omitted)`);
          }
        } catch (error) { lines.push(`${project.root}: diagnostics incomplete: ${error.message}`); }
        finally { await active?.close(); active = undefined; }
      }
      clearTimeout(watchdog); output(lines.join('\n'));
    }
  }
} catch (error) { output(`Python LSP diagnostics incomplete: ${error.message}`); }
