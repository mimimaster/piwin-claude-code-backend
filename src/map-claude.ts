import { AGENT_ID, type AgentEvent, type ClaudeRawUsage, type ClaudeSdkMessage, type UsageMeasurement } from './types.js';

export type ParsedClaudeUsageCall = {
  requestId: string;
  modelId?: string;
  promptTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  completionTokens: number;
  reasoningTokens?: number;
  totalTokens: number;
};

export type MapState = {
  sessionId: string;
  hostSessionId?: string;
  runtimeGenerationId?: string;
  modelId?: string;
  now?: () => string;
  runId?: string;
  messageId?: string;
  started: boolean;
  /** Partial deltas already carried this assistant message's text. */
  streamed?: boolean;
  /** Distinct API calls observed in this turn, keyed by native `message.id`. */
  assistantCalls?: Map<string, ParsedClaudeUsageCall>;
};

export function parseClaudeRawUsage(raw: unknown): Omit<ParsedClaudeUsageCall, 'requestId' | 'modelId'> | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const usage = raw as ClaudeRawUsage;
  const promptTokens = nonNegativeInt(usage.input_tokens);
  const cacheReadTokens = nonNegativeInt(usage.cache_read_input_tokens);
  const cacheWriteTokens = nonNegativeInt(usage.cache_creation_input_tokens);
  const completionTokens = nonNegativeInt(usage.output_tokens);
  const reasoningTokens = nonNegativeIntOptional(usage.output_tokens_details?.thinking_tokens);
  const totalTokens = promptTokens + cacheReadTokens + cacheWriteTokens + completionTokens;
  if (totalTokens <= 0) return undefined;
  return {
    promptTokens,
    cacheReadTokens,
    cacheWriteTokens,
    completionTokens,
    ...(reasoningTokens !== undefined && reasoningTokens > 0 ? { reasoningTokens } : {}),
    totalTokens,
  };
}

function textFromContent(content: readonly unknown[]): string {
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const rec = block as Record<string, unknown>;
    if (rec.type === 'text' && typeof rec.text === 'string') parts.push(rec.text);
  }
  return parts.join('');
}

export function mapClaudeMessage(state: MapState, message: ClaudeSdkMessage): AgentEvent[] {
  const runId = state.runId;
  if (message.type === 'system' && message.subtype === 'init') {
    state.sessionId = message.session_id;
    return [{ type: 'session/started', sessionId: message.session_id }];
  }
  if (message.type === 'stream_event' && message.event.type === 'content_block_delta' && message.event.delta?.type === 'text_delta' && typeof message.event.delta.text === 'string') {
    state.streamed = true;
    if (state.messageId === undefined) {
      state.messageId = `cc-${state.sessionId}-assistant`;
      state.started = true;
      return [
        { type: 'message/start', messageId: state.messageId, role: 'assistant', ...(runId === undefined ? {} : { runId }) },
        { type: 'message/text_delta', messageId: state.messageId, delta: message.event.delta.text, ...(runId === undefined ? {} : { runId }) },
      ];
    }
    return [{ type: 'message/text_delta', messageId: state.messageId, delta: message.event.delta.text, ...(runId === undefined ? {} : { runId }) }];
  }
  if (message.type === 'assistant') {
    const backendMessageId = nonEmptyString(message.message.id) ?? nonEmptyString(message.uuid);
    const text = textFromContent(message.message.content);
    const events: AgentEvent[] = [];
    if (state.messageId === undefined) {
      state.messageId = backendMessageId ?? `cc-${state.sessionId}-assistant`;
      state.started = true;
      events.push({ type: 'message/start', messageId: state.messageId, role: 'assistant', ...(backendMessageId === undefined ? {} : { backendMessageId }), ...(runId === undefined ? {} : { runId }) });
    }
    const parsedUsage = parseClaudeRawUsage(message.message.usage);
    if (parsedUsage !== undefined) {
      state.assistantCalls ??= new Map<string, ParsedClaudeUsageCall>();
      const callKey = backendMessageId ?? `${state.sessionId}-call-${state.assistantCalls.size + 1}`;
      const modelId = nonEmptyString(message.message.model);
      state.assistantCalls.set(callKey, {
        requestId: callKey,
        ...(modelId === undefined ? {} : { modelId }),
        ...parsedUsage,
      });
    }
    // With --include-partial-messages the final assistant frame repeats text
    // that deltas already streamed; emitting it again would double the reply.
    const alreadyStreamed = state.streamed === true;
    state.streamed = false;
    if (text.length > 0 && !alreadyStreamed) {
      events.push({ type: 'message/text_delta', messageId: state.messageId, delta: text, ...(runId === undefined ? {} : { runId }) });
    }
    for (const block of message.message.content) {
      if (typeof block !== 'object' || block === null) continue;
      const rec = block as Record<string, unknown>;
      if (rec.type === 'tool_use' && typeof rec.id === 'string' && typeof rec.name === 'string') {
        events.push({ type: 'tool/start', toolCallId: rec.id, toolName: rec.name, ...(runId === undefined ? {} : { runId }) });
      }
    }
    return events;
  }
  if (message.type === 'user') {
    return toolResults(message.message?.content).map((result) => ({
      type: 'tool/end' as const,
      toolCallId: result.toolUseId,
      isError: result.isError,
      ...(runId === undefined ? {} : { runId }),
    }));
  }
  if (message.type === 'result') {
    const events: AgentEvent[] = [];
    if (state.messageId !== undefined) {
      events.push({ type: 'message/end', messageId: state.messageId, ...(runId === undefined ? {} : { runId }) });
    }
    for (const measurement of buildTurnMeasurements(state, message)) {
      events.push({ type: 'usage/finalized', measurement });
    }
    // A native error is reported through the prompt outcome, not as an abort.
    return events;
  }
  return [];
}

