// src/main.ts
import { createInterface } from "node:readline";

// src/types.ts
var PROTOCOL_VERSION = 1;
var PINNED_CLAUDE_AGENT_SDK = "0.3.282";
var AGENT_ID = "claude-code";

// src/capabilities.ts
var yes = { supported: true };
var no = (reason) => ({ supported: false, reason });
function claudeCapabilities() {
  return {
    agentId: AGENT_ID,
    nativeCli: yes,
    operations: {
      prompt: yes,
      cancel: yes,
      queue: no("Claude Code does not expose Host queue"),
      intervene: yes,
      setModel: yes,
      setEffort: no("Claude Code has no Host effort control"),
      setMode: no("Claude permission modes are not a Host control yet"),
      slashCommands: yes,
      fileReferences: no("File chips are not a Host Claude operation"),
      images: yes,
      rename: no("Claude catalog rename is not implemented"),
      delete: no("Claude catalog delete is not implemented"),
      archive: no("Claude Code sessions are not Host-archived"),
      pin: no("Claude Code sessions are not Host-pinned"),
      export: no("Export stays in native Claude history"),
      fork: no("Claude Code fork is not a Host operation"),
      rewind: no("Claude Code rewind is not a Host operation"),
      duplicate: no("Claude Code duplicate is not a Host operation"),
      pause: no("Claude Code has no pause"),
      compact: no("Compaction is native-owned"),
      conversationTree: no("Claude Code has no Host conversation tree"),
      coldStorage: no("Claude Code has no Host cold storage"),
      hostSubagents: no("Host subagents are Pi-only"),
      hostTools: no("Host tools are not injected into Claude Code")
    }
  };
}
function claudeOptions(input) {
  return {
    agentId: AGENT_ID,
    models: input.models ?? [],
    ...input.currentModelId === void 0 ? {} : { currentModelId: input.currentModelId },
    modes: [
      { id: "default", label: "Default" },
      { id: "plan", label: "Plan" },
      { id: "acceptEdits", label: "Accept edits" }
    ],
    currentModeId: input.currentModeId ?? "default",
    modeConfirmed: true,
    commands: (input.commands ?? []).map((command) => ({
      name: command.name,
      ...command.description === void 0 ? {} : { description: command.description }
    }))
  };
}
var DEFAULT_PERMISSION_OPTIONS = [
  { optionId: "allow_once", label: "Allow once", kind: "allow_once" },
  { optionId: "allow_always", label: "Allow always", kind: "allow_always" },
  { optionId: "reject_once", label: "Reject once", kind: "reject_once" },
  { optionId: "reject_always", label: "Reject always", kind: "reject_always" }
];

// src/cli-launch.ts
function claudeCliLaunch(input) {
  if (input.backendSessionId.length === 0) throw new Error("native-session-required");
  return {
    backendSessionId: input.backendSessionId,
    args: ["--resume", input.backendSessionId]
  };
}

