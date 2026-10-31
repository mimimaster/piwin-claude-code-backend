import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { buildClaudeCliArgs, createClaudeCliQueryPort } from '../src/cli-query.js';

describe('claude cli query port', () => {
  it('resumes only a native id and never a SDK platform path', () => {
    const coding = buildClaudeCliArgs({
      cwd: '/work',
      pathToClaudeCodeExecutable: '/opt/claude',
      settingSources: ['user', 'project', 'local'],
      resume: 'native-1',
    });
    expect(coding).toContain('native-1');
    expect(coding).toContain('user,project,local');
    expect(coding.join(' ')).not.toMatch(/claude-agent-sdk-/);

    const first = buildClaudeCliArgs({
      cwd: '/work',
      pathToClaudeCodeExecutable: '/opt/claude',
      settingSources: ['user', 'project', 'local'],
    });
    expect(first).not.toContain('--resume');
  });

  it('answers can_use_tool with the original native request id', async () => {
    const written: string[] = [];
    const stdout = new Readable({ read() {} });
    const stderr = new Readable({ read() {} });
    const stdin = new Writable({
      write(chunk, _enc, cb) { written.push(String(chunk)); cb(); },
    });
    const child = new EventEmitter() as EventEmitter & {
      stdin: Writable; stdout: Readable; stderr: Readable; killed: boolean; kill: (sig?: string) => boolean;
    };
    child.stdin = stdin;
    child.stdout = stdout;
    child.stderr = stderr;
    child.killed = false;
    child.kill = () => { child.killed = true; stdout.push(null); return true; };

    const port = createClaudeCliQueryPort({
      spawnImpl: (() => child) as never,
    });

    const collected: unknown[] = [];
    const running = (async () => {
      for await (const message of port.query({
        prompt: 'hello',
        options: {
          cwd: '/work',
          pathToClaudeCodeExecutable: '/usr/local/bin/claude',
          settingSources: ['user', 'project', 'local'],
          canUseTool: async () => ({ behavior: 'allow', updatedInput: { command: 'ls' } }),
        },
      })) collected.push(message);
    })();
    await new Promise((resolve) => setImmediate(resolve));
    stdout.push(`${JSON.stringify({
      type: 'control_request',
      request_id: 'rpc-tool-7',
      request: { subtype: 'can_use_tool', tool_name: 'Bash', tool_use_id: 'toolu_1', input: { command: 'ls' } },
    })}\n`);
    stdout.push(`${JSON.stringify({ type: 'result', session_id: 'native-1' })}\n`);
    stdout.push(null);
    await running;
    expect(written.some((line) => line.includes('rpc-tool-7') && line.includes('allow'))).toBe(true);
    expect(JSON.stringify(collected)).toContain('native-1');
    expect(written.join('')).not.toMatch(/claude-agent-sdk-/);
  });

  it('writes image blocks beside text and not inside the text field', async () => {
    const written: string[] = [];
    const stdout = new Readable({ read() {} });
    const stderr = new Readable({ read() {} });
    const stdin = new Writable({
      write(chunk, _enc, cb) { written.push(String(chunk)); cb(); },
    });
    const child = new EventEmitter() as EventEmitter & {
      stdin: Writable; stdout: Readable; stderr: Readable; killed: boolean; kill: (sig?: string) => boolean;
    };
    child.stdin = stdin;
    child.stdout = stdout;
    child.stderr = stderr;
    child.killed = false;
    child.kill = () => { child.killed = true; stdout.push(null); return true; };
    const port = createClaudeCliQueryPort({ spawnImpl: (() => child) as never });
    const running = (async () => {
      for await (const _message of port.query({
        prompt: 'describe',
        images: [{ mimeType: 'image/png', data: 'QUJD' }],
        options: {
          cwd: '/work',
          pathToClaudeCodeExecutable: '/usr/local/bin/claude',
          settingSources: ['user', 'project', 'local'],
        },
      })) { /* drain */ }
    })();
    await new Promise((resolve) => setImmediate(resolve));
    stdout.push(`${JSON.stringify({ type: 'result', session_id: 'native-1' })}\n`);
    stdout.push(null);
    await running;
    const payload = written.join('');
    expect(payload).toContain('"type":"image"');
    expect(payload).toContain('"media_type":"image/png"');
    expect(payload).toContain('"text":"describe"');
    expect(payload).not.toContain('describeQUJD');
    expect(payload).not.toContain('/media/');
  });
});
