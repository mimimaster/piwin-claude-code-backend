import { describe, expect, it } from 'vitest';
import { encodeFrame, parseFrame, requestFrame } from '../src/frames.js';

describe('frames', () => {
  it('round-trips a request and rejects junk', () => {
    const frame = requestFrame({ kind: 'plugin' }, 'r1', 'check', { refresh: false });
    const parsed = parseFrame(encodeFrame(frame).trim());
    expect(parsed).toEqual(frame);
    expect(parseFrame('not-json')).toBeUndefined();
  });
});
