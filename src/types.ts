/** Plugin-local copies of Host wire shapes. Keep in sync with @piwin/contracts protocol v1. */

export const PROTOCOL_VERSION = 1 as const;
export const PINNED_CLAUDE_AGENT_SDK = '0.3.282';
export const AGENT_ID = 'claude-code';

export type Scope = { kind: 'plugin' } | { kind: 'session'; sessionId: string; runtimeGenerationId: string };

export type Frame =
  | { protocolVersion: 1; kind: 'request'; requestId: string; scope: Scope; method: string; params: unknown }
  | { protocolVersion: 1; kind: 'response'; requestId: string; scope: Scope; method: string; ok: true; result: unknown }
  | { protocolVersion: 1; kind: 'response'; requestId: string; scope: Scope; method: string; ok: false; error: { code: string; message: string } }
  | { protocolVersion: 1; kind: 'event'; scope: { kind: 'session'; sessionId: string; runtimeGenerationId: string }; emission: unknown };

export type UsageMeasurement = {
  measurementId: string;
  sessionId: string;
  runId?: string;
  runtimeGenerationId?: string;
  messageId: string;
  modelId?: string;
  promptTokens?: number;
  completionTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  totalTokens: number;
  costUsd?: number;
  recordedAt: string;
};

export type RequestUsageRecord = {
  requestId: string;
  backendSessionId: string;
  modelId?: string;
  promptTokens?: number;
  completionTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  totalTokens: number;
  costUsd?: number;
  recordedAt: string;
};

export type AgentEvent =
  | { type: 'session/started'; sessionId: string }
  | { type: 'message/start'; messageId: string; role: 'user' | 'assistant' | 'toolResult'; backendMessageId?: string; runId?: string }
  | { type: 'message/text_delta'; messageId: string; delta: string; runId?: string }
  | { type: 'message/end'; messageId: string; runId?: string }
  | { type: 'tool/start'; toolCallId: string; toolName: string; runId?: string }
  | { type: 'tool/end'; toolCallId: string; isError: boolean; runId?: string }
  | { type: 'usage/finalized'; measurement: UsageMeasurement }
  | { type: 'session/aborted'; sessionId: string; messageId?: string; runId?: string };

export type PermissionOption = { optionId: string; label: string; kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always' };

export type ClaudeRawUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  output_tokens_details?: {
    thinking_tokens?: number;
  };
};

export type ClaudeModelUsageItem = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  costUSD?: number;
  contextWindow?: number;
};

export type ClaudeSdkMessage =
  | { type: 'system'; subtype: 'init'; session_id: string; commands?: readonly { name: string; description?: string }[]; models?: readonly { id: string; display_name?: string }[]; claude_code_version?: string }
  | { type: 'assistant'; uuid?: string; message: { id?: string; model?: string; usage?: ClaudeRawUsage; content: readonly unknown[] } }
  | { type: 'stream_event'; event: { type: string; delta?: { type?: string; text?: string } } }
  | { type: 'user'; message?: { content?: unknown } }
  | {
      type: 'result';
      subtype?: string;
      is_error?: boolean;
      session_id?: string;
      result?: string;
      duration_ms?: number;
      total_cost_usd?: number;
      usage?: ClaudeRawUsage;
      modelUsage?: Readonly<Record<string, ClaudeModelUsageItem>>;
    };

export type ClaudeQueryOptions = {
  cwd: string;
  pathToClaudeCodeExecutable: string;
  settingSources: readonly string[];
  resume?: string;
  model?: string;
  permissionMode?: string;
  canUseTool?: (toolName: string, input: unknown) => Promise<{ behavior: 'allow' | 'deny'; updatedInput?: unknown; message?: string }>;
};

export type ClaudeImagePart = { mimeType: string; data: string };

export type ClaudeQueryPort = {
  query(input: { prompt: string; images?: readonly ClaudeImagePart[]; options: ClaudeQueryOptions }): AsyncIterable<ClaudeSdkMessage>;
  interrupt?(): Promise<void>;
};
