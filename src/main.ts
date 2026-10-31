import { createInterface } from 'node:readline';
import { createCallbackIo, ClaudePlugin } from './plugin.js';
import { parseFrame } from './frames.js';
import { createClaudeCliQueryPort } from './cli-query.js';
import type { Frame } from './types.js';

function stdoutWrite(frame: Frame): void {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

const waiters = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
const io = createCallbackIo(stdoutWrite, waiters);

const query = createClaudeCliQueryPort();

const plugin = new ClaudePlugin({ io, query });

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  const frame = parseFrame(line);
  if (frame === undefined) return;
  if (frame.kind === 'response') {
    const pending = waiters.get(frame.requestId);
    if (pending === undefined) return;
    waiters.delete(frame.requestId);
    if (frame.ok) pending.resolve(frame.result);
    else pending.reject(new Error(frame.error.message));
    return;
  }
  void plugin.handle(frame);
});
