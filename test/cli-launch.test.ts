import { describe, expect, it } from 'vitest';
import { claudeCliLaunch } from '../src/cli-launch.js';

describe('claude cli launch', () => {
  it('resumes the stored native id and never carries executable/cwd/env', () => {
    const result = claudeCliLaunch({ backendSessionId: 'sess-1', cwd: '/work' });
    expect(result.backendSessionId).toBe('sess-1');
    expect(result.args).toContain('sess-1');
    expect(result.args).toEqual(['--resume', 'sess-1']);
    expect(result).not.toHaveProperty('executable');
    expect(result).not.toHaveProperty('env');
  });
});
