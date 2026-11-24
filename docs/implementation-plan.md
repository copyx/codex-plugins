# TypeScript LSP implementation

Related documents: [implementation details](typescript-lsp-implementation.md),
[verification commands](verify-usage.md), [verification record](verification.md).

## Initial 0.1.0 scope (historical)

Scope: repo marketplace, local stdio MCP navigation, and a synchronous
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

## Verification automation (#17)

Keep plugin runtime files unchanged. Replace the one-off Codex test runner with
shared prerequisite, subprocess/RPC, and local Responses fixture logic used by
isolated and installed verification. Add `verify` (static + all tests + isolated
integration) and `verify:installed` (read installed/trusted hook + real error/fix
patches). Missing prerequisites, skipped tests, missing/untrusted hooks, missing
or stale diagnostic context must fail. Never change installation/trust in the
installed mode. Use ephemeral sessions, credential-free child environments,
in-memory context assertions, and unconditional temp/process cleanup; retain no
raw model request logs. Test failure gates and cleanup before implementation,
then run both commands on this Mac and commit automation/docs separately.

## 0.2.0 completed extension and release

The additive release keeps the original definition/references/hover and patch
diagnostics contracts and exposes eleven tools:

1. Document symbols, type definition, and implementation navigation.
2. Anchor/config-scoped project symbols, live-diagnostic quickfix previews, and
   multi-file rename previews with context-bound selection IDs.
3. A shared existing-file text edit engine and two explicit application tools
   that regenerate a current LSP proposal before matching the selection.

The implementation, preview identity, audited command effect, recovery model,
and concurrency limits are documented in [implementation details](typescript-lsp-implementation.md).
The [verification record](verification.md) separates earlier 0.1.0 evidence from
the 0.2.0 checkout/isolated release checks. Installed verification remains
compatible with earlier packages and only exercises newly advertised tools.

No earlier versioning policy was present. Use 0.2.0 for these backward-compatible
additions; keep the plugin manifest and MCP server version equal. The local
marketplace entry derives the version from the manifest. User installation and
hook review are release operations, separate from the isolated verification.
