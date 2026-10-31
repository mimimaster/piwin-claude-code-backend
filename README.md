# piwin Claude Code backend

Independent `sessionBackend` extension. It talks `piwin-agent-stdio` to a Host and drives a **user-owned** local `claude` executable.

## Rules

- Host supplies `runtime.binaryPath`. This plugin never ships or substitutes `@anthropic-ai/claude-agent-sdk-*` platform binaries.
- Pinned SDK import (when present): `@anthropic-ai/claude-agent-sdk@0.3.282`. Tests use an injected query port.
- Coding preset setting sources: `user`, `project`, `local`. Do not silently apply SDK-empty settings in production.
- Artifact: `pnpm build` writes `dist/agent.mjs` and integrity-pins `piwin.json`.

## Verify

Pinned toolchain: `pnpm@9.15.0`, Node `>=22.23.4`. Do not solve esbuild with a blanket script-approval file.

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

Real provider/network prompts are out of scope for the default test suite.
