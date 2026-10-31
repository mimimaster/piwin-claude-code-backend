import { AGENT_ID } from './types.js';

const yes = { supported: true as const };
const no = (reason: string) => ({ supported: false as const, reason });

export function claudeCapabilities() {
  return {
    agentId: AGENT_ID,
    nativeCli: yes,
    operations: {
      prompt: yes,
      cancel: yes,
      queue: no('Claude Code does not expose Host queue'),
      intervene: yes,
      setModel: yes,
      setEffort: no('Claude Code has no Host effort control'),
      setMode: no('Claude permission modes are not a Host control yet'),
      slashCommands: yes,
      fileReferences: no('File chips are not a Host Claude operation'),
      images: yes,
      rename: no('Claude catalog rename is not implemented'),
      delete: no('Claude catalog delete is not implemented'),
      archive: no('Claude Code sessions are not Host-archived'),
      pin: no('Claude Code sessions are not Host-pinned'),
      export: no('Export stays in native Claude history'),
      fork: no('Claude Code fork is not a Host operation'),
      rewind: no('Claude Code rewind is not a Host operation'),
      duplicate: no('Claude Code duplicate is not a Host operation'),
      pause: no('Claude Code has no pause'),
      compact: no('Compaction is native-owned'),
      conversationTree: no('Claude Code has no Host conversation tree'),
      coldStorage: no('Claude Code has no Host cold storage'),
      hostSubagents: no('Host subagents are Pi-only'),
      hostTools: no('Host tools are not injected into Claude Code'),
    },
  };
}

export function claudeOptions(input: {
  models?: readonly { id: string; label: string }[];
  commands?: readonly { name: string; description?: string }[];
  currentModelId?: string;
  currentModeId?: string;
}) {
  return {
    agentId: AGENT_ID,
    models: input.models ?? [],
    ...(input.currentModelId === undefined ? {} : { currentModelId: input.currentModelId }),
    modes: [
      { id: 'default', label: 'Default' },
      { id: 'plan', label: 'Plan' },
      { id: 'acceptEdits', label: 'Accept edits' },
    ],
    currentModeId: input.currentModeId ?? 'default',
    modeConfirmed: true,
    commands: (input.commands ?? []).map((command) => ({
      name: command.name,
      ...(command.description === undefined ? {} : { description: command.description }),
    })),
  };
}

export const DEFAULT_PERMISSION_OPTIONS = [
  { optionId: 'allow_once', label: 'Allow once', kind: 'allow_once' as const },
  { optionId: 'allow_always', label: 'Allow always', kind: 'allow_always' as const },
  { optionId: 'reject_once', label: 'Reject once', kind: 'reject_once' as const },
  { optionId: 'reject_always', label: 'Reject always', kind: 'reject_always' as const },
];
