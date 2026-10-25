#!/usr/bin/env node
// Fast (<20ms) SessionStart hook confirming SoundClud workspace invariants are active.

let _stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  _stdin += chunk;
});
process.stdin.on('end', () => {
  const payload = {
    injectSteps: [
      {
        ephemeralMessage:
          'SoundClud workspace active: Enforce Universal Portability (Zero Per-Track/Per-User/Per-Machine Patches), Zero-PII Hygiene (`npm run check:hygiene`), Offline Test Determinism (`npm run verify`), and consult `docs/ARCHITECTURE_SPEC.md` + `AGENTS.md`.'
      }
    ]
  };
  process.stdout.write(`${JSON.stringify(payload)}\n`);
});
