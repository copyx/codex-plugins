import { createInterface } from 'node:readline';
import { resolveProject } from './lib/project.mjs';
import { LspSession } from './lib/lsp.mjs';

const methods = { definition: 'textDocument/definition', references: 'textDocument/references', hover: 'textDocument/hover' };
const tools = Object.keys(methods).map(name => ({
  name,
  description: `${name} for a local TypeScript/JavaScript file. Use an absolute workspace_root. Positions are 1-based lines and UTF-16 characters; returned LSP locations are 0-based.`,
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  inputSchema: {
    type: 'object', additionalProperties: false,
    properties: { workspace_root: { type: 'string' }, file: { type: 'string' }, line: { type: 'integer', minimum: 1 }, character: { type: 'integer', minimum: 1 } },
    required: ['workspace_root', 'file', 'line', 'character'],
  },
}));
let active;
async function dispatch(message) {
  if (message.method === 'initialize') return { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'typescript-lsp', version: '0.1.0' } };
  if (message.method === 'ping') return {};
  if (message.method === 'resources/list') return { resources: [] };
  if (message.method === 'resources/templates/list') return { resourceTemplates: [] };
  if (message.method === 'tools/list') return { tools };
  if (message.method !== 'tools/call') throw Object.assign(new Error('Method not found'), { code: -32601 });
  try {
    const { name, arguments: args } = message.params ?? {};
    if (!Object.hasOwn(methods, name)) throw new Error('Unknown tool');
    if (!args || typeof args.workspace_root !== 'string' || typeof args.file !== 'string' || !Number.isInteger(args.line) || args.line < 1 || !Number.isInteger(args.character) || args.character < 1) throw new Error('Expected workspace_root, file, and positive integer line/character');
    const project = await resolveProject(args.file, args.workspace_root);
    active = new LspSession(project);
    await active.start();
    const uri = await active.sync(project.file);
    // Early tsserver queries can return unresolved import aliases while the
    // configured project is loading. A diagnostic publication provides a
    // bounded readiness barrier before navigation.
    const readiness = await active.diagnostics([project.file]);
    if (readiness[0].status !== 'received') throw new Error('Project diagnostics timed out; navigation readiness is unknown');
    const params = { textDocument: { uri }, position: { line: args.line - 1, character: args.character - 1 } };
    if (name === 'references') params.context = { includeDeclaration: true };
    const result = await active.request(methods[name], params);
    return { content: [{ type: 'text', text: JSON.stringify({ project_root: project.root, config: project.config, result }) }] };
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