// src/claude-history.ts
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
var MAX_LINE_CHARS = 256 * 1024;
var MAX_EVENTS = 2e3;
var SKIP_USER_TEXT = /* @__PURE__ */ new Set(["[Request interrupted by user]"]);
function encodeClaudeProjectDir(cwd) {
  let resolved = cwd;
  try {
    resolved = realpathSync(cwd);
  } catch {
  }
  return resolved.replace(/\\/g, "/").replace(/\/+$/, "").replace(/\//g, "-");
}
function claudeSessionJsonlPath(input) {
  return join(input.historyRoot, "projects", encodeClaudeProjectDir(input.cwd), `${input.sessionId}.jsonl`);
}
function defaultClaudeHistoryRoot(env = process.env) {
  if (typeof env.CLAUDE_CONFIG_DIR === "string" && env.CLAUDE_CONFIG_DIR.length > 0) {
    return env.CLAUDE_CONFIG_DIR;
  }
  const home = env.HOME ?? env.USERPROFILE;
  if (typeof home !== "string" || home.length === 0) return void 0;
  return join(home, ".claude");
}
function reconstructClaudeHistory(input) {
  if (input.sessionId.length === 0) return { ok: false, reason: "native session id required" };
  const path = claudeSessionJsonlPath(input);
  const body = (input.readFile ?? readUtf8)(path);
  if (body === void 0) return { ok: false, reason: "native history unavailable" };
  const events = [];
  for (const raw of body.split("\n")) {
    if (events.length >= MAX_EVENTS) break;
    const line = raw.trim();
    if (line.length === 0 || line.length > MAX_LINE_CHARS) continue;
    let record;
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
      record = parsed;
    } catch {
      continue;
    }
    events.push(...emissionsFromRecord(record, input.sessionId));
  }
  if (events.length === 0) return { ok: false, reason: "native history unavailable" };
  return { ok: true, events: events.slice(0, MAX_EVENTS) };
}
function readUtf8(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return void 0;
  }
}
function emissionsFromRecord(record, sessionId) {
  const type = record.type;
  if (type === "user") return userEmissions(record);
  if (type === "assistant") return assistantEmissions(record, sessionId);
  return [];
}
function userEmissions(record) {
  const message = asRecord(record.message);
  const content = message?.content;
  const toolEnds = toolResultEnds(content);
  const text = visibleText(content);
  const events = [...toolEnds];
  if (text.length === 0 || SKIP_USER_TEXT.has(text)) return events;
  const messageId = stringId(record.uuid) ?? `cc-user-${hashText(text)}`;
  events.push(...textMessage("user", messageId, text));
  return events;
}
function assistantEmissions(record, sessionId) {
  const message = asRecord(record.message);
  const content = message?.content;
  const text = visibleText(content);
  const tools = toolUses(content);
  if (text.length === 0 && tools.length === 0) return [];
  const messageId = stringId(message?.id) ?? stringId(record.uuid) ?? `cc-${sessionId}-assistant`;
  const events = [];
  if (text.length > 0) events.push(...textMessage("assistant", messageId, text, stringId(message?.id)));
  for (const tool of tools) {
    events.push({ type: "agent", event: { type: "tool/start", toolCallId: tool.id, toolName: tool.name } });
  }
  return events;
}
function textMessage(role, messageId, text, backendMessageId) {
  return [
    {
      type: "agent",
      event: {
        type: "message/start",
        messageId,
        role,
        ...backendMessageId === void 0 ? {} : { backendMessageId }
      }
    },
    { type: "agent", event: { type: "message/text_delta", messageId, delta: text } },
    { type: "agent", event: { type: "message/end", messageId } }
  ];
}
function visibleText(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    const rec2 = asRecord(block);
    if (rec2?.type === "text" && typeof rec2.text === "string") parts.push(rec2.text);
  }
  return parts.join("").trim();
}
function toolUses(content) {
  if (!Array.isArray(content)) return [];
  const tools = [];
  for (const block of content) {
    const rec2 = asRecord(block);
    if (rec2?.type === "tool_use" && typeof rec2.id === "string" && typeof rec2.name === "string") {
      tools.push({ id: rec2.id, name: rec2.name });
    }
  }
  return tools;
}
function toolResultEnds(content) {
  if (!Array.isArray(content)) return [];
  const events = [];
  for (const block of content) {
    const rec2 = asRecord(block);
    if (rec2?.type === "tool_result" && typeof rec2.tool_use_id === "string") {
      events.push({
        type: "agent",
        event: { type: "tool/end", toolCallId: rec2.tool_use_id, isError: rec2.is_error === true }
      });
    }
  }
  return events;
}
function asRecord(value) {
  return typeof value === "object" && value !== null && Array.isArray(value) === false ? value : void 0;
}
function stringId(value) {
  return typeof value === "string" && value.length > 0 ? value : void 0;
}
function hashText(text) {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash << 5) - hash + text.charCodeAt(index) | 0;
  }
  return Math.abs(hash).toString(36);
}

// src/prompt-content.ts
import { readFileSync as readFileSync2 } from "node:fs";
var MAX_IMAGE_BYTES = 8 * 1024 * 1024;
function claudeImagesFromAttachments(attachments, readFile = readBytes) {
  if (!Array.isArray(attachments) || attachments.length === 0) return { ok: true, images: [] };
  const images = [];
  for (const item of attachments) {
    if (typeof item !== "object" || item === null) continue;
    const rec2 = item;
    if (rec2.kind !== "media") continue;
    const mimeType = typeof rec2.mimeType === "string" ? rec2.mimeType : "";
    const contentKind = rec2.contentKind;
    const isImage = contentKind === "image" || contentKind === void 0 && mimeType.toLowerCase().startsWith("image/");
    if (!isImage) continue;
    if (typeof rec2.path !== "string" || rec2.path.length === 0) {
      return { ok: false, reason: "image attachment is missing a Host media path" };
    }
    const bytes = readFile(rec2.path);
    if (bytes === void 0) return { ok: false, reason: "image attachment could not be read" };
    if (bytes.byteLength > MAX_IMAGE_BYTES) return { ok: false, reason: "image attachment exceeds 8 MiB" };
    images.push({ mimeType: mimeType || "image/png", data: bytes.toString("base64") });
  }
  return { ok: true, images };
}
function readBytes(path) {
  try {
    return readFileSync2(path);
  } catch {
    return void 0;
  }
}

