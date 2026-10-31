import { claudeCapabilities, claudeOptions, DEFAULT_PERMISSION_OPTIONS } from './capabilities.js';
import { claudeCliLaunch } from './cli-launch.js';
import { defaultClaudeHistoryRoot, reconstructClaudeHistory } from './claude-history.js';
import { claudeImagesFromAttachments } from './prompt-content.js';
import { resolveClaudeBinary } from './binary.js';
import { eventFrame, errFrame, okFrame, requestFrame } from './frames.js';
import { mapClaudeMessage, type MapState } from './map-claude.js';
import { resolvePromptOutcome, type NativeResult } from './prompt-outcome.js';
import { CLAUDE_MODEL_ALIASES, DEFAULT_CLAUDE_MODEL_ID, isKnownModel } from './models.js';
import { resolveSettingSources, type ClaudeSettingsPreset } from './settings.js';
import { AGENT_ID, PINNED_CLAUDE_AGENT_SDK, type ClaudeQueryPort, type Frame, type Scope } from './types.js';

export type HostIO = {
  write(frame: Frame): void;
  callHost(scope: Scope, method: string, params: unknown): Promise<unknown>;
};

type SessionSlot = {
  cwd: string;
  backendSessionId: string;
  nativeBound: boolean;
  cancelled: boolean;
  promptFrame?: Extract<Frame, { kind: 'request' }>;
  models: { id: string; label: string }[];
  commands: { name: string; description?: string }[];
  currentModelId?: string;
  agentVersion?: string;
  replay: unknown[];
};

export type PluginDeps = {
  io: HostIO;
  query: ClaudeQueryPort;
  now?: () => string;
  pathExists?: (path: string) => boolean;
  env?: NodeJS.ProcessEnv;
  settingsPreset?: ClaudeSettingsPreset;
  historyRoot?: string;
  readHistoryFile?: (path: string) => string | undefined;
  readMediaFile?: (path: string) => Buffer | undefined;
};

export class ClaudePlugin {
  private readonly deps: PluginDeps;
  private readonly sessions = new Map<string, SessionSlot>();
  private hostBinaryPath: string | undefined;
  private hostCapabilities: { nativeCliLaunch?: boolean; nativeUserInput?: boolean } = {};
  private callbackSeq = 0;

  constructor(deps: PluginDeps) {
    this.deps = deps;
  }

  async handle(frame: Frame): Promise<void> {
    if (frame.kind !== 'request') return;
    try {
      await this.dispatch(frame);
    } catch (error) {
      this.deps.io.write(errFrame(frame, 'backend-error', error instanceof Error ? error.message : String(error)));
    }
  }

  private async dispatch(frame: Extract<Frame, { kind: 'request' }>): Promise<void> {
    switch (frame.method) {
      case 'plugin/initialize':
        return this.initialize(frame);
      case 'plugin/dispose':
        this.deps.io.write(okFrame(frame, null));
        return;
      case 'check':
        return this.check(frame);
      case 'catalog/list':
        this.deps.io.write(okFrame(frame, []));
        return;
      case 'catalog/usage':
        this.deps.io.write(okFrame(frame, []));
        return;
      case 'catalog/native-observe':
        return this.nativeObserve(frame);
      case 'catalog/rename':
      case 'catalog/delete':
        this.deps.io.write(errFrame(frame, 'unsupported', `${frame.method} is not implemented`));
        return;
      case 'session/new':
      case 'session/load':
      case 'session/resume':
        return this.open(frame);
      case 'session/prompt':
        return this.prompt(frame);
      case 'session/cancel':
        return this.cancel(frame);
      case 'session/options':
      case 'session/model':
      case 'session/effort':
      case 'session/mode':
        return this.options(frame);
      case 'session/commands':
        return this.commands(frame);
      case 'session/cli-launch':
        return this.cliLaunch(frame);
      case 'session/release': {
        if (frame.scope.kind === 'session') this.sessions.delete(frame.scope.sessionId);
        this.deps.io.write(okFrame(frame, null));
        return;
      }
      case 'session/interject':
      case 'session/interject-cancel':
      case 'session/mcp-status':
      case 'session/workflows':
        this.deps.io.write(errFrame(frame, 'unsupported', `${frame.method} is not implemented`));
        return;
      default:
        this.deps.io.write(errFrame(frame, 'unsupported', `unknown method ${frame.method}`));
    }
  }

