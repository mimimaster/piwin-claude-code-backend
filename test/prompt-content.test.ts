import { describe, expect, it } from 'vitest';
import { claudeImagesFromAttachments } from '../src/prompt-content.js';

describe('claude image attachments', () => {
  it('loads Host media refs as native image parts and never returns a path as text', () => {
    const result = claudeImagesFromAttachments(
      [{ kind: 'media', path: '/media/shot.png', mimeType: 'image/png', byteSize: 4, source: 'paste' }],
      (path) => path === '/media/shot.png' ? Buffer.from('PNG!') : undefined,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.images).toEqual([{ mimeType: 'image/png', data: Buffer.from('PNG!').toString('base64') }]);
    expect(JSON.stringify(result.images)).not.toContain('/media/shot.png');
  });

  it('fails closed when the media file is missing', () => {
    expect(claudeImagesFromAttachments(
      [{ kind: 'media', path: '/missing.png', mimeType: 'image/png' }],
      () => undefined,
    )).toEqual({ ok: false, reason: 'image attachment could not be read' });
  });
});
