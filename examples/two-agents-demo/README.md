# Two-agent collision demo

The hero scenario in ~5 seconds: two AI agents reach for the same symbol, and the
second is warned **before** it edits anything.

```bash
npm run demo
```

This builds the packages and runs [`demo.mjs`](./demo.mjs) against a throwaway repo.
Record it as a GIF for the README — it is the launch asset.

What it shows:

1. `cursor-bob` claims `AuthService.verify` → _safe to proceed_.
2. `claude-a` reaches for the same symbol → **⛔ COLLISION**, with who/why/ETA and options.
3. `tower status` — both claims live, no merge conflict, no wasted work.
