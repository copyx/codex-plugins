# TypeScript LSP implementation

Scope: private repo marketplace, local stdio MCP navigation, and a synchronous
PostToolUse command hook for apply_patch diagnostics. No global configuration,
publication, commits, or dependency installation.

Implementation choices:

- Use Node built-ins, newline-delimited MCP JSON-RPC, and Content-Length LSP.
- Require an absolute workspace root for navigation; canonicalize paths and reject
  files outside it, including symlink escapes. Find the nearest tsconfig/jsconfig
  inside that root and resolve TypeScript from project node_modules only.
- Use a short-lived LSP process per navigation request and per hook project group.
  This trades startup time for isolation and avoids a daemon, sockets, stale
  cross-request diagnostics, and cross-root state. Hook input selects patch paths,
  never shell commands; errors/timeouts become explicitly incomplete context.
- Register publishDiagnostics capability. Wait for notifications, including those
  without version, and briefly settle multipart publications. Never equate timeout
  with a clean file. Bound requests, total hook time, context size, and cleanup.

Validation sequence:

1. Write tests for root/config/TypeScript resolution, patch add/update/move/delete,
   symlink boundaries, and stdio behavior before implementation.
2. Exercise real definition/references/hover and didChange TS2345 with the local
   typescript-language-server and project TypeScript in temporary fixtures.
3. Exercise command-hook JSON input/output and MCP over real child stdio.
4. In a temporary CODEX_HOME only, discover the catalog and install the plugin;
   attempt runtime hook delivery without copying account credentials. Record the
   exact boundary if authentication/network prevents a real model turn.
5. Run the full test suite, syntax/metadata checks, and git diff --check; leave a
   concise test report linked to files and reproducible commands.

Compatibility finding: Codex 0.169.1 explicitly skips hook loading for portable
AgentPlugin manifests in core-plugins/src/loader.rs. Use only the supported
`.codex-plugin/plugin.json` manifest with `.mcp.json` for this version; adding a
root portable manifest would take precedence and silently disable hooks.
The local Responses fixture proves the next model request contains hook context
without using a real model or copying authentication. Actual app-server RPC calls
separately prove the installed MCP navigation tools work inside Codex.
