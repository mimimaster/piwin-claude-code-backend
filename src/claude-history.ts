import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentEvent } from './types.js';

export type HistoryEmission = { type: 'agent'; event: AgentEvent };

export type ClaudeHistoryResult =
  | { ok: true; events: HistoryEmission[] }
  | { ok: false; reason: string };

const MAX_LINE_CHARS = 256 * 1024;
const MAX_EVENTS = 2_000;
const SKIP_USER_TEXT = new Set(['[Request interrupted by user]']);

/** Claude project dirs replace path separators with `-`, including the leading slash. */
export function encodeClaudeProjectDir(cwd: string): string {
  // macOS `/var` and `/tmp` are often `/private/...`; Claude stores the realpath.
  let resolved = cwd;
  try {
    resolved = realpathSync(cwd);
  } catch {
    // Missing cwd stays encoded as given so fail-closed reconstruction is deterministic.
  }
  return resolved.replace(/\\/g, '/').replace(/\/+$/, '').replace(/\//g, '-');
}

export function claudeSessionJsonlPath(input: { historyRoot: string; cwd: string; sessionId: string }): string {
  return join(input.historyRoot, 'projects', encodeClaudeProjectDir(input.cwd), `${input.sessionId}.jsonl`);
}

export function defaultClaudeHistoryRoot(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (typeof env.CLAUDE_CONFIG_DIR === 'string' && env.CLAUDE_CONFIG_DIR.length > 0) {
    return env.CLAUDE_CONFIG_DIR;
  }
  const home = env.HOME ?? env.USERPROFILE;
  if (typeof home !== 'string' || home.length === 0) return undefined;
  return join(home, '.claude');
}

export function reconstructClaudeHistory(input: {
  historyRoot: string;
  cwd: string;
  sessionId: string;
  readFile?: (path: string) => string | undefined;
}): ClaudeHistoryResult {
  if (input.sessionId.length === 0) return { ok: false, reason: 'native session id required' };
  const path = claudeSessionJsonlPath(input);
  const body = (input.readFile ?? readUtf8)(path);
  if (body === undefined) return { ok: false, reason: 'native history unavailable' };
  const events: HistoryEmission[] = [];
  for (const raw of body.split('\n')) {
    if (events.length >= MAX_EVENTS) break;
    const line = raw.trim();
    if (line.length === 0 || line.length > MAX_LINE_CHARS) continue;
    let record: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue;
      record = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    events.push(...emissionsFromRecord(record, input.sessionId));
  }
  if (events.length === 0) return { ok: false, reason: 'native history unavailable' };
  return { ok: true, events: events.slice(0, MAX_EVENTS) };
}

function readUtf8(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

function emissionsFromRecord(record: Record<string, unknown>, sessionId: string): HistoryEmission[] {
  const type = record.type;
  if (type === 'user') return userEmissions(record);
  if (type === 'assistant') return assistantEmissions(record, sessionId);
  return [];
}

function userEmissions(record: Record<string, unknown>): HistoryEmission[] {
  const message = asRecord(record.message);
  const content = message?.content;
  const toolEnds = toolResultEnds(content);
  const text = visibleText(content);
  const events: HistoryEmission[] = [...toolEnds];
  if (text.length === 0 || SKIP_USER_TEXT.has(text)) return events;
  const messageId = stringId(record.uuid) ?? `cc-user-${hashText(text)}`;
  events.push(...textMessage('user', messageId, text));
  return events;
}

function assistantEmissions(record: Record<string, unknown>, sessionId: string): HistoryEmission[] {
  const message = asRecord(record.message);
  const content = message?.content;
  const text = visibleText(content);
  const tools = toolUses(content);
  if (text.length === 0 && tools.length === 0) return [];
  const messageId = stringId(message?.id) ?? stringId(record.uuid) ?? `cc-${sessionId}-assistant`;
  const events: HistoryEmission[] = [];
  if (text.length > 0) events.push(...textMessage('assistant', messageId, text, stringId(message?.id)));
  for (const tool of tools) {
    events.push({ type: 'agent', event: { type: 'tool/start', toolCallId: tool.id, toolName: tool.name } });
  }
  return events;
}

function textMessage(
  role: 'user' | 'assistant',
  messageId: string,
  text: string,
  backendMessageId?: string,
): HistoryEmission[] {
  return [
    {
      type: 'agent',
      event: {
        type: 'message/start',
        messageId,
        role,
        ...(backendMessageId === undefined ? {} : { backendMessageId }),
      },
    },
    { type: 'agent', event: { type: 'message/text_delta', messageId, delta: text } },
    { type: 'agent', event: { type: 'message/end', messageId } },
  ];
}

function visibleText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    const rec = asRecord(block);
    if (rec?.type === 'text' && typeof rec.text === 'string') parts.push(rec.text);
  }
  return parts.join('').trim();
}

function toolUses(content: unknown): { id: string; name: string }[] {
  if (!Array.isArray(content)) return [];
  const tools: { id: string; name: string }[] = [];
  for (const block of content) {
    const rec = asRecord(block);
    if (rec?.type === 'tool_use' && typeof rec.id === 'string' && typeof rec.name === 'string') {
      tools.push({ id: rec.id, name: rec.name });
    }
  }
  return tools;
}

function toolResultEnds(content: unknown): HistoryEmission[] {
  if (!Array.isArray(content)) return [];
  const events: HistoryEmission[] = [];
  for (const block of content) {
    const rec = asRecord(block);
    if (rec?.type === 'tool_result' && typeof rec.tool_use_id === 'string') {
      events.push({
        type: 'agent',
        event: { type: 'tool/end', toolCallId: rec.tool_use_id, isError: rec.is_error === true },
      });
    }
  }
  return events;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && Array.isArray(value) === false
    ? value as Record<string, unknown>
    : undefined;
}

function stringId(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function hashText(text: string): string {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
}
