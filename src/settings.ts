/** Coding preset uses native Claude sources. Empty is explicit-test only. */
export const CLAUDE_CODING_SETTING_SOURCES = ['user', 'project', 'local'] as const;

export type ClaudeSettingsPreset = 'coding' | 'empty';

export function resolveSettingSources(preset: ClaudeSettingsPreset): readonly string[] {
  return preset === 'empty' ? [] : CLAUDE_CODING_SETTING_SOURCES;
}

export function isSilentEmptySettings(preset: ClaudeSettingsPreset, sources: readonly string[]): boolean {
  return preset === 'coding' && sources.length === 0;
}
