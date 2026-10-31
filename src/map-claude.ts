import type { AgentEvent, ClaudeSdkMessage } from './types.js';

export type MapState = {
  sessionId: string;
  runId?: string;
  messageId?: string;
  started: boolean;
  /** Partial deltas already carried this assistant message's text. */
  streamed?: boolean;
};

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
    const backendMessageId = typeof message.message.id === 'string' ? message.message.id : message.uuid;
    const text = textFromContent(message.message.content);
    const events: AgentEvent[] = [];
    if (state.messageId === undefined) {
      state.messageId = backendMessageId ?? `cc-${state.sessionId}-assistant`;
      state.started = true;
      events.push({ type: 'message/start', messageId: state.messageId, role: 'assistant', ...(backendMessageId === undefined ? {} : { backendMessageId }), ...(runId === undefined ? {} : { runId }) });
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
    // A native error is reported through the prompt outcome, not as an abort.
    return events;
  }
  return [];
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
