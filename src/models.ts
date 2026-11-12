/**
 * Static model catalog for drafts and freshly opened sessions.
 *
 * The native `system/init` frame only arrives after the first prompt, so the
 * Host needs a catalog before any `claude` process exists. These are the
 * CLI's own `--model` aliases; the native CLI resolves them to concrete ids.
 */
export type ClaudeModelOption = { id: string; label: string; contextTokens?: number };

export const DEFAULT_CLAUDE_CONTEXT_TOKENS = 200_000;

export function inferClaudeContextTokens(modelId: string): number {
  return /\b1m\b|\[1m\]|-1m\b/i.test(modelId) ? 1_000_000 : DEFAULT_CLAUDE_CONTEXT_TOKENS;
}

export const CLAUDE_MODEL_ALIASES: readonly ClaudeModelOption[] = [
  { id: 'haiku', label: 'Haiku', contextTokens: DEFAULT_CLAUDE_CONTEXT_TOKENS },
  { id: 'sonnet', label: 'Sonnet', contextTokens: DEFAULT_CLAUDE_CONTEXT_TOKENS },
  { id: 'opus', label: 'Opus', contextTokens: DEFAULT_CLAUDE_CONTEXT_TOKENS },
];

/** Cheapest alias first: a new session should not spend premium quota by default. */
export const DEFAULT_CLAUDE_MODEL_ID = 'haiku';

/** Native init models win when present; otherwise keep the alias catalog. */
export function resolveModelCatalog(native: readonly ClaudeModelOption[]): ClaudeModelOption[] {
  return native.length > 0 ? [...native] : [...CLAUDE_MODEL_ALIASES];
}

export function isKnownModel(models: readonly ClaudeModelOption[], modelId: string): boolean {
  return models.some((model) => model.id === modelId);
}