  private initialize(frame: Extract<Frame, { kind: 'request' }>): void {
    const params = asRecord(frame.params);
    const runtime = asRecord(params?.runtime);
    const caps = asRecord(params?.hostCapabilities);
    this.hostBinaryPath = typeof runtime?.binaryPath === 'string' ? runtime.binaryPath : undefined;
    this.hostCapabilities = {
      nativeCliLaunch: caps?.nativeCliLaunch === true,
      nativeUserInput: caps?.nativeUserInput === true,
    };
    this.deps.io.write(okFrame(frame, { agentId: AGENT_ID, protocolVersion: 1, sdk: PINNED_CLAUDE_AGENT_SDK, nativeObservation: true }));
  }

  private check(frame: Extract<Frame, { kind: 'request' }>): void {
    const resolved = resolveClaudeBinary({
      ...(this.hostBinaryPath === undefined ? {} : { hostBinaryPath: this.hostBinaryPath }),
      ...(this.deps.env === undefined ? {} : { env: this.deps.env }),
      ...(this.deps.pathExists === undefined ? {} : { pathExists: this.deps.pathExists }),
    });
    const checkedAt = (this.deps.now ?? (() => new Date().toISOString()))();
    if (!resolved.ok) {
      this.deps.io.write(okFrame(frame, {
        agentId: AGENT_ID,
        state: 'not-installed',
        searched: resolved.searched,
        checkedAt,
      }));
      return;
    }
    this.deps.io.write(okFrame(frame, {
      agentId: AGENT_ID,
      state: 'ready',
      binaryPath: resolved.binaryPath,
      version: '2.1.281',
      supportStatus: 'verified',
      checkedAt,
      nativeCli: { supported: true },
      // Drafts read new-session defaults from here; without a catalog the
      // composer cannot offer a model before the first native process runs.
      options: claudeOptions(emptySlotOptions()),
    }));
  }

