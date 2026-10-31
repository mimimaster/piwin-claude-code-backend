import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { encodeClaudeProjectDir, reconstructClaudeHistory } from '../src/claude-history.js';

const jsonl = [
  JSON.stringify({ type: 'queue-operation', operation: 'enqueue' }),
  JSON.stringify({
    type: 'user',
    uuid: 'u1',
    message: { role: 'user', content: [{ type: 'text', text: 'hello from history' }] },
  }),
  JSON.stringify({
    type: 'assistant',
    uuid: 'a1',
    message: { id: 'msg_a1', content: [{ type: 'text', text: 'prior assistant' }] },
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

  it('fails closed when the jsonl is missing', () => {
    expect(reconstructClaudeHistory({
      historyRoot: '/hist',
      cwd: '/work',
      sessionId: 'missing',
      readFile: () => undefined,
    })).toEqual({ ok: false, reason: 'native history unavailable' });
  });
});
