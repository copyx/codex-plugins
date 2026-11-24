import { prerequisites, runCodexVerification } from './lib/codex-verification.mjs';

try { await runCodexVerification(await prerequisites()); }
catch (error) { console.error(`FAIL: ${error.message}`); process.exitCode = 1; }
