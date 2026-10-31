import { describe, expect, it } from 'vitest';
import { isUserOwnedClaudeBinary, resolveClaudeBinary } from '../src/binary.js';

describe('claude binary resolution', () => {
  it('rejects SDK optional platform binaries', () => {
    expect(isUserOwnedClaudeBinary('/app/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude')).toBe(false);
    expect(isUserOwnedClaudeBinary('/usr/local/bin/claude')).toBe(true);
  });

  it('prefers Host runtime.binaryPath when it exists', () => {
    const resolved = resolveClaudeBinary({
      hostBinaryPath: '/opt/claude',
      pathExists: (path) => path === '/opt/claude',
      env: { PATH: '/usr/bin' },
    });
    expect(resolved).toEqual({ ok: true, binaryPath: '/opt/claude' });
  });

  it('reports searched paths when missing', () => {
    const resolved = resolveClaudeBinary({
      pathExists: () => false,
      env: { PATH: '/nope', CLAUDE_CLI: '/missing/claude' },
    });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.searched).toContain('/missing/claude');
  });
});
