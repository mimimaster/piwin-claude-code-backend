import { describe, expect, it } from 'vitest';
import { isSilentEmptySettings, resolveSettingSources } from '../src/settings.js';

describe('claude settings sources', () => {
  it('uses native coding sources and refuses silent empty', () => {
    expect(resolveSettingSources('coding')).toEqual(['user', 'project', 'local']);
    expect(isSilentEmptySettings('coding', [])).toBe(true);
    expect(isSilentEmptySettings('coding', resolveSettingSources('coding'))).toBe(false);
    expect(resolveSettingSources('empty')).toEqual([]);
  });
});
