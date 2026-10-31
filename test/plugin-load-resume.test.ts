import { describe, expect, it } from 'vitest';
import { ClaudePlugin, createCallbackIo } from '../src/plugin.js';
import type { ClaudeQueryPort, ClaudeSdkMessage, Frame } from '../src/types.js';

const sessionScope = { kind: 'session' as const, sessionId: 'host-1', runtimeGenerationId: 'gen-1' };

function req(method: string, params: unknown, scope: object = { kind: 'plugin' }): Extract<Frame, { kind: 'request' }> {
  return { protocolVersion: 1, kind: 'request', requestId: `r-${method}`, scope: scope as never, method, params };
}

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
    await plugin.handle(req('session/prompt', { runId: 'run-load', input: { text: 'continue' } }, sessionScope));
    expect(resumes).toEqual(['native-cc-saved']);
  });
});
