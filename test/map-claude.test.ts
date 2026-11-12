import { describe, expect, it } from 'vitest';
import { mapClaudeMessage, type MapState } from '../src/map-claude.js';

describe('map claude sdk messages', () => {
  it('emits session start, partial text, and tool ids without duplicating finals', () => {
    const state: MapState = { sessionId: 'pending', started: false };
    expect(mapClaudeMessage(state, { type: 'system', subtype: 'init', session_id: 'native-1' })).toEqual([
      { type: 'session/started', sessionId: 'native-1' },
    ]);
    const first = mapClaudeMessage(state, {
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'CC_TEXT_TURN_1' } },
    });
    expect(first[0]).toMatchObject({ type: 'message/start', role: 'assistant' });
    expect(first[1]).toMatchObject({ type: 'message/text_delta', delta: 'CC_TEXT_TURN_1' });
    const second = mapClaudeMessage(state, {
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '!' } },
    });
    expect(second).toEqual([expect.objectContaining({ type: 'message/text_delta', delta: '!' })]);
    const tool = mapClaudeMessage(state, {
      type: 'assistant',
      message: { id: 'msg-1', content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash' }] },
    });
    expect(tool).toEqual([expect.objectContaining({ type: 'tool/start', toolCallId: 'tool-1', toolName: 'Bash' })]);
  });

  it('emits finalized per-call usage bound to the Host session id and pro-rated costUsd', () => {
    const state: MapState = {
      sessionId: 'native-1',
      hostSessionId: 'host-session-1',
      runtimeGenerationId: 'gen-1',
      runId: 'run-1',
      modelId: 'opus',
      now: () => '2026-11-12T04:00:00.000Z',
      started: false,
    };
    mapClaudeMessage(state, {
      type: 'assistant',
      message: {
        id: 'msg_01',
        model: 'claude-opus-5-5',
        usage: {
          input_tokens: 10,
          cache_creation_input_tokens: 1000,
          cache_read_input_tokens: 4000,
          output_tokens: 120,
          output_tokens_details: { thinking_tokens: 40 },
        },
        content: [{ type: 'text', text: 'done' }],
      },
    });
    const endEvents = mapClaudeMessage(state, {
      type: 'result',
      session_id: 'native-1',
      total_cost_usd: 0.042,
    });
    expect(endEvents).toEqual([
      { type: 'message/end', messageId: 'msg_01', runId: 'run-1' },
      {
        type: 'usage/finalized',
        measurement: {
          measurementId: 'claude-code:msg_01',
          sessionId: 'host-session-1',
          runId: 'run-1',
          runtimeGenerationId: 'gen-1',
          messageId: 'msg_01',
          modelId: 'claude-opus-5-5',
          promptTokens: 10,
          cacheWriteTokens: 1000,
          cacheReadTokens: 4000,
          completionTokens: 120,
          reasoningTokens: 40,
          totalTokens: 5130,
          costUsd: 0.042,
          recordedAt: '2026-11-12T04:00:00.000Z',
        },
      },
    ]);
  });
});