// src/binary.ts
import { existsSync } from "node:fs";
import { delimiter } from "node:path";
var SDK_PLATFORM = /claude-agent-sdk-(darwin|linux|win32)/i;
function isUserOwnedClaudeBinary(path) {
  if (path.length === 0 || path.includes("\0")) return false;
  return !SDK_PLATFORM.test(path);
}
function resolveClaudeBinary(input) {
  const exists = input.pathExists ?? existsSync;
  const env = input.env ?? process.env;
  const searched = [];
  const candidates = [input.hostBinaryPath, env.CLAUDE_CLI, env.CLAUDE_CODE_EXECUTABLE];
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || candidate.length === 0) continue;
    searched.push(candidate);
    if (isUserOwnedClaudeBinary(candidate) && exists(candidate)) return { ok: true, binaryPath: candidate };
  }
  const pathEnv = env.PATH ?? env.Path ?? "";
  for (const dir of pathEnv.split(delimiter)) {
    if (dir.length === 0) continue;
    for (const name of ["claude", "claude.exe"]) {
      const candidate = `${dir.replace(/[/\\]$/, "")}/${name}`;
      searched.push(candidate);
      if (isUserOwnedClaudeBinary(candidate) && exists(candidate)) return { ok: true, binaryPath: candidate };
    }
  }
  return { ok: false, searched };
}

// src/frames.ts
function parseFrame(line) {
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    return void 0;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return void 0;
  const rec2 = value;
  if (rec2.protocolVersion !== PROTOCOL_VERSION) return void 0;
  if (rec2.kind === "request") {
    if (typeof rec2.requestId !== "string" || typeof rec2.method !== "string") return void 0;
    return rec2;
  }
  if (rec2.kind === "response" || rec2.kind === "event") return rec2;
  return void 0;
}
function requestFrame(scope, requestId, method, params) {
  return { protocolVersion: PROTOCOL_VERSION, kind: "request", scope, requestId, method, params };
}
function okFrame(request, result) {
  return { protocolVersion: PROTOCOL_VERSION, kind: "response", scope: request.scope, requestId: request.requestId, method: request.method, ok: true, result };
}
function errFrame(request, code, message) {
  return { protocolVersion: PROTOCOL_VERSION, kind: "response", scope: request.scope, requestId: request.requestId, method: request.method, ok: false, error: { code, message } };
}
function eventFrame(scope, emission) {
  return { protocolVersion: PROTOCOL_VERSION, kind: "event", scope, emission };
}

