import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  encodeClaudeProjectDir,
  readClaudeSessionRequestUsage,
  reconstructClaudeHistory,
} from '../src/claude-history.js';

const jsonl = [
  JSON.stringify({ type: 'queue-operation', operation: 'enqueue' }),
  JSON.stringify({
    type: 'user',
    uuid: 'u1',
    message: { role: 'user', content: [{ type: 'text', text: 'hello from history' }] },
  }),
  JSON.stringify({
    type: 'assistant',
    uuid: 'a1-partial',
    timestamp: '2026-11-12T03:00:00.000Z',
    message: {
      id: 'msg_a1',
      model: 'claude-sonnet-4-5',
      usage: { input_tokens: 4, cache_read_input_tokens: 500, cache_creation_input_tokens: 100, output_tokens: 10 },
      content: [{ type: 'text', text: 'partial' }],
    },
  }),
  JSON.stringify({
    type: 'assistant',
    uuid: 'a1',
    timestamp: '2026-11-12T03:00:02.000Z',
    message: {
      id: 'msg_a1',
      model: 'claude-sonnet-4-5',
      usage: {
        input_tokens: 4,
        cache_read_input_tokens: 500,
        cache_creation_input_tokens: 100,
        output_tokens: 55,
        output_tokens_details: { thinking_tokens: 15 },
      },
      content: [{ type: 'text', text: 'prior assistant' }],
    },
  }),
  JSON.stringify({
    type: 'user',
    uuid: 'u2',
    message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] },
  }),
].join('\n');

describe('claude native history reconstruction', () => {
  it('encodes project directories the way Claude stores them', () => {
    expect(encodeClaudeProjectDir('/work')).toBe('-work');
    expect(encodeClaudeProjectDir('/Users/me/Developer/piwin')).toBe('-Users-me-Developer-piwin');
  });

  it('resolves macOS /private realpath the way Claude stores jsonl', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-hist-'));
    const real = realpathSync(dir);
    expect(encodeClaudeProjectDir(dir)).toBe(real.replace(/\//g, '-'));
  });

  it('replays user and assistant text from a session jsonl without opening a writer', () => {
    const files = new Map<string, string>([['/hist/projects/-work/native-cc-saved.jsonl', jsonl]]);
    const result = reconstructClaudeHistory({
      historyRoot: '/hist',
      cwd: '/work',
      sessionId: 'native-cc-saved',
      readFile: (path) => files.get(path),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const text = JSON.stringify(result.events);
    expect(text).toContain('hello from history');
    expect(text).toContain('prior assistant');
    expect(text).not.toContain('Request interrupted');
    expect(result.events.some((emission) => emission.event.type === 'message/start' && emission.event.role === 'user')).toBe(true);
  });

  it('extracts deduplicated per-request token usage from native session jsonl', () => {
    const files = new Map<string, string>([['/hist/projects/-work/native-cc-saved.jsonl', jsonl]]);
    const usage = readClaudeSessionRequestUsage({
      historyRoot: '/hist',
      cwd: '/work',
      sessionId: 'native-cc-saved',
      readFile: (path) => files.get(path),
    });
    expect(usage).toEqual([
      {
        requestId: 'msg_a1',
        backendSessionId: 'native-cc-saved',
        modelId: 'claude-sonnet-4-5',
        promptTokens: 4,
        cacheReadTokens: 500,
        cacheWriteTokens: 100,
        completionTokens: 55,
        reasoningTokens: 15,
        totalTokens: 659,
        recordedAt: '2026-11-12T03:00:02.000Z',
      },
    ]);
  });

  it('fails closed when the jsonl is missing', () => {
    expect(reconstructClaudeHistory({
      historyRoot: '/hist',
      cwd: '/work',
      sessionId: 'missing',
      readFile: () => undefined,
    })).toEqual({ ok: false, reason: 'native history unavailable' });
  });
});
