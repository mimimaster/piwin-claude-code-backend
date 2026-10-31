import { describe, expect, it } from 'vitest';
import { ClaudePlugin, createCallbackIo } from '../src/plugin.js';
import { buildClaudeCliArgs } from '../src/cli-query.js';
import type { ClaudeQueryOptions, ClaudeQueryPort, Frame } from '../src/types.js';

const sessionScope = { kind: 'session' as const, sessionId: 'host-1', runtimeGenerationId: 'gen-1' };

function req(method: string, params: unknown, scope: object = { kind: 'plugin' }): Extract<Frame, { kind: 'request' }> {
  return { protocolVersion: 1, kind: 'request', requestId: `r-${method}`, scope: scope as never, method, params };
}

function lastResult(written: Frame[]): Record<string, unknown> {
  const frame = written.at(-1);
  if (frame?.kind !== 'response' || !frame.ok) throw new Error(`expected ok response, got ${JSON.stringify(frame)}`);
  return frame.result as Record<string, unknown>;
}

async function setup() {
  const written: Frame[] = [];
  const io = createCallbackIo((frame) => written.push(frame), new Map());
  const seen: ClaudeQueryOptions[] = [];
  const query: ClaudeQueryPort = {
    async *query({ options }) {
      seen.push(options);
      yield { type: 'result', session_id: 'native-1' };
    },
  };
  const plugin = new ClaudePlugin({ io, query, pathExists: (path) => path === '/opt/claude', env: { PATH: '' } });
  await plugin.handle(req('plugin/initialize', { runtime: { binaryPath: '/opt/claude' }, hostCapabilities: {} }));
  return { plugin, written, seen };
}

describe('claude model catalog', () => {
  it('check() exposes a draft catalog defaulting to haiku without running inference', async () => {
    const { plugin, written, seen } = await setup();
    await plugin.handle(req('check', { refresh: true }));
    const options = lastResult(written).options as { models: { id: string }[]; currentModelId: string };
    expect(options.models.map((model) => model.id)).toEqual(['haiku', 'sonnet', 'opus']);
    expect(options.currentModelId).toBe('haiku');
    expect(seen).toEqual([]);
  });

  it('session/model selection reaches the native --model flag', async () => {
    const { plugin, written, seen } = await setup();
    await plugin.handle(req('session/new', { cwd: '/work' }, sessionScope));
    expect((lastResult(written).options as { currentModelId: string }).currentModelId).toBe('haiku');

    await plugin.handle(req('session/model', { modelId: 'sonnet' }, sessionScope));
    expect(lastResult(written).currentModelId).toBe('sonnet');

    await plugin.handle(req('session/prompt', { runId: 'run-1', input: { text: 'hi' } }, sessionScope));
    expect(seen[0]?.model).toBe('sonnet');
    expect(buildClaudeCliArgs({ cwd: '/w', pathToClaudeCodeExecutable: '/opt/claude', settingSources: [], model: 'sonnet' }))
      .toEqual(expect.arrayContaining(['--model', 'sonnet']));
  });

  it('rejects an unknown model without changing the selection', async () => {
    const { plugin, written } = await setup();
    await plugin.handle(req('session/new', { cwd: '/work' }, sessionScope));
    await plugin.handle(req('session/model', { modelId: 'gpt-x' }, sessionScope));
    expect(written.at(-1)).toMatchObject({ ok: false, error: { code: 'invalid-request' } });
    await plugin.handle(req('session/options', {}, sessionScope));
    expect(lastResult(written).currentModelId).toBe('haiku');
  });
});
