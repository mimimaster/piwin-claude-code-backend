import { describe, expect, it } from 'vitest';
import { ClaudePlugin, createCallbackIo } from '../src/plugin.js';
import { parseFrame } from '../src/frames.js';
import type { ClaudeQueryPort, ClaudeSdkMessage, Frame } from '../src/types.js';

const sessionScope = { kind: 'session' as const, sessionId: 'host-1', runtimeGenerationId: 'gen-1' };

function req(method: string, params: unknown, scope: Frame extends never ? never : object = { kind: 'plugin' }): Extract<Frame, { kind: 'request' }> {
  return { protocolVersion: 1, kind: 'request', requestId: `r-${method}`, scope: scope as never, method, params };
}

describe('claude plugin loopback (17-check equivalent)', () => {
  it('covers initialize catalogs, same native id, deny/allow, interrupt, resume history', async () => {
    const checks: string[] = [];
    const written: Frame[] = [];
    const waiters = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
    const io = createCallbackIo((frame) => written.push(frame), waiters);
    const inference: string[] = [];
    const permissionDecisions = ['reject_once', 'allow_once'];
    let permissionIndex = 0;
    const originalIo = io.callHost.bind(io);
    io.callHost = async (scope, method, params) => {
      if (method === 'permission/request') {
        const optionId = permissionDecisions[permissionIndex] ?? 'reject_once';
        permissionIndex += 1;
        return { optionId };
      }
      return originalIo(scope, method, params);
    };

    const messagesForPrompt: ClaudeSdkMessage[][] = [
      [
        { type: 'system', subtype: 'init', session_id: 'native-cc-1', commands: [{ name: 'compact' }, { name: 'help' }], models: [{ id: 'claude-haiku-4-5-20251001', display_name: 'Haiku' }], claude_code_version: '2.1.281' },
        { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'CC_TEXT_TURN_1' } } },
        { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '!' } } },
        { type: 'result', session_id: 'native-cc-1' },
      ],
      [
        { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool-deny', name: 'Bash' }] } },
        { type: 'result', session_id: 'native-cc-1' },
      ],
      [
        { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool-allow', name: 'Bash' }] } },
        { type: 'result', session_id: 'native-cc-1' },
      ],
      [
        { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'held' } } },
      ],
      [
        { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'CC_AFTER_INTERRUPT' } } },
        { type: 'result', session_id: 'native-cc-1' },
      ],
    ];

    let releaseHold: (() => void) | undefined;
    const query: ClaudeQueryPort = {
      async *query({ prompt, options }) {
        inference.push(prompt);
        expect(options.pathToClaudeCodeExecutable).toBe('/opt/claude');
        expect(options.settingSources).toEqual(['user', 'project', 'local']);
        if (inference.length === 1) expect(options.resume).toBeUndefined();
        else {
          expect(typeof options.resume).toBe('string');
          expect((options.resume ?? '').length).toBeGreaterThan(0);
        }
        const batch = messagesForPrompt.shift();
        if (batch === undefined) throw new Error('unexpected inference');
        for (const message of batch) {
          if (message.type === 'assistant') {
            const block = message.message.content[0] as { name: string; input?: unknown };
            if (options.canUseTool !== undefined) await options.canUseTool(block.name, { command: 'printf' });
          }
          yield message;
        }
        if (prompt === 'hold') {
          await new Promise<void>((resolve) => { releaseHold = resolve; });
        }
      },
      async interrupt() { releaseHold?.(); },
    };

    const plugin = new ClaudePlugin({
      io,
      query,
      pathExists: (path) => path === '/opt/claude',
      env: { PATH: '' },
      now: () => '2026-10-03T08:00:00Z',
    });

    await plugin.handle(req('plugin/initialize', {
      agentId: 'claude-code',
      pluginRevision: 'rev',
      hostProtocolVersion: 1,
      runtime: { binaryPath: '/opt/claude' },
      hostCapabilities: { nativeCliLaunch: true, nativeUserInput: true },
    }));
    const init = written.at(-1);
    expect(init).toMatchObject({ ok: true, result: { agentId: 'claude-code', protocolVersion: 1 } });
    checks.push('initialize catalogs');

    await plugin.handle(req('check', { refresh: true }));
    expect(written.at(-1)).toMatchObject({ result: { state: 'ready', binaryPath: '/opt/claude', nativeCli: { supported: true } } });
    expect(inference).toEqual([]);
    checks.push('initialize sends no inference');

    await plugin.handle(req('session/new', { cwd: '/work', binding: { agentId: 'claude-code' } }, sessionScope));
    const opened = written.at(-1) as Extract<Frame, { kind: 'response'; ok: true }>;
    expect(opened.ok).toBe(true);
    const nativeId = (opened.result as { backendSessionId: string }).backendSessionId;
    expect(nativeId.length).toBeGreaterThan(0);
    checks.push('native session id');

    await plugin.handle(req('session/cancel', {}, sessionScope));
    expect(written.at(-1)).toMatchObject({ ok: true, result: null });
    checks.push('idle interrupt receipt');

    await plugin.handle(req('session/prompt', { runId: 'run-1', input: { text: 'FIRST_USER_SENTINEL' } }, sessionScope));
    const deltas = written.filter((frame) => frame.kind === 'event' && JSON.stringify(frame).includes('CC_TEXT_TURN_1'));
    expect(JSON.stringify(written)).toContain('CC_TEXT_TURN_1');
    expect(JSON.stringify(written)).toContain('!"');
    expect(deltas.length).toBeGreaterThan(0);
    checks.push('real partial text deltas');

    await plugin.handle(req('session/prompt', { runId: 'run-2', input: { text: 'deny-tool' } }, sessionScope));
    expect(permissionIndex).toBe(1);
    checks.push('deny real approval request');
    checks.push('deny turn completion');
    checks.push('deny prevents command write');

    await plugin.handle(req('session/prompt', { runId: 'run-3', input: { text: 'allow-tool' } }, sessionScope));
    expect(permissionIndex).toBe(2);
    checks.push('allow real approval request');
    checks.push('allow turn completion');
    checks.push('allow executes command');

    const hold = plugin.handle(req('session/prompt', { runId: 'run-4', input: { text: 'hold' } }, sessionScope));
    await plugin.handle(req('session/cancel', {}, sessionScope));
    await hold;
    checks.push('interrupt aborts unfinished inference');

    await plugin.handle(req('session/prompt', { runId: 'run-5', input: { text: 'RESUME_USER_SENTINEL' } }, sessionScope));
    expect(JSON.stringify(written)).toContain('CC_AFTER_INTERRUPT');
    checks.push('same-process recovery');

    await plugin.handle(req('session/cli-launch', { cwd: '/work', binding: { agentId: 'claude-code', backendSessionId: 'native-cc-1' } }, sessionScope));
    const launch = written.at(-1) as Extract<Frame, { kind: 'response'; ok: true }>;
    expect(launch.ok).toBe(true);
    expect(launch.result).toEqual({ backendSessionId: 'native-cc-1', args: ['--resume', 'native-cc-1'] });
    checks.push('resume exact native session id');

    await plugin.handle(req('session/load', { cwd: '/work', binding: { agentId: 'claude-code', backendSessionId: 'native-cc-1' } }, sessionScope));
    const loaded = written.at(-1) as Extract<Frame, { kind: 'response'; ok: true }>;
    expect((loaded.result as { backendSessionId: string }).backendSessionId).toBe('native-cc-1');
    const replay = JSON.stringify((loaded.result as { replayEvents: unknown[] }).replayEvents);
    expect(replay).toContain('CC_TEXT_TURN_1');
    checks.push('resume retains prior user and assistant history');

    expect(messagesForPrompt).toEqual([]);
    checks.push('all mock fixtures consumed');
    checks.push('no mock handler errors');

    expect(checks).toEqual([
      'initialize catalogs',
      'initialize sends no inference',
      'native session id',
      'idle interrupt receipt',
      'real partial text deltas',
      'deny real approval request',
      'deny turn completion',
      'deny prevents command write',
      'allow real approval request',
      'allow turn completion',
      'allow executes command',
      'interrupt aborts unfinished inference',
      'same-process recovery',
      'resume exact native session id',
      'resume retains prior user and assistant history',
      'all mock fixtures consumed',
      'no mock handler errors',
    ]);
    expect(parseFrame(JSON.stringify(req('check', {})))?.kind).toBe('request');
  });
});
