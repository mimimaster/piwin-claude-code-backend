import { describe, expect, it } from 'vitest';
import { resolvePromptOutcome } from '../src/prompt-outcome.js';
import { mapClaudeMessage, type MapState } from '../src/map-claude.js';

describe('prompt outcome', () => {
  it('maps native results onto the Host outcome union', () => {
    expect(resolvePromptOutcome({ cancelled: false, result: { isError: false } })).toEqual({ status: 'completed', stopReason: 'stop' });
    expect(resolvePromptOutcome({ cancelled: true, result: { isError: true } })).toEqual({ status: 'aborted', stopReason: 'aborted' });
    expect(resolvePromptOutcome({ cancelled: false, result: { isError: true, text: 'Failed to authenticate: OAuth session expired' } }))
      .toMatchObject({ status: 'failed', stopReason: 'error', failure: { code: 'provider-authentication', origin: 'provider', retriable: false } });
    expect(resolvePromptOutcome({ cancelled: false, result: { isError: true, text: 'boom' } }))
      .toMatchObject({ status: 'failed', failure: { code: 'unknown-agent-failure', message: 'boom' } });
    expect(resolvePromptOutcome({ cancelled: false })).toMatchObject({ status: 'failed', failure: { code: 'backend-worker-crash', origin: 'runtime' } });
  });
});

describe('assistant text and tool results', () => {
  it('does not repeat streamed text and closes tools on tool_result', () => {
    const state: MapState = { sessionId: 'native-1', started: false };
    mapClaudeMessage(state, { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } } });
    const final = mapClaudeMessage(state, { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'hi' }, { type: 'tool_use', id: 't1', name: 'Bash' }] } });
    expect(final.filter((event) => event.type === 'message/text_delta')).toEqual([]);
    expect(final).toContainEqual(expect.objectContaining({ type: 'tool/start', toolCallId: 't1' }));
    expect(mapClaudeMessage(state, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: false }] } }))
      .toEqual([{ type: 'tool/end', toolCallId: 't1', isError: false }]);
    const unstreamed = mapClaudeMessage(state, { type: 'assistant', message: { id: 'm2', content: [{ type: 'text', text: 'done' }] } });
    expect(unstreamed).toContainEqual(expect.objectContaining({ type: 'message/text_delta', delta: 'done' }));
  });
});
