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
});
