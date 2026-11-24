import { prerequisites, runCodexVerification } from './lib/codex-verification.mjs';

try { await runCodexVerification(await prerequisites({ installed: true }), { installed: true }); }
catch (error) { console.error(`FAIL verify:installed: ${error.message}`); process.exitCode = 1; }
