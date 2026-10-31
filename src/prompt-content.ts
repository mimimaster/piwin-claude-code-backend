import { readFileSync } from 'node:fs';
import type { ClaudeImagePart } from './types.js';

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export type ClaudeImagesResult =
  | { ok: true; images: ClaudeImagePart[] }
  | { ok: false; reason: string };

/** Native image parts from Host media refs. Never put path/base64 into prompt text. */
export function claudeImagesFromAttachments(
  attachments: unknown,
  readFile: (path: string) => Buffer | undefined = readBytes,
): ClaudeImagesResult {
  if (!Array.isArray(attachments) || attachments.length === 0) return { ok: true, images: [] };
  const images: ClaudeImagePart[] = [];
  for (const item of attachments) {
    if (typeof item !== 'object' || item === null) continue;
    const rec = item as Record<string, unknown>;
    if (rec.kind !== 'media') continue;
    const mimeType = typeof rec.mimeType === 'string' ? rec.mimeType : '';
    const contentKind = rec.contentKind;
    const isImage = contentKind === 'image' || (contentKind === undefined && mimeType.toLowerCase().startsWith('image/'));
    if (!isImage) continue;
    if (typeof rec.path !== 'string' || rec.path.length === 0) {
      return { ok: false, reason: 'image attachment is missing a Host media path' };
    }
    const bytes = readFile(rec.path);
    if (bytes === undefined) return { ok: false, reason: 'image attachment could not be read' };
    if (bytes.byteLength > MAX_IMAGE_BYTES) return { ok: false, reason: 'image attachment exceeds 8 MiB' };
    images.push({ mimeType: mimeType || 'image/png', data: bytes.toString('base64') });
  }
  return { ok: true, images };
}

function readBytes(path: string): Buffer | undefined {
  try {
    return readFileSync(path);
  } catch {
    return undefined;
  }
}
