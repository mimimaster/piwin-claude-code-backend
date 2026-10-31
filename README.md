# piwin Claude Code backend

Independent `sessionBackend` extension. It talks `piwin-agent-stdio` to a Host and drives a **user-owned** local `claude` executable over its stream-json CLI.

Install from the piwin Marketplace as an ordinary extension (`mimimaster/claude-code`).
Enable it in Settings → Agent Backends. This adapter does **not** include the Claude
CLI; install and log in to Claude Code on the Host yourself.


## Rules

- Production connection path is the user-owned CLI (`src/cli-query.ts`). This plugin does not import or spawn `@anthropic-ai/claude-agent-sdk` in production.
- Host supplies `runtime.binaryPath`. Never substitute SDK platform binaries.
- Tests inject a fake query port and must not download/spawn the SDK CLI.
- Coding preset setting sources: `user`, `project`, `local`. Do not silently apply empty settings in production.
- `session/new` does not persist a synthetic `cc-<host-id>` native id. Load/resume require the real vendor session id.
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