function buildTurnMeasurements(
  state: MapState,
  result: Extract<ClaudeSdkMessage, { type: 'result' }>,
): UsageMeasurement[] {
  const hostSessionId = nonEmptyString(state.hostSessionId) ?? nonEmptyString(state.sessionId);
  if (hostSessionId === undefined) return [];
  const recordedAt = (state.now ?? (() => new Date().toISOString()))();
  const modelUsageIds = result.modelUsage ? Object.keys(result.modelUsage).filter((key) => key.length > 0) : [];
  const fallbackModelId = modelUsageIds[0] ?? nonEmptyString(state.modelId);
  const totalCostUsd = finiteNonNegative(result.total_cost_usd);

  const calls = state.assistantCalls ? [...state.assistantCalls.values()] : [];
  if (calls.length > 0) {
    const sumTokens = calls.reduce((acc, item) => acc + item.totalTokens, 0);
    return calls.map((call, index) => {
      const isLast = index === calls.length - 1;
      const messageId = isLast && state.messageId !== undefined ? state.messageId : call.requestId;
      const resolvedModelId = call.modelId ?? fallbackModelId;
      const modelCost = resolvedModelId !== undefined
        ? finiteNonNegative(result.modelUsage?.[resolvedModelId]?.costUSD)
        : undefined;
      const callCostUsd = totalCostUsd !== undefined && sumTokens > 0
        ? totalCostUsd * (call.totalTokens / sumTokens)
        : calls.length === 1 ? modelCost : undefined;
      return toMeasurement({
        requestId: call.requestId,
        sessionId: hostSessionId,
        messageId,
        recordedAt,
        usage: call,
        ...(resolvedModelId === undefined ? {} : { modelId: resolvedModelId }),
        ...(state.runId === undefined || state.runId.length === 0 ? {} : { runId: state.runId }),
        ...(state.runtimeGenerationId === undefined || state.runtimeGenerationId.length === 0
          ? {}
          : { runtimeGenerationId: state.runtimeGenerationId }),
        ...(callCostUsd === undefined ? {} : { costUsd: callCostUsd }),
      });
    });
  }

  const parsedResult = parseClaudeRawUsage(result.usage);
  if (parsedResult === undefined) return [];
  const fallbackId = state.messageId
    ?? (state.runId !== undefined && state.runId.length > 0 ? `${hostSessionId}-${state.runId}` : `${hostSessionId}-result`);
  return [
    toMeasurement({
      requestId: fallbackId,
      sessionId: hostSessionId,
      messageId: state.messageId ?? fallbackId,
      recordedAt,
      usage: parsedResult,
      ...(fallbackModelId === undefined ? {} : { modelId: fallbackModelId }),
      ...(state.runId === undefined || state.runId.length === 0 ? {} : { runId: state.runId }),
      ...(state.runtimeGenerationId === undefined || state.runtimeGenerationId.length === 0
        ? {}
        : { runtimeGenerationId: state.runtimeGenerationId }),
      ...(totalCostUsd === undefined ? {} : { costUsd: totalCostUsd }),
    }),
  ];
}

function toMeasurement(input: {
  requestId: string;
  sessionId: string;
  messageId: string;
  recordedAt: string;
  usage: Omit<ParsedClaudeUsageCall, 'requestId' | 'modelId'>;
  modelId?: string;
  runId?: string;
  runtimeGenerationId?: string;
  costUsd?: number;
}): UsageMeasurement {
  return {
    measurementId: `${AGENT_ID}:${input.requestId}`,
    sessionId: input.sessionId,
    messageId: input.messageId,
    promptTokens: input.usage.promptTokens,
    completionTokens: input.usage.completionTokens,
    cacheReadTokens: input.usage.cacheReadTokens,
    cacheWriteTokens: input.usage.cacheWriteTokens,
    ...(input.usage.reasoningTokens === undefined ? {} : { reasoningTokens: input.usage.reasoningTokens }),
    totalTokens: input.usage.totalTokens,
    recordedAt: input.recordedAt,
    ...(input.modelId === undefined ? {} : { modelId: input.modelId }),
    ...(input.runId === undefined ? {} : { runId: input.runId }),
    ...(input.runtimeGenerationId === undefined ? {} : { runtimeGenerationId: input.runtimeGenerationId }),
    ...(input.costUsd === undefined ? {} : { costUsd: input.costUsd }),
  };
}

function toolResults(content: unknown): { toolUseId: string; isError: boolean }[] {
  if (!Array.isArray(content)) return [];
  const results: { toolUseId: string; isError: boolean }[] = [];
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const rec = block as Record<string, unknown>;
    if (rec.type === 'tool_result' && typeof rec.tool_use_id === 'string') {
      results.push({ toolUseId: rec.tool_use_id, isError: rec.is_error === true });
    }
  }
  return results;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function nonNegativeInt(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

function nonNegativeIntOptional(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : undefined;
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}
