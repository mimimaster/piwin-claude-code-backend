import { describe, expect, it } from 'vitest';
import { ClaudePlugin, createCallbackIo } from '../src/plugin.js';
import type { ClaudeQueryPort, Frame } from '../src/types.js';

const sessionScope = { kind: 'session' as const, sessionId: 'host-1', runtimeGenerationId: 'gen-1' };
function req(method: string, params: unknown, scope: object = { kind: 'plugin' }): Extract<Frame, { kind: 'request' }> {
  return { protocolVersion: 1, kind: 'request', requestId: `r-${method}`, scope: scope as never, method, params };
}

describe('claude image prompt', () => {
  it('sends native image parts and keeps the path out of prompt text', async () => {
    const seen: Array<{ prompt: string; images?: readonly { mimeType: string; data: string }[] }> = [];
    const query: ClaudeQueryPort = {
      async *query(input) {
        seen.push({ prompt: input.prompt, ...(input.images === undefined ? {} : { images: input.images }) });
        yield { type: 'system', subtype: 'init', session_id: 'native-img', commands: [], models: [] };
        yield { type: 'result', session_id: 'native-img' };
      },
    };
    const written: Frame[] = [];
    const plugin = new ClaudePlugin({
      io: createCallbackIo((frame) => written.push(frame), new Map()),
      query,
      pathExists: (path) => path === '/opt/claude',
      env: { PATH: '' },
      readMediaFile: (path) => path === '/media/shot.png' ? Buffer.from('PNG!') : undefined,
    });
    await plugin.handle(req('plugin/initialize', { runtime: { binaryPath: '/opt/claude' }, hostCapabilities: {} }));
    await plugin.handle(req('session/new', { cwd: '/work', binding: { agentId: 'claude-code' } }, sessionScope));
    await plugin.handle(req('session/prompt', {
      runId: 'run-img',
      input: {
        text: 'what is this',
        attachments: [{ kind: 'media', path: '/media/shot.png', mimeType: 'image/png', byteSize: 4, source: 'paste' }],
      },
    }, sessionScope));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.prompt).toBe('what is this');
    expect(seen[0]?.prompt).not.toContain('/media/shot.png');
    expect(seen[0]?.images?.[0]?.mimeType).toBe('image/png');
    expect(seen[0]?.images?.[0]?.data).toBe(Buffer.from('PNG!').toString('base64'));
  });
});