// src/map-claude.ts
function textFromContent(content) {
  const parts = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const rec2 = block;
    if (rec2.type === "text" && typeof rec2.text === "string") parts.push(rec2.text);
  }
  return parts.join("");
}
function mapClaudeMessage(state, message) {
  const runId = state.runId;
  if (message.type === "system" && message.subtype === "init") {
    state.sessionId = message.session_id;
    return [{ type: "session/started", sessionId: message.session_id }];
  }
  if (message.type === "stream_event" && message.event.type === "content_block_delta" && message.event.delta?.type === "text_delta" && typeof message.event.delta.text === "string") {
    state.streamed = true;
    if (state.messageId === void 0) {
      state.messageId = `cc-${state.sessionId}-assistant`;
      state.started = true;
      return [
        { type: "message/start", messageId: state.messageId, role: "assistant", ...runId === void 0 ? {} : { runId } },
        { type: "message/text_delta", messageId: state.messageId, delta: message.event.delta.text, ...runId === void 0 ? {} : { runId } }
      ];
    }
    return [{ type: "message/text_delta", messageId: state.messageId, delta: message.event.delta.text, ...runId === void 0 ? {} : { runId } }];
  }
  if (message.type === "assistant") {
    const backendMessageId = typeof message.message.id === "string" ? message.message.id : message.uuid;
    const text = textFromContent(message.message.content);
    const events = [];
    if (state.messageId === void 0) {
      state.messageId = backendMessageId ?? `cc-${state.sessionId}-assistant`;
      state.started = true;
      events.push({ type: "message/start", messageId: state.messageId, role: "assistant", ...backendMessageId === void 0 ? {} : { backendMessageId }, ...runId === void 0 ? {} : { runId } });
    }
    const alreadyStreamed = state.streamed === true;
    state.streamed = false;
    if (text.length > 0 && !alreadyStreamed) {
      events.push({ type: "message/text_delta", messageId: state.messageId, delta: text, ...runId === void 0 ? {} : { runId } });
    }
    for (const block of message.message.content) {
      if (typeof block !== "object" || block === null) continue;
      const rec2 = block;
      if (rec2.type === "tool_use" && typeof rec2.id === "string" && typeof rec2.name === "string") {
        events.push({ type: "tool/start", toolCallId: rec2.id, toolName: rec2.name, ...runId === void 0 ? {} : { runId } });
      }
    }
    return events;
  }
  if (message.type === "user") {
    return toolResults(message.message?.content).map((result) => ({
      type: "tool/end",
      toolCallId: result.toolUseId,
      isError: result.isError,
      ...runId === void 0 ? {} : { runId }
    }));
  }
  if (message.type === "result") {
    const events = [];
    if (state.messageId !== void 0) {
      events.push({ type: "message/end", messageId: state.messageId, ...runId === void 0 ? {} : { runId } });
    }
    return events;
  }
  return [];
}
function toolResults(content) {
  if (!Array.isArray(content)) return [];
  const results = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const rec2 = block;
    if (rec2.type === "tool_result" && typeof rec2.tool_use_id === "string") {
      results.push({ toolUseId: rec2.tool_use_id, isError: rec2.is_error === true });
    }
  }
  return results;
}

// src/prompt-outcome.ts
var FAILURE_MESSAGE_MAX_CHARS = 500;
var AUTH_FAILURE = /authenticat|oauth|\blog ?in\b|api key/i;
function resolvePromptOutcome(input) {
  if (input.cancelled) return { status: "aborted", stopReason: "aborted" };
  if (input.result === void 0) {
    return failed("runtime", "backend-worker-crash", "claude exited without a result", true);
  }
  if (!input.result.isError) return { status: "completed", stopReason: "stop" };
  const text = input.result.text ?? "Claude Code reported an error";
  return AUTH_FAILURE.test(text) ? failed("provider", "provider-authentication", text, false) : failed("provider", "unknown-agent-failure", text, false);
}
function failed(origin, code, message, retriable) {
  return {
    status: "failed",
    stopReason: "error",
    failure: { code, origin, message: message.slice(0, FAILURE_MESSAGE_MAX_CHARS), retriable }
  };
}

// src/models.ts
var CLAUDE_MODEL_ALIASES = [
  { id: "haiku", label: "Haiku" },
  { id: "sonnet", label: "Sonnet" },
  { id: "opus", label: "Opus" }
];
var DEFAULT_CLAUDE_MODEL_ID = "haiku";
function isKnownModel(models, modelId) {
  return models.some((model) => model.id === modelId);
}

// src/settings.ts
var CLAUDE_CODING_SETTING_SOURCES = ["user", "project", "local"];
function resolveSettingSources(preset) {
  return preset === "empty" ? [] : CLAUDE_CODING_SETTING_SOURCES;
}

