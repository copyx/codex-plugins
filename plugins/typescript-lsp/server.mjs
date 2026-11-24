import { createInterface } from 'node:readline';
import { resolveProject } from './lib/project.mjs';
import { LspSession } from './lib/lsp.mjs';
import { codeActionsPreview, renamePreview } from './lib/preview.mjs';
import { applyCodeAction, applyRename } from './lib/operations.mjs';

const methods = {
  definition: 'textDocument/definition',
  references: 'textDocument/references',
  hover: 'textDocument/hover',
  document_symbols: 'textDocument/documentSymbol',
  type_definition: 'textDocument/typeDefinition',
  implementation: 'textDocument/implementation',
  project_symbols: 'workspace/symbol',
  code_actions_preview: 'textDocument/codeAction',
  rename_preview: 'textDocument/rename',
  code_action_apply: 'textDocument/codeAction',
  rename_apply: 'textDocument/rename',
};
const writeTools = ['code_action_apply', 'rename_apply'];
const positionFields = { line: { type: 'integer', minimum: 1 }, character: { type: 'integer', minimum: 1 } };
const pointSchema = { type: 'object', additionalProperties: false, properties: positionFields, required: ['line', 'character'] };
const rangeFields = { range: { type: 'object', additionalProperties: false, properties: { start: pointSchema, end: pointSchema }, required: ['start', 'end'] } };
const renameFields = { ...positionFields, new_name: { type: 'string', minLength: 1 } };
const selectionField = { selection_id: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' } };
const parameters = {
  document_symbols: {},
  project_symbols: { query: { type: 'string', minLength: 1 } },
  code_actions_preview: rangeFields,
  rename_preview: renameFields,
  code_action_apply: { ...rangeFields, ...selectionField },
  rename_apply: { ...renameFields, ...selectionField },
};
const tools = Object.keys(methods).map(name => ({
  name,
  description: name === 'code_action_apply'
    ? 'WRITE: requery the original quickfix range, match selection_id, validate and apply existing-file text edits with conflict-aware recovery. Rejects unsupported commands/resources and stale selections. Returns explicit post-apply diagnostics; the apply_patch hook does not run for this tool.'
    : name === 'rename_apply'
      ? 'WRITE: requery the original position and new_name, match selection_id, then apply existing-file rename edits with conflict-aware recovery. Never accepts client-submitted edits or commands.'
      : name === 'code_actions_preview'
    ? 'Preview quickfix candidates for a 1-based UTF-16 range using actual published diagnostics. Never writes files or executes commands. Selection IDs require a fresh matching preview before any future application.'
    : name === 'rename_preview'
      ? 'Preview rename edits across files for a 1-based UTF-16 position and new_name. Never writes files. Returns per-file boundaries, preimage hashes and a context-bound selection ID.'
      : name === 'project_symbols'
    ? 'Search symbols by name in the project session selected by the anchor file. This is not a repository-wide search. Use workspace_root, file, query.'
    : name === 'document_symbols'
    ? 'List symbols in one TypeScript/JavaScript file. Use an absolute workspace_root. Returns flat LSP symbols with name, numeric kind, and 0-based location ranges.'
    : `${name} for a local TypeScript/JavaScript file. Use an absolute workspace_root. Positions are 1-based lines and UTF-16 characters; returned LSP locations are 0-based.`,
  annotations: { readOnlyHint: !writeTools.includes(name), destructiveHint: writeTools.includes(name), openWorldHint: false },
  inputSchema: {
    type: 'object', additionalProperties: false,
    properties: { workspace_root: { type: 'string' }, file: { type: 'string' }, ...(parameters[name] ?? positionFields) },
    required: ['workspace_root', 'file', ...Object.keys(parameters[name] ?? positionFields)],
  },
}));
let active;
async function dispatch(message) {
  if (message.method === 'initialize') return { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'typescript-lsp', version: '0.2.0' } };
  if (message.method === 'ping') return {};
  if (message.method === 'resources/list') return { resources: [] };
  if (message.method === 'resources/templates/list') return { resourceTemplates: [] };
  if (message.method === 'tools/list') return { tools };
  if (message.method !== 'tools/call') throw Object.assign(new Error('Method not found'), { code: -32601 });
  try {
    const { name, arguments: args } = message.params ?? {};
    if (!Object.hasOwn(methods, name)) throw new Error('Unknown tool');
    if (!args || typeof args.workspace_root !== 'string' || typeof args.file !== 'string') throw new Error('Expected workspace_root and file');
    if (writeTools.includes(name)) {
      const allowed = ['workspace_root', 'file', ...Object.keys(parameters[name])];
      if (Object.keys(args).some(k => !allowed.includes(k))) throw new Error('Write tools accept only the original request and selection_id, not edits/basis/commands');
      if (typeof args.selection_id !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(args.selection_id)) throw new Error('Expected a valid preview selection_id');
    }
    if (!['document_symbols', 'project_symbols', 'code_actions_preview', 'code_action_apply'].includes(name) && (!Number.isInteger(args.line) || args.line < 1 || !Number.isInteger(args.character) || args.character < 1)) throw new Error('Expected workspace_root, file, and positive integer line/character');
    if (name === 'project_symbols' && (typeof args.query !== 'string' || !args.query.trim())) throw new Error('Expected a non-empty query');
    if (['rename_preview', 'rename_apply'].includes(name) && (typeof args.new_name !== 'string' || !args.new_name.trim() || /[\r\n\0]/.test(args.new_name))) throw new Error('Expected a non-empty new_name without line breaks');
    const project = await resolveProject(args.file, args.workspace_root);
    active = new LspSession(project);
    await active.start();
    const uri = await active.sync(project.file);
    // Early tsserver queries can return unresolved import aliases while the
    // configured project is loading. A diagnostic publication provides a
    // bounded readiness barrier before navigation.
    const readiness = await active.diagnostics([project.file]);
    if (readiness[0].status !== 'received') throw new Error('Project diagnostics timed out; navigation readiness is unknown');
    if (writeTools.includes(name)) {
      const output = name === 'code_action_apply'
        ? await applyCodeAction(project, active, args, uri, readiness[0].diagnostics)
        : await applyRename(project, active, args, uri);
      return { content: [{ type: 'text', text: JSON.stringify(output) }] };
    }
    if (name === 'code_actions_preview' || name === 'rename_preview') {
      const output = name === 'code_actions_preview'
        ? await codeActionsPreview(project, active, args, uri, readiness[0].diagnostics)
        : await renamePreview(project, active, args, uri);
      return { content: [{ type: 'text', text: JSON.stringify(output) }] };
    }
    const params = name === 'project_symbols' ? { query: args.query } : { textDocument: { uri }, ...(name === 'document_symbols' ? {} : { position: { line: args.line - 1, character: args.character - 1 } }) };
    if (name === 'references') params.context = { includeDeclaration: true };
    const result = await active.request(methods[name], params);
    const output = { project_root: project.root, config: project.config, result };
    if (['document_symbols', 'type_definition', 'implementation', 'project_symbols'].includes(name)) output.result ??= [];
    if (name === 'project_symbols') output.search_scope = { kind: 'selected_project_session', workspace_root: project.workspace, project_root: project.root, config: project.config, anchor_file: project.file };
    return { content: [{ type: 'text', text: JSON.stringify(output) }] };
  } catch (error) {
    return { isError: true, content: [{ type: 'text', text: error.message }] };
  } finally { await active?.close(); active = undefined; }
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
let stopping = false;
async function stop() { stopping = true; input.close(); await active?.close(); }
process.on('SIGTERM', () => { void stop(); });
process.on('SIGINT', () => { void stop(); });
process.on('exit', () => active?.kill());
process.stdout.on('error', () => { void stop(); });
for await (const line of input) {
  if (stopping) break;
  let message;
  try {
    if (Buffer.byteLength(line) > 1024 * 1024) throw new Error('MCP input exceeds 1 MiB');
    message = JSON.parse(line);
  } catch {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n');
    continue;
  }
  if (!message || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } }) + '\n');
    continue;
  }
  if (message.id === undefined) continue;
  let response;
  try { response = { result: await dispatch(message) }; }
  catch (error) { response = { error: { code: error.code ?? -32603, message: error.message } }; }
  if (!stopping) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, ...response }) + '\n');
}
await stop();