  private open(frame: Extract<Frame, { kind: 'request' }>): void {
    if (frame.scope.kind !== 'session') {
      this.deps.io.write(errFrame(frame, 'invalid-request', 'session scope required'));
      return;
    }
    const params = asRecord(frame.params);
    const cwd = typeof params?.cwd === 'string' ? params.cwd : '';
    const binding = asRecord(params?.binding);
    const storedId = typeof binding?.backendSessionId === 'string' ? binding.backendSessionId : undefined;
    const syntheticId = `cc-${frame.scope.sessionId}`;
    const unboundDraft = storedId === undefined || storedId.length === 0 || storedId === syntheticId;
    if (frame.method === 'session/load' || frame.method === 'session/resume') {
      if (unboundDraft) {
        this.deps.io.write(errFrame(frame, 'invalid-request', 'native session id required'));
        return;
      }
    }
    const backendSessionId = frame.method === 'session/new' ? '' : storedId ?? '';
    const existing = this.sessions.get(frame.scope.sessionId);
    const reuse = frame.method !== 'session/new' && existing !== undefined
      && storedId === existing.backendSessionId;
    const slot: SessionSlot = reuse && existing !== undefined ? existing : {
      cwd,
      backendSessionId,
      // session/new stays unbound until the CLI reports a real session_id.
      nativeBound: frame.method !== 'session/new' && !unboundDraft,
      cancelled: false,
      ...emptySlotOptions(),
      replay: [],
    };
    if (frame.method === 'session/load' && !reuse) {
      const reconstructed = this.reconstructHistory(slot.cwd, slot.backendSessionId);
      if (!reconstructed.ok) {
        this.deps.io.write(errFrame(frame, 'unavailable', reconstructed.reason));
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
      replayEvents: frame.method === 'session/new' ? [] : slot.replay,
    }));
  }

  private nativeObserve(frame: Extract<Frame, { kind: 'request' }>): void {
    const params = asRecord(frame.params);
    const backendSessionId = typeof params?.backendSessionId === 'string' ? params.backendSessionId : '';
    const workingDirectory = typeof params?.workingDirectory === 'string' ? params.workingDirectory : '';
    if (backendSessionId.length === 0) {
      this.deps.io.write(errFrame(frame, 'invalid-request', 'native session id required'));
      return;
    }
    const live = [...this.sessions.values()].find((slot) => slot.backendSessionId === backendSessionId);
    const reconstructed = this.reconstructHistory(workingDirectory, backendSessionId);
    const activity = live?.promptFrame !== undefined ? 'running' : reconstructed.ok ? 'idle' : 'unknown';
    this.deps.io.write(okFrame(frame, {
      backendSessionId,
      activity,
      ...(params?.includeHistory === true && reconstructed.ok ? { replayEvents: reconstructed.events } : {}),
    }));
  }

  private reconstructHistory(cwd: string, backendSessionId: string) {
    const historyRoot = this.deps.historyRoot ?? defaultClaudeHistoryRoot(this.deps.env ?? process.env);
    if (historyRoot === undefined) return { ok: false as const, reason: 'native history unavailable' };
    return reconstructClaudeHistory({
      historyRoot,
      cwd,
      sessionId: backendSessionId,
      ...(this.deps.readHistoryFile === undefined ? {} : { readFile: this.deps.readHistoryFile }),
    });
  }

  private async prompt(frame: Extract<Frame, { kind: 'request' }>): Promise<void> {
    if (frame.scope.kind !== 'session') {
      this.deps.io.write(errFrame(frame, 'invalid-request', 'session scope required'));
      return;
    }
    const slot = this.sessions.get(frame.scope.sessionId);
    if (slot === undefined) {
      this.deps.io.write(errFrame(frame, 'invalid-request', 'no session'));
      return;
    }
    const params = asRecord(frame.params);
    const runId = typeof params?.runId === 'string' ? params.runId : '';
    const input = asRecord(params?.input);
    const text = typeof input?.text === 'string' ? input.text : '';
    const binary = resolveClaudeBinary({
      ...(this.hostBinaryPath === undefined ? {} : { hostBinaryPath: this.hostBinaryPath }),
      ...(this.deps.env === undefined ? {} : { env: this.deps.env }),
      ...(this.deps.pathExists === undefined ? {} : { pathExists: this.deps.pathExists }),
    });
    if (!binary.ok) {
      this.deps.io.write(errFrame(frame, 'unavailable', 'claude executable not found'));
      return;
    }
    slot.cancelled = false;
    slot.promptFrame = frame;
    const preset = this.deps.settingsPreset ?? 'coding';
    const settingSources = resolveSettingSources(preset);
    const mapState: MapState = { sessionId: slot.backendSessionId, runId, started: false };
    let nativeResult: NativeResult | undefined;
    const canUseTool = async (toolName: string, toolInput: unknown) => {
      const decision = await this.deps.io.callHost(frame.scope, 'permission/request', {
        action: toolName,
        detail: jsonDetail(toolInput),
        context: { kind: 'tool', toolName },
        options: DEFAULT_PERMISSION_OPTIONS,
        runId,
      }) as { optionId?: string; cancelled?: boolean } | undefined;
      const allow = decision?.optionId === 'allow_once' || decision?.optionId === 'allow_always';
      return allow ? { behavior: 'allow' as const, updatedInput: toolInput } : { behavior: 'deny' as const, message: 'denied' };
    };
    try {
      const images = claudeImagesFromAttachments(
        input?.attachments,
        this.deps.readMediaFile,
      );
      if (!images.ok) {
        this.deps.io.write(errFrame(frame, 'invalid-request', images.reason));
        return;
      }
      for await (const message of this.deps.query.query({
        prompt: text,
        ...(images.images.length > 0 ? { images: images.images } : {}),
        options: {
          cwd: slot.cwd,
          pathToClaudeCodeExecutable: binary.binaryPath,
          settingSources,
          ...(slot.nativeBound ? { resume: slot.backendSessionId } : {}),
          ...(slot.currentModelId === undefined ? {} : { model: slot.currentModelId }),
          canUseTool,
        },
      })) {
        if (slot.cancelled) break;
        if (message.type === 'system' && message.subtype === 'init') {
          slot.backendSessionId = message.session_id;
          slot.nativeBound = true;
          slot.commands = [...(message.commands ?? [])];
          const native = (message.models ?? []).map((model) => ({ id: model.id, label: model.display_name ?? model.id }));
          // Keep the alias catalog unless the native list still contains the
          // selected model; otherwise the composer would lose its selection.
          if (native.length > 0 && slot.currentModelId !== undefined && isKnownModel(native, slot.currentModelId)) {
            slot.models = native;
          }
          if (typeof message.claude_code_version === 'string') slot.agentVersion = message.claude_code_version;
        }
        if (message.type === 'result') {
          nativeResult = {
            isError: message.is_error === true,
            ...(typeof message.result === 'string' ? { text: message.result } : {}),
          };
        }
        for (const event of mapClaudeMessage(mapState, message)) {
          const emission = { type: 'agent', event };
          slot.replay.push(emission);
          this.deps.io.write(eventFrame(frame.scope, emission));
        }
      }
      this.deps.io.write(okFrame(frame, resolvePromptOutcome({
        cancelled: slot.cancelled,
        ...(nativeResult === undefined ? {} : { result: nativeResult }),
      })));
    } catch (error) {
      this.deps.io.write(errFrame(frame, 'backend-error', error instanceof Error ? error.message : String(error)));
    } finally {
      delete slot.promptFrame;
    }
  }

  private cancel(frame: Extract<Frame, { kind: 'request' }>): void {
    if (frame.scope.kind === 'session') {
      const slot = this.sessions.get(frame.scope.sessionId);
      if (slot !== undefined) slot.cancelled = true;
    }
    void this.deps.query.interrupt?.();
    this.deps.io.write(okFrame(frame, null));
  }

  private options(frame: Extract<Frame, { kind: 'request' }>): void {
    const slot = frame.scope.kind === 'session' ? this.sessions.get(frame.scope.sessionId) : undefined;
    if (frame.method === 'session/model' && slot !== undefined) {
      const modelId = asRecord(frame.params)?.modelId;
      if (typeof modelId !== 'string' || !isKnownModel(slot.models, modelId)) {
        this.deps.io.write(errFrame(frame, 'invalid-request', `unknown model ${String(modelId)}`));
        return;
      }
      slot.currentModelId = modelId;
    }
    this.deps.io.write(okFrame(frame, claudeOptions(slot ?? emptySlotOptions())));
  }

  private commands(frame: Extract<Frame, { kind: 'request' }>): void {
    const slot = frame.scope.kind === 'session' ? this.sessions.get(frame.scope.sessionId) : undefined;
    this.deps.io.write(okFrame(frame, claudeOptions(slot ?? emptySlotOptions()).commands));
  }

  private cliLaunch(frame: Extract<Frame, { kind: 'request' }>): void {
    if (this.hostCapabilities.nativeCliLaunch !== true) {
      this.deps.io.write(errFrame(frame, 'unsupported', 'nativeCliLaunch was not negotiated'));
      return;
    }
    if (frame.scope.kind !== 'session') {
      this.deps.io.write(errFrame(frame, 'invalid-request', 'session scope required'));
      return;
    }
    const slot = this.sessions.get(frame.scope.sessionId);
    if (slot === undefined) {
      this.deps.io.write(errFrame(frame, 'invalid-request', 'no session'));
      return;
    }
    const params = asRecord(frame.params);
    const cwd = typeof params?.cwd === 'string' ? params.cwd : slot.cwd;
    this.deps.io.write(okFrame(frame, claudeCliLaunch({ backendSessionId: slot.backendSessionId, cwd })));
  }
}

export function createCallbackIo(write: (frame: Frame) => void, waiters: Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>): HostIO {
  let seq = 0;
  return {
    write,
    callHost(scope, method, params) {
      const requestId = `cb-${(seq += 1)}`;
      return new Promise((resolve, reject) => {
        waiters.set(requestId, { resolve, reject });
        write(requestFrame(scope, requestId, method, params));
      });
    },
  };
}

function emptySlotOptions(): Pick<SessionSlot, 'models' | 'commands' | 'currentModelId'> {
  return { models: [...CLAUDE_MODEL_ALIASES], commands: [], currentModelId: DEFAULT_CLAUDE_MODEL_ID };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function jsonDetail(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    return text.length > 500 ? `${text.slice(0, 500)}…` : text;
  } catch {
    return '';
  }
}
