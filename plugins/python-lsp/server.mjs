import { createInterface } from 'node:readline';
import { resolveProject, markLocations } from './lib/project.mjs';
import { LspSession } from './lib/lsp.mjs';
import { codeActionsPreview } from './lib/preview.mjs';

const methods = { definition: 'textDocument/definition', references: 'textDocument/references', hover: 'textDocument/hover', document_symbols: 'textDocument/documentSymbol', project_symbols: 'workspace/symbol', type_definition: 'textDocument/typeDefinition', implementation: 'textDocument/implementation', code_actions_preview: 'textDocument/codeAction' };
const fileFields = { workspace_root: { type: 'string' }, file: { type: 'string' } };
const positionFields = { line: { type: 'integer', minimum: 1 }, character: { type: 'integer', minimum: 1 } };
const pointSchema = { type: 'object', additionalProperties: false, properties: positionFields, required: ['line', 'character'] };
const parameters = { document_symbols: {}, project_symbols: { query: { type: 'string', minLength: 1 } }, code_actions_preview: { range: { type: 'object', additionalProperties: false, properties: { start: pointSchema, end: pointSchema }, required: ['start', 'end'] } } };
function toolResult(output) {
  const text = JSON.stringify(output);
  if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('MCP result exceeds 1 MiB; narrow the request');
  return { content: [{ type: 'text', text }] };
}
function validPosition(point) {
  return point && Number.isSafeInteger(point.line) && point.line >= 0 && Number.isSafeInteger(point.character) && point.character >= 0;
}
function validRange(range) {
  return range && validPosition(range.start) && validPosition(range.end)
    && (range.start.line < range.end.line || (range.start.line === range.end.line && range.start.character <= range.end.character));
}
function validUri(uri) {
  try { return typeof uri === 'string' && Boolean(new URL(uri).protocol); } catch { return false; }
}
const validLocation = location => location && validUri(location.uri) && validRange(location.range);
const validLocationLink = link => link && validUri(link.targetUri) && validRange(link.targetRange) && validRange(link.targetSelectionRange)
  && (link.originSelectionRange === undefined || validRange(link.originSelectionRange));
