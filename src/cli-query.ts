import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isUserOwnedClaudeBinary } from './binary.js';
import type { ClaudeQueryOptions, ClaudeQueryPort, ClaudeSdkMessage } from './types.js';

export function buildClaudeCliArgs(options: ClaudeQueryOptions): string[] {
  const args = [
    '--print',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--await-initialize',
    '--permission-mode', 'manual',
    '--permission-prompt-tool', 'stdio',
  ];
  if (options.settingSources.length === 0) {
    args.push('--bare', '--safe-mode', '--setting-sources', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}');
  } else {
    args.push('--setting-sources', options.settingSources.join(','));
  }
  if (typeof options.resume === 'string' && options.resume.length > 0) args.push('--resume', options.resume);
  if (typeof options.model === 'string' && options.model.length > 0) args.push('--model', options.model);
  return args;
}

export function createClaudeCliQueryPort(input: {
  spawnImpl?: typeof spawn;
  env?: NodeJS.ProcessEnv;
} = {}): ClaudeQueryPort {
  const spawnImpl = input.spawnImpl ?? spawn;
  const children = new Set<ChildProcessWithoutNullStreams>();
  return {
    async *query(request) {
      const prompt = request.prompt;
      const options = request.options;
      if (!isUserOwnedClaudeBinary(options.pathToClaudeCodeExecutable)) {
        throw new Error('refusing SDK platform binary');
      }
      const env = { ...(input.env ?? process.env) };
      const child = spawnImpl(options.pathToClaudeCodeExecutable, buildClaudeCliArgs(options), {
        cwd: options.cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      }) as ChildProcessWithoutNullStreams;
      children.add(child);
      child.stderr.resume();
      const lines = readLines(child);
      const initId = randomUUID();
      writeJson(child, { type: 'control_request', request_id: initId, request: { subtype: 'initialize' } });
      writeJson(child, {
        type: 'user',
        uuid: randomUUID(),
        parent_tool_use_id: null,
        message: { role: 'user', content: userContent(prompt, request.images) },
      });
      try {
        for await (const message of lines) {
          if (message.type === 'control_request' && rec(message.request)?.subtype === 'can_use_tool') {
            const request = rec(message.request) ?? {};
            const toolName = typeof request.tool_name === 'string' ? request.tool_name : 'tool';
            const decision = options.canUseTool === undefined
              ? { behavior: 'deny' as const, message: 'denied' }
              : await options.canUseTool(toolName, request.input);
            writeJson(child, {
              type: 'control_response',
              response: {
                subtype: 'success',
                request_id: message.request_id,
                response: {
                  behavior: decision.behavior,
                  ...(decision.behavior === 'allow' ? { updatedInput: decision.updatedInput ?? request.input } : { message: decision.message ?? 'denied' }),
                  toolUseID: request.tool_use_id,
                },
              },
            });
            continue;
          }
          if (isSdkMessage(message)) yield message;
          if (message.type === 'result') break;
        }
      } finally {
        children.delete(child);
        await closeChild(child);
      }
    },
    async interrupt() {
      for (const live of [...children]) {
        writeJson(live, { type: 'control_request', request_id: randomUUID(), request: { subtype: 'interrupt' } });
      }
    },
  };
}

type NativeLine = {
  type?: string;
  request_id?: string;
  request?: unknown;
  [key: string]: unknown;
};

async function* readLines(child: ChildProcessWithoutNullStreams): AsyncGenerator<NativeLine> {
  child.stdout.setEncoding('utf8');
  let buffer = '';
  for await (const chunk of child.stdout) {
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line.length > 0) {
        try { yield JSON.parse(line) as NativeLine; }
        catch { /* ignore non-JSON native noise */ }
      }
      index = buffer.indexOf('\n');
    }
  }
}

function writeJson(child: ChildProcessWithoutNullStreams, value: unknown): void {
  child.stdin.write(`${JSON.stringify(value)}\n`);
}

async function closeChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.killed) return;
  child.stdin.end();
  child.kill('SIGTERM');
}

function rec(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function isSdkMessage(value: NativeLine): value is ClaudeSdkMessage {
  return value.type === 'system' || value.type === 'assistant' || value.type === 'stream_event' || value.type === 'user' || value.type === 'result';
}

function userContent(prompt: string, images: readonly { mimeType: string; data: string }[] | undefined): unknown {
  const blocks: unknown[] = [{ type: 'text', text: prompt }];
  for (const image of images ?? []) {
    blocks.push({
      type: 'image',
      source: { type: 'base64', media_type: image.mimeType, data: image.data },
    });
  }
  return blocks;
}
