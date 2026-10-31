# piwin Claude Code session backend

Independent plugin. Host never vendors this adapter.

- Speak `piwin-agent-stdio` JSONL. Do not parse ANSI.
- Always target a user-owned `claude` binary via Host `runtime.binaryPath`. Never substitute the SDK optional platform binary.
- Pin Agent SDK `@anthropic-ai/claude-agent-sdk` 0.3.282 at the dynamic import boundary. Tests inject a fake query port and must not download/spawn the SDK CLI.
- Native settings: coding preset uses `user` + `project` + `local`. Isolated fixtures may pass empty sources explicitly.
- Native option ids and cancellation travel verbatim. Questions are not permissions.
- Do not log credentials or account metadata.
