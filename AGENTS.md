# piwin Claude Code session backend

Independent plugin. Host never vendors this adapter.

- Speak `piwin-agent-stdio` JSONL. Do not parse ANSI.
- Always target a user-owned `claude` binary via Host `runtime.binaryPath`. Never substitute the SDK optional platform binary.
- Production transport is the CLI stream-json protocol in `src/cli-query.ts`. Do not add a second silent SDK fallback.
- Tests inject a fake query port and must not download/spawn the SDK CLI.
- Native settings: coding preset uses `user` + `project` + `local`. Isolated fixtures may pass empty sources explicitly.
- Native option ids and cancellation travel verbatim. Questions are not permissions.
- Do not persist synthetic `cc-<Host-id>` as a native session. Load/resume of a missing id must fail, not open a fresh session.
- Do not log credentials or account metadata.
