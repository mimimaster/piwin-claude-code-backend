#!/usr/bin/env node
/**
 * Fake user-owned Claude CLI for process-level tests. Speaks stream-json.
 * No provider account. ANTHROPIC_API_KEY is ignored.
 */
import { createInterface } from 'node:readline';

if (process.argv.includes('--version')) {
  process.stdout.write('2.1.281-fake\n');
  process.exit(0);
}

const resumeAt = process.argv.indexOf('--resume');
const resume = resumeAt >= 0 ? process.argv[resumeAt + 1] : undefined;
const sessionId = typeof resume === 'string' && resume.length > 0 ? resume : 'fake-cc-1';

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  let message;
  try { message = JSON.parse(line); }
  catch { return; }
  if (message.type === 'control_request' && message.request?.subtype === 'initialize') {
    write({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: {} } });
    return;
  }
  if (message.type === 'control_request' && message.request?.subtype === 'interrupt') {
    write({ type: 'result', subtype: 'error', is_error: true, session_id: sessionId, result: 'interrupted' });
    return;
  }
  if (message.type !== 'user') return;
  const content = message.message?.content;
  let text = '';
  let sawImage = false;
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    for (const block of content) {
      if (block?.type === 'text' && typeof block.text === 'string') text += block.text;
      if (block?.type === 'image') sawImage = true;
    }
  }
  write({
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    commands: [{ name: 'compact' }],
    models: [{ id: 'claude-haiku-4-5-20251001', display_name: 'Haiku' }],
    claude_code_version: '2.1.281-fake',
  });
  const reply = sawImage ? `MOCK_IMAGE ${text}` : `MOCK_OK ${text}`;
  write({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: reply } } });
  write({ type: 'result', session_id: sessionId, result: reply });
});