// src/plugin.ts
var ClaudePlugin = class {
  deps;
  sessions = /* @__PURE__ */ new Map();
  hostBinaryPath;
  hostCapabilities = {};
  callbackSeq = 0;
  constructor(deps) {
    this.deps = deps;
  }
  async handle(frame) {
    if (frame.kind !== "request") return;
    try {
      await this.dispatch(frame);
    } catch (error) {
      this.deps.io.write(errFrame(frame, "backend-error", error instanceof Error ? error.message : String(error)));
    }
  }
  async dispatch(frame) {
    switch (frame.method) {
      case "plugin/initialize":
        return this.initialize(frame);
      case "plugin/dispose":
        this.deps.io.write(okFrame(frame, null));
        return;
      case "check":
        return this.check(frame);
      case "catalog/list":
        this.deps.io.write(okFrame(frame, []));
        return;
      case "catalog/usage":
        this.deps.io.write(okFrame(frame, []));
        return;
      case "catalog/native-observe":
        return this.nativeObserve(frame);
      case "catalog/rename":
      case "catalog/delete":
        this.deps.io.write(errFrame(frame, "unsupported", `${frame.method} is not implemented`));
        return;
      case "session/new":
      case "session/load":
      case "session/resume":
        return this.open(frame);
      case "session/prompt":
        return this.prompt(frame);
      case "session/cancel":
        return this.cancel(frame);
      case "session/options":
      case "session/model":
      case "session/effort":
      case "session/mode":
        return this.options(frame);
      case "session/commands":
        return this.commands(frame);
      case "session/cli-launch":
        return this.cliLaunch(frame);
      case "session/release": {
        if (frame.scope.kind === "session") this.sessions.delete(frame.scope.sessionId);
        this.deps.io.write(okFrame(frame, null));
        return;
      }
      case "session/interject":
      case "session/interject-cancel":
      case "session/mcp-status":
      case "session/workflows":
        this.deps.io.write(errFrame(frame, "unsupported", `${frame.method} is not implemented`));
        return;
      default:
        this.deps.io.write(errFrame(frame, "unsupported", `unknown method ${frame.method}`));
    }
  }
  initialize(frame) {
    const params = asRecord2(frame.params);
    const runtime = asRecord2(params?.runtime);
    const caps = asRecord2(params?.hostCapabilities);
    this.hostBinaryPath = typeof runtime?.binaryPath === "string" ? runtime.binaryPath : void 0;
    this.hostCapabilities = {
      nativeCliLaunch: caps?.nativeCliLaunch === true,
      nativeUserInput: caps?.nativeUserInput === true
    };
    this.deps.io.write(okFrame(frame, { agentId: AGENT_ID, protocolVersion: 1, sdk: PINNED_CLAUDE_AGENT_SDK, nativeObservation: true }));
  }
  check(frame) {
    const resolved = resolveClaudeBinary({
      ...this.hostBinaryPath === void 0 ? {} : { hostBinaryPath: this.hostBinaryPath },
      ...this.deps.env === void 0 ? {} : { env: this.deps.env },
      ...this.deps.pathExists === void 0 ? {} : { pathExists: this.deps.pathExists }
    });
    const checkedAt = (this.deps.now ?? (() => (/* @__PURE__ */ new Date()).toISOString()))();
    if (!resolved.ok) {
      this.deps.io.write(okFrame(frame, {
        agentId: AGENT_ID,
        state: "not-installed",
        searched: resolved.searched,
        checkedAt
      }));
      return;
    }
    this.deps.io.write(okFrame(frame, {
      agentId: AGENT_ID,
      state: "ready",
      binaryPath: resolved.binaryPath,
      version: "2.1.281",
      supportStatus: "verified",
      checkedAt,
      nativeCli: { supported: true },
      // Drafts read new-session defaults from here; without a catalog the
      // composer cannot offer a model before the first native process runs.
      options: claudeOptions(emptySlotOptions())
    }));
  }
  open(frame) {
    if (frame.scope.kind !== "session") {
      this.deps.io.write(errFrame(frame, "invalid-request", "session scope required"));
      return;
    }
    const params = asRecord2(frame.params);
    const cwd = typeof params?.cwd === "string" ? params.cwd : "";
    const binding = asRecord2(params?.binding);
    const storedId = typeof binding?.backendSessionId === "string" ? binding.backendSessionId : void 0;
    const syntheticId = `cc-${frame.scope.sessionId}`;
    const unboundDraft = storedId === void 0 || storedId.length === 0 || storedId === syntheticId;
    if (frame.method === "session/load" || frame.method === "session/resume") {
      if (unboundDraft) {
        this.deps.io.write(errFrame(frame, "invalid-request", "native session id required"));
        return;
      }
    }
    const backendSessionId = frame.method === "session/new" ? "" : storedId ?? "";
    const existing = this.sessions.get(frame.scope.sessionId);
    const reuse = frame.method !== "session/new" && existing !== void 0 && storedId === existing.backendSessionId;
    const slot = reuse && existing !== void 0 ? existing : {
      cwd,
      backendSessionId,
      // session/new stays unbound until the CLI reports a real session_id.
      nativeBound: frame.method !== "session/new" && !unboundDraft,
      cancelled: false,
      ...emptySlotOptions(),
      replay: []
    };
    if (frame.method === "session/load" && !reuse) {
      const reconstructed = this.reconstructHistory(slot.cwd, slot.backendSessionId);
      if (!reconstructed.ok) {
        this.deps.io.write(errFrame(frame, "unavailable", reconstructed.reason));
        return;
      }
      slot.replay = reconstructed.events;
    }
    if (!reuse) this.sessions.set(frame.scope.sessionId, slot);
    this.deps.io.write(okFrame(frame, {
      backendSessionId: slot.backendSessionId,
      agentVersion: slot.agentVersion,
      capabilities: claudeCapabilities(),
      options: claudeOptions(slot),
      replayEvents: frame.method === "session/new" ? [] : slot.replay
    }));
  }
  nativeObserve(frame) {
    const params = asRecord2(frame.params);
    const backendSessionId = typeof params?.backendSessionId === "string" ? params.backendSessionId : "";
    const workingDirectory = typeof params?.workingDirectory === "string" ? params.workingDirectory : "";
    if (backendSessionId.length === 0) {
      this.deps.io.write(errFrame(frame, "invalid-request", "native session id required"));
      return;
    }
    const live = [...this.sessions.values()].find((slot) => slot.backendSessionId === backendSessionId);
    const reconstructed = this.reconstructHistory(workingDirectory, backendSessionId);
    const activity = live?.promptFrame !== void 0 ? "running" : reconstructed.ok ? "idle" : "unknown";
    this.deps.io.write(okFrame(frame, {
      backendSessionId,
      activity,
      ...params?.includeHistory === true && reconstructed.ok ? { replayEvents: reconstructed.events } : {}
    }));
  }
  reconstructHistory(cwd, backendSessionId) {
    const historyRoot = this.deps.historyRoot ?? defaultClaudeHistoryRoot(this.deps.env ?? process.env);
    if (historyRoot === void 0) return { ok: false, reason: "native history unavailable" };
    return reconstructClaudeHistory({
      historyRoot,
      cwd,
      sessionId: backendSessionId,
      ...this.deps.readHistoryFile === void 0 ? {} : { readFile: this.deps.readHistoryFile }
    });
  }
  async prompt(frame) {
    if (frame.scope.kind !== "session") {
      this.deps.io.write(errFrame(frame, "invalid-request", "session scope required"));
      return;
    }
    const slot = this.sessions.get(frame.scope.sessionId);
    if (slot === void 0) {
      this.deps.io.write(errFrame(frame, "invalid-request", "no session"));
      return;
    }
    const params = asRecord2(frame.params);
    const runId = typeof params?.runId === "string" ? params.runId : "";
    const input = asRecord2(params?.input);
    const text = typeof input?.text === "string" ? input.text : "";
    const binary = resolveClaudeBinary({
      ...this.hostBinaryPath === void 0 ? {} : { hostBinaryPath: this.hostBinaryPath },
      ...this.deps.env === void 0 ? {} : { env: this.deps.env },
      ...this.deps.pathExists === void 0 ? {} : { pathExists: this.deps.pathExists }
    });
    if (!binary.ok) {
      this.deps.io.write(errFrame(frame, "unavailable", "claude executable not found"));
      return;
    }
    slot.cancelled = false;
    slot.promptFrame = frame;
    const preset = this.deps.settingsPreset ?? "coding";
    const settingSources = resolveSettingSources(preset);
    const mapState = { sessionId: slot.backendSessionId, runId, started: false };
    let nativeResult;
    const canUseTool = async (toolName, toolInput) => {
      const decision = await this.deps.io.callHost(frame.scope, "permission/request", {
        action: toolName,
        detail: jsonDetail(toolInput),
        context: { kind: "tool", toolName },
        options: DEFAULT_PERMISSION_OPTIONS,
        runId
      });
      const allow = decision?.optionId === "allow_once" || decision?.optionId === "allow_always";
      return allow ? { behavior: "allow", updatedInput: toolInput } : { behavior: "deny", message: "denied" };
    };
    try {
      const images = claudeImagesFromAttachments(
        input?.attachments,
        this.deps.readMediaFile
      );
      if (!images.ok) {
        this.deps.io.write(errFrame(frame, "invalid-request", images.reason));
        return;
      }
      for await (const message of this.deps.query.query({
        prompt: text,
        ...images.images.length > 0 ? { images: images.images } : {},
        options: {
          cwd: slot.cwd,
          pathToClaudeCodeExecutable: binary.binaryPath,
          settingSources,
          ...slot.nativeBound ? { resume: slot.backendSessionId } : {},
          ...slot.currentModelId === void 0 ? {} : { model: slot.currentModelId },
          canUseTool
        }
      })) {
        if (slot.cancelled) break;
        if (message.type === "system" && message.subtype === "init") {
          slot.backendSessionId = message.session_id;
          slot.nativeBound = true;
          slot.commands = [...message.commands ?? []];
          const native = (message.models ?? []).map((model) => ({ id: model.id, label: model.display_name ?? model.id }));
          if (native.length > 0 && slot.currentModelId !== void 0 && isKnownModel(native, slot.currentModelId)) {
            slot.models = native;
          }
          if (typeof message.claude_code_version === "string") slot.agentVersion = message.claude_code_version;
        }
        if (message.type === "result") {
          nativeResult = {
            isError: message.is_error === true,
            ...typeof message.result === "string" ? { text: message.result } : {}
          };
        }
        for (const event of mapClaudeMessage(mapState, message)) {
          const emission = { type: "agent", event };
          slot.replay.push(emission);
          this.deps.io.write(eventFrame(frame.scope, emission));
        }
      }
      this.deps.io.write(okFrame(frame, resolvePromptOutcome({
        cancelled: slot.cancelled,
        ...nativeResult === void 0 ? {} : { result: nativeResult }
      })));
    } catch (error) {
      this.deps.io.write(errFrame(frame, "backend-error", error instanceof Error ? error.message : String(error)));
    } finally {
      delete slot.promptFrame;
    }
  }
  cancel(frame) {
    if (frame.scope.kind === "session") {
      const slot = this.sessions.get(frame.scope.sessionId);
      if (slot !== void 0) slot.cancelled = true;
    }
    void this.deps.query.interrupt?.();
    this.deps.io.write(okFrame(frame, null));
  }
  options(frame) {
    const slot = frame.scope.kind === "session" ? this.sessions.get(frame.scope.sessionId) : void 0;
    if (frame.method === "session/model" && slot !== void 0) {
      const modelId = asRecord2(frame.params)?.modelId;
      if (typeof modelId !== "string" || !isKnownModel(slot.models, modelId)) {
        this.deps.io.write(errFrame(frame, "invalid-request", `unknown model ${String(modelId)}`));
        return;
      }
      slot.currentModelId = modelId;
    }
    this.deps.io.write(okFrame(frame, claudeOptions(slot ?? emptySlotOptions())));
  }
  commands(frame) {
    const slot = frame.scope.kind === "session" ? this.sessions.get(frame.scope.sessionId) : void 0;
    this.deps.io.write(okFrame(frame, claudeOptions(slot ?? emptySlotOptions()).commands));
  }
  cliLaunch(frame) {
    if (this.hostCapabilities.nativeCliLaunch !== true) {
      this.deps.io.write(errFrame(frame, "unsupported", "nativeCliLaunch was not negotiated"));
      return;
    }
    if (frame.scope.kind !== "session") {
      this.deps.io.write(errFrame(frame, "invalid-request", "session scope required"));
      return;
    }
    const slot = this.sessions.get(frame.scope.sessionId);
    if (slot === void 0) {
      this.deps.io.write(errFrame(frame, "invalid-request", "no session"));
      return;
    }
    const params = asRecord2(frame.params);
    const cwd = typeof params?.cwd === "string" ? params.cwd : slot.cwd;
    this.deps.io.write(okFrame(frame, claudeCliLaunch({ backendSessionId: slot.backendSessionId, cwd })));
  }
};
function createCallbackIo(write, waiters2) {
  let seq = 0;
  return {
    write,
    callHost(scope, method, params) {
      const requestId = `cb-${seq += 1}`;
      return new Promise((resolve, reject) => {
        waiters2.set(requestId, { resolve, reject });
        write(requestFrame(scope, requestId, method, params));
      });
    }
  };
}
function emptySlotOptions() {
  return { models: [...CLAUDE_MODEL_ALIASES], commands: [], currentModelId: DEFAULT_CLAUDE_MODEL_ID };
}
function asRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
function jsonDetail(value) {
  try {
    const text = JSON.stringify(value);
    return text.length > 500 ? `${text.slice(0, 500)}\u2026` : text;
  } catch {
    return "";
  }
}