function validLocationResult(result) {
  return result === null || validLocation(result) || (Array.isArray(result) && (result.every(validLocation) || result.every(validLocationLink)));
}
const tools = Object.keys(methods).map(name => ({
  name, description: name === 'document_symbols'
    ? 'List symbols in one local .py/.pyi file using ty 0.0.109. Use absolute workspace_root and file, without line/character. Preserves hierarchical LSP DocumentSymbol children or flat SymbolInformation with 0-based UTF-16 ranges. Returns [] when no symbols exist. Read-only.'
    : name === 'project_symbols'
      ? 'Search symbol names in the ty session selected by the anchor file and its Python project/config/environment. Use absolute workspace_root, file, and a non-blank query. Returns selected search_scope and original symbol locations/kinds with workspace boundary labels. This does not promise repository-wide coverage or a hard project-root filter. Read-only.'
    : name === 'type_definition'
      ? 'Find the declaration location of the type at a local .py/.pyi position using ty 0.0.109. Use an absolute workspace_root, a file inside it and 1-based UTF-16 line/character. Preserves 0-based LSP Location/LocationLink results and marks external locations. Returns [] when no type is found. Read-only.'
    : name === 'implementation'
      ? 'Find implementation locations at a local .py/.pyi position using ty 0.0.109. Use an absolute workspace_root, a file inside it and 1-based UTF-16 line/character. Preserves original 0-based Location/LocationLink results, including base classes or members returned by the server. Returns [] for no result. Read-only.'
    : name === 'code_actions_preview'
      ? 'Preview quickfix candidates for a 1-based UTF-16 range (end exclusive; zero-width cursor allowed) using fresh matching Python diagnostics. Returns import/suppression classification, file edits, boundaries and context-bound selection IDs. Never applies edits, executes commands or resolves deferred actions.'
    : `${name} for a local .py/.pyi file using ty 0.0.109. workspace_root is absolute; file is workspace-relative or absolute within it. line/character are 1-based UTF-16; results keep 0-based LSP ranges. External locations are marked; their source is not read by this bridge. Read-only MVP.`,
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  inputSchema: { type: 'object', additionalProperties: false, properties: { ...fileFields, ...(parameters[name] ?? positionFields) }, required: ['workspace_root', 'file', ...Object.keys(parameters[name] ?? positionFields)] },
}));
let active;
async function dispatch(message) {
  if (message.method === 'initialize') return { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'python-lsp', version: '0.1.1' } };
  if (message.method === 'ping') return {};
  if (message.method === 'resources/list') return { resources: [] };
  if (message.method === 'resources/templates/list') return { resourceTemplates: [] };
  if (message.method === 'tools/list') return { tools };
  if (message.method !== 'tools/call') throw Object.assign(new Error('Method not found'), { code: -32601 });
  try {
    const { name, arguments: args } = message.params ?? {};
    if (!Object.hasOwn(methods, name)) throw new Error('Unknown tool');
    const documentSymbols = name === 'document_symbols';
    const projectSymbols = name === 'project_symbols';
    const quickfixPreview = name === 'code_actions_preview';
    const locationRequest = name === 'type_definition' || name === 'implementation';
    const allowed = ['workspace_root', 'file', ...Object.keys(parameters[name] ?? positionFields)];
    if (!args || Object.keys(args).some(k => !allowed.includes(k)) || typeof args.workspace_root !== 'string' || typeof args.file !== 'string') throw new Error(`Expected only ${allowed.join(', ')}`);
    if (!documentSymbols && !projectSymbols && !quickfixPreview && (!Number.isInteger(args.line) || args.line < 1 || !Number.isInteger(args.character) || args.character < 1)) throw new Error('Expected positive integer line/character');
    if (projectSymbols && (typeof args.query !== 'string' || !args.query.trim())) throw new Error('Expected a non-blank string query');
    const project = await resolveProject(args.file, args.workspace_root);
    active = new LspSession(project); await active.start();
    if (quickfixPreview) return toolResult(await codeActionsPreview(project, active, args));
    if (documentSymbols && !active.capabilities.documentSymbolProvider) throw new Error('ty server does not support textDocument/documentSymbol');
    if (projectSymbols && !active.capabilities.workspaceSymbolProvider) throw new Error('ty server does not support workspace/symbol');
    if (name === 'type_definition' && !active.capabilities.typeDefinitionProvider) throw new Error('ty server does not support textDocument/typeDefinition');
    if (name === 'implementation' && !active.capabilities.implementationProvider) throw new Error('ty server does not support textDocument/implementation');
    const uri = await active.sync(project.file);
    const params = projectSymbols ? { query: args.query } : { textDocument: { uri }, ...(documentSymbols ? {} : { position: active.position(uri, args.line, args.character) }), ...(name === 'references' ? { context: { includeDeclaration: true } } : {}) };
    const response = await active.request(methods[name], params);
    if (locationRequest && !validLocationResult(response)) throw new Error(`Invalid ${name === 'implementation' ? 'implementation' : 'typeDefinition'} response: expected Location, Location[], LocationLink[] or null`);
    if ((documentSymbols || projectSymbols) && response !== null && !Array.isArray(response)) throw new Error(`Invalid ${methods[name]} response: expected array or null`);
    const result = documentSymbols ? response ?? [] : await markLocations(projectSymbols || locationRequest ? response ?? [] : response, project.workspace);
    const output = { workspace_root: project.workspace, project_root: project.root, config: project.config, environment: project.environment, server: { name: 'ty', version: '0.0.109', executable: active.command, configuration_source: active.runtime.source }, result };
    if (projectSymbols) output.search_scope = { kind: 'selected_project_session', workspace_root: project.workspace, project_root: project.root, config: project.config, anchor_file: project.file };
    return toolResult(output);
  } catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
  finally { await active?.close(); active = undefined; }
}
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
let stopping = false;
async function stop() { stopping = true; input.close(); await active?.close(); }
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { void stop(); });
process.on('exit', () => active?.kill());
process.stdout.on('error', () => { void stop(); });
for await (const line of input) {
  if (stopping) break;
  let message;
  try { if (Buffer.byteLength(line) > 1024 * 1024) throw new Error('MCP input exceeds 1 MiB'); message = JSON.parse(line); }
  catch { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n'); continue; }
  if (!message || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } }) + '\n'); continue;
  }
  if (message.id === undefined) continue;
  let response;
  try { response = { result: await dispatch(message) }; } catch (e) { response = { error: { code: e.code ?? -32603, message: e.message } }; }
  if (!stopping) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, ...response }) + '\n');
}
await stop();
