#!/usr/bin/env node
/** Isolated one-turn smoke: plugin artifact + user-owned claude + mock Anthropic. No Desktop. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const artifact = join(root, 'dist', 'agent.mjs');
const executable = process.env.CLAUDE_CLI ?? '/Volumes/BigDisk/npm-global/bin/claude';
const model = 'claude-haiku-4-5-20251001';
const json = JSON.stringify;
const proof = { ok: false, checks: [], errors: [], nativeId: null, binaryPath: null };

function check(label, cond) {
  assert(cond, label);
  proof.checks.push(label);
}

const tmp = await mkdtemp(join(tmpdir(), 'cc-plugin-smoke-'));
const cwd = join(tmp, 'cwd');
const config = join(tmp, 'config');
await mkdir(cwd); await mkdir(config);

const server = createServer((request, response) => {
  if (request.method === 'GET' || request.method === 'HEAD') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(json({ data: [{ id: model }] }));
    return;
  }
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const write = (type, data) => response.write(`event: ${type}\ndata: ${json({ type, ...data })}\n\n`);
  write('message_start', { message: {
    id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', model,
    content: [], stop_reason: null, usage: { input_tokens: 8, output_tokens: 0 },
  } });
  write('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
  write('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'CC_PLUGIN' } });
  write('content_block_delta', { index: 0, delta: { type: 'text_delta', text: '_SMOKE' } });
  write('content_block_stop', { index: 0 });
  write('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } });
  write('message_stop', {});
  response.end();
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const child = spawn(process.execPath, [artifact], {
  cwd,
  env: {
    PATH: process.env.PATH,
    HOME: tmp,
    TMPDIR: tmpdir(),
    LANG: 'en_US.UTF-8',
    CLAUDE_CONFIG_DIR: config,
    ANTHROPIC_BASE_URL: base,
    ANTHROPIC_API_KEY: 'local-probe-only',
    ANTHROPIC_MODEL: model,
    DISABLE_TELEMETRY: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_DISABLE_AUTOUPDATER: '1',
    NO_PROXY: '*',
    no_proxy: '*',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});
child.stderr.resume();
let buffer = '';
const frames = [];
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (line.trim()) frames.push(JSON.parse(line));
  }
});

function send(frame) {
  child.stdin.write(`${json(frame)}\n`);
}
function waitFor(pred, label, timeout = 25000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const hit = frames.find(pred);
      if (hit) return resolve(hit);
      if (Date.now() - started > timeout) return reject(new Error(`timeout: ${label}`));
      setTimeout(tick, 25);
    };
    tick();
  });
}

try {
  const pluginScope = { kind: 'plugin' };
  const sessionScope = { kind: 'session', sessionId: 'host-smoke', runtimeGenerationId: 'gen-1' };
  send({ protocolVersion: 1, kind: 'request', requestId: 'init', scope: pluginScope, method: 'plugin/initialize',
    params: { agentId: 'claude-code', pluginRevision: 'smoke', hostProtocolVersion: 1,
      runtime: { binaryPath: executable }, hostCapabilities: { nativeCliLaunch: true } } });
  await waitFor((f) => f.requestId === 'init' && f.ok === true, 'initialize');
  send({ protocolVersion: 1, kind: 'request', requestId: 'check', scope: pluginScope, method: 'check', params: { refresh: true } });
  const checked = await waitFor((f) => f.requestId === 'check' && f.ok === true, 'check');
  proof.binaryPath = checked.result.binaryPath;
  check('user binary ready', checked.result.state === 'ready' && typeof checked.result.binaryPath === 'string' && !checked.result.binaryPath.includes('claude-agent-sdk-'));
  send({ protocolVersion: 1, kind: 'request', requestId: 'new', scope: sessionScope, method: 'session/new',
    params: { cwd, binding: { agentId: 'claude-code' } } });
  await waitFor((f) => f.requestId === 'new' && f.ok === true, 'session/new');
  send({ protocolVersion: 1, kind: 'request', requestId: 'prompt', scope: sessionScope, method: 'session/prompt',
    params: { runId: 'run-1', input: { text: 'FIRST_USER_SENTINEL' } } });
  const prompted = await waitFor((f) => f.requestId === 'prompt', 'prompt', 40000);
  check('prompt completed', prompted.ok === true);
  const blob = json(frames);
  check('partial text from native', blob.includes('CC_PLUGIN') && blob.includes('_SMOKE'));
  const started = frames.find((f) => f.kind === 'event' && json(f).includes('session/started'));
  proof.nativeId = started?.emission?.event?.sessionId ?? null;
  check('native session id', typeof proof.nativeId === 'string' && proof.nativeId.length > 0);
  send({ protocolVersion: 1, kind: 'request', requestId: 'cli', scope: sessionScope, method: 'session/cli-launch',
    params: { cwd, binding: { agentId: 'claude-code', backendSessionId: proof.nativeId } } });
  const launch = await waitFor((f) => f.requestId === 'cli' && f.ok === true, 'cli-launch');
  check('cli-launch exact native id', launch.result.backendSessionId === proof.nativeId && launch.result.args.includes(proof.nativeId));
  check('no executable override', !Object.hasOwn(launch.result, 'executable') && !Object.hasOwn(launch.result, 'env'));
  proof.ok = true;
} catch (error) {
  proof.errors.push(error instanceof Error ? error.message : String(error));
} finally {
  child.kill('SIGTERM');
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(tmp, { recursive: true, force: true });
  console.log(json(proof));
  process.exitCode = proof.ok ? 0 : 1;
}