// src/cli-query.ts
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
function buildClaudeCliArgs(options) {
  const args = [
    "--print",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--await-initialize",
    "--permission-mode",
    "manual",
    "--permission-prompt-tool",
    "stdio"
  ];
  if (options.settingSources.length === 0) {
    args.push("--bare", "--safe-mode", "--setting-sources", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}');
  } else {
    args.push("--setting-sources", options.settingSources.join(","));
  }
  if (typeof options.resume === "string" && options.resume.length > 0) args.push("--resume", options.resume);
  if (typeof options.model === "string" && options.model.length > 0) args.push("--model", options.model);
  return args;
}
function createClaudeCliQueryPort(input = {}) {
  const spawnImpl = input.spawnImpl ?? spawn;
  const children = /* @__PURE__ */ new Set();
  return {
    async *query(request) {
      const prompt = request.prompt;
      const options = request.options;
      if (!isUserOwnedClaudeBinary(options.pathToClaudeCodeExecutable)) {
        throw new Error("refusing SDK platform binary");
      }
      const env = { ...input.env ?? process.env };
      const child = spawnImpl(options.pathToClaudeCodeExecutable, buildClaudeCliArgs(options), {
        cwd: options.cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"]
      });
      children.add(child);
      child.stderr.resume();
      const lines = readLines(child);
      const initId = randomUUID();
      writeJson(child, { type: "control_request", request_id: initId, request: { subtype: "initialize" } });
      writeJson(child, {
        type: "user",
        uuid: randomUUID(),
        parent_tool_use_id: null,
        message: { role: "user", content: userContent(prompt, request.images) }
      });
      try {
        for await (const message of lines) {
          if (message.type === "control_request" && rec(message.request)?.subtype === "can_use_tool") {
            const request2 = rec(message.request) ?? {};
            const toolName = typeof request2.tool_name === "string" ? request2.tool_name : "tool";
            const decision = options.canUseTool === void 0 ? { behavior: "deny", message: "denied" } : await options.canUseTool(toolName, request2.input);
            writeJson(child, {
              type: "control_response",
              response: {
                subtype: "success",
                request_id: message.request_id,
                response: {
                  behavior: decision.behavior,
                  ...decision.behavior === "allow" ? { updatedInput: decision.updatedInput ?? request2.input } : { message: decision.message ?? "denied" },
                  toolUseID: request2.tool_use_id
                }
              }
            });
            continue;
          }
          if (isSdkMessage(message)) yield message;
          if (message.type === "result") break;
        }
      } finally {
        children.delete(child);
        await closeChild(child);
      }
    },
    async interrupt() {
      for (const live of [...children]) {
        writeJson(live, { type: "control_request", request_id: randomUUID(), request: { subtype: "interrupt" } });
      }
    }
  };
}
async function* readLines(child) {
  child.stdout.setEncoding("utf8");
  let buffer = "";
  for await (const chunk of child.stdout) {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line.length > 0) {
        try {
          yield JSON.parse(line);
        } catch {
        }
      }
      index = buffer.indexOf("\n");
    }
  }
}
function writeJson(child, value) {
  child.stdin.write(`${JSON.stringify(value)}
`);
}
async function closeChild(child) {
  if (child.killed) return;
  child.stdin.end();
  child.kill("SIGTERM");
}
function rec(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
function isSdkMessage(value) {
  return value.type === "system" || value.type === "assistant" || value.type === "stream_event" || value.type === "user" || value.type === "result";
}
function userContent(prompt, images) {
  const blocks = [{ type: "text", text: prompt }];
  for (const image of images ?? []) {
    blocks.push({
      type: "image",
      source: { type: "base64", media_type: image.mimeType, data: image.data }
    });
  }
  return blocks;
}

// src/main.ts
function stdoutWrite(frame) {
  process.stdout.write(`${JSON.stringify(frame)}
`);
}
var waiters = /* @__PURE__ */ new Map();
var io = createCallbackIo(stdoutWrite, waiters);
var query = createClaudeCliQueryPort();
var plugin = new ClaudePlugin({ io, query });
createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const frame = parseFrame(line);
  if (frame === void 0) return;
  if (frame.kind === "response") {
    const pending = waiters.get(frame.requestId);
    if (pending === void 0) return;
    waiters.delete(frame.requestId);
    if (frame.ok) pending.resolve(frame.result);
    else pending.reject(new Error(frame.error.message));
    return;
  }
  void plugin.handle(frame);
});
