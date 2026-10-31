import { describe, expect, it } from 'vitest';
import { ClaudePlugin, createCallbackIo } from '../src/plugin.js';
import type { ClaudeQueryPort, ClaudeSdkMessage, Frame } from '../src/types.js';

const sessionScope = { kind: 'session' as const, sessionId: 'host-1', runtimeGenerationId: 'gen-1' };

function req(method: string, params: unknown, scope: object = { kind: 'plugin' }): Extract<Frame, { kind: 'request' }> {
  return { protocolVersion: 1, kind: 'request', requestId: `r-${method}`, scope: scope as never, method, params };
}


const historyJsonl = [
  JSON.stringify({ type: 'user', uuid: 'u1', message: { role: 'user', content: [{ type: 'text', text: 'hello from history' }] } }),
  JSON.stringify({ type: 'assistant', uuid: 'a1', message: { id: 'msg_a1', content: [{ type: 'text', text: 'prior assistant' }] } }),
].join('\n');

function messages(): ClaudeSdkMessage[] {
  return [
    { type: 'system', subtype: 'init', session_id: 'native-cc-saved', commands: [], models: [] },
    { type: 'result', session_id: 'native-cc-saved' },
  ];
}

describe('claude load/resume identity (CC-02 / CC-03)', () => {
  it('session/new first prompt has no synthetic resume id', async () => {
    const resumes: Array<string | undefined> = [];
    const query: ClaudeQueryPort = {
      async *query({ options }) {
        resumes.push(options.resume);
        for (const message of messages()) yield message;
      },
    };
    const written: Frame[] = [];
    const io = createCallbackIo((frame) => written.push(frame), new Map());
    const plugin = new ClaudePlugin({
      io,
      query,
      pathExists: (path) => path === '/opt/claude',
      env: { PATH: '' },
    });
    await plugin.handle(req('plugin/initialize', {
      runtime: { binaryPath: '/opt/claude' },
      hostCapabilities: {},
    }));
    await plugin.handle(req('session/new', { cwd: '/work', binding: { agentId: 'claude-code' } }, sessionScope));
    await plugin.handle(req('session/prompt', { runId: 'run-new', input: { text: 'hello' } }, sessionScope));
    expect(resumes).toEqual([undefined]);
  });

  it('fresh process session/load of a stored native id resumes that exact id on the first prompt', async () => {
    const resumes: Array<string | undefined> = [];
    const query: ClaudeQueryPort = {
      async *query({ options }) {
        resumes.push(options.resume);
        for (const message of messages()) yield message;
      },
    };
    const written: Frame[] = [];
    const io = createCallbackIo((frame) => written.push(frame), new Map());
    const plugin = new ClaudePlugin({
      io,
      query,
      pathExists: (path) => path === '/opt/claude',
      env: { PATH: '' },
      historyRoot: '/hist',
      readHistoryFile: (path) => path.endsWith('native-cc-saved.jsonl') ? historyJsonl : undefined,
    });
    await plugin.handle(req('plugin/initialize', {
      runtime: { binaryPath: '/opt/claude' },
      hostCapabilities: {},
    }));
    await plugin.handle(req('session/load', {
      cwd: '/work',
      binding: { agentId: 'claude-code', backendSessionId: 'native-cc-saved' },
    }, sessionScope));
    const loaded = written.at(-1) as Extract<Frame, { kind: 'response'; ok: true }>;
    expect(loaded.ok).toBe(true);
    expect((loaded.result as { backendSessionId: string }).backendSessionId).toBe('native-cc-saved');
    const replay = JSON.stringify((loaded.result as { replayEvents: unknown[] }).replayEvents);
    expect(replay).toContain('hello from history');
    expect(replay).toContain('prior assistant');
    await plugin.handle(req('session/prompt', { runId: 'run-load', input: { text: 'continue' } }, sessionScope));
    expect(resumes).toEqual(['native-cc-saved']);
  });

  it('session/new does not persist a synthetic cc- host id', async () => {
    const written: Frame[] = [];
    const io = createCallbackIo((frame) => written.push(frame), new Map());
    const plugin = new ClaudePlugin({
      io,
      query: { async *query() { /* unused */ } },
      pathExists: (path) => path === '/opt/claude',
      env: { PATH: '' },
    });
    await plugin.handle(req('plugin/initialize', { runtime: { binaryPath: '/opt/claude' }, hostCapabilities: {} }));
    await plugin.handle(req('session/new', { cwd: '/work', binding: { agentId: 'claude-code' } }, sessionScope));
    const opened = written.at(-1) as Extract<Frame, { kind: 'response'; ok: true }>;
    expect(opened.ok).toBe(true);
    expect((opened.result as { backendSessionId: string }).backendSessionId).toBe('');
  });

  it('session/load of a missing or synthetic id fails without opening a fresh session', async () => {
    const written: Frame[] = [];
    const io = createCallbackIo((frame) => written.push(frame), new Map());
    const plugin = new ClaudePlugin({
      io,
      query: { async *query() { throw new Error('must not start inference'); } },
      pathExists: (path) => path === '/opt/claude',
      env: { PATH: '' },
    });
    await plugin.handle(req('plugin/initialize', { runtime: { binaryPath: '/opt/claude' }, hostCapabilities: {} }));
    await plugin.handle(req('session/load', { cwd: '/work', binding: { agentId: 'claude-code' } }, sessionScope));
    expect(written.at(-1)).toMatchObject({ ok: false, error: { code: 'invalid-request', message: 'native session id required' } });
    await plugin.handle(req('session/load', {
      cwd: '/work',
      binding: { agentId: 'claude-code', backendSessionId: 'cc-host-1' },
    }, sessionScope));
    expect(written.at(-1)).toMatchObject({ ok: false, error: { code: 'invalid-request', message: 'native session id required' } });
    await plugin.handle(req('session/load', {
      cwd: '/work',
      binding: { agentId: 'claude-code', backendSessionId: 'native-cc-saved' },
    }, sessionScope));
    expect(written.at(-1)).toMatchObject({ ok: false, error: { code: 'unavailable', message: 'native history unavailable' } });
  });

  it('catalog/native-observe is read-only and does not start inference', async () => {
    let queried = 0;
    const written: Frame[] = [];
    const io = createCallbackIo((frame) => written.push(frame), new Map());
    const plugin = new ClaudePlugin({
      io,
      query: { async *query() { queried += 1; throw new Error('observe must not query'); } },
      pathExists: (path) => path === '/opt/claude',
      env: { PATH: '' },
      historyRoot: '/hist',
      readHistoryFile: (path) => path.endsWith('native-cc-saved.jsonl') ? historyJsonl : undefined,
    });
    await plugin.handle(req('plugin/initialize', { runtime: { binaryPath: '/opt/claude' }, hostCapabilities: {} }));
    await plugin.handle(req('catalog/native-observe', {
      backendSessionId: 'native-cc-saved',
      workingDirectory: '/work',
      includeHistory: true,
    }));
    const observed = written.at(-1) as Extract<Frame, { kind: 'response'; ok: true }>;
    expect(observed.ok).toBe(true);
    expect(observed.result).toMatchObject({ backendSessionId: 'native-cc-saved', activity: 'idle' });
    expect(JSON.stringify(observed.result)).toContain('hello from history');
    expect(queried).toBe(0);
  });
});
