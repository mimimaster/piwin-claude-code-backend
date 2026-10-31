/**
 * Host prompt outcome (protocol v1 `AgentPromptOutcome` shape).
 *
 * The Host rejects anything but completed/failed/aborted, so a native error
 * result must become a structured failure rather than a successful turn.
 */
export type PromptOutcome =
  | { status: 'completed'; stopReason: 'stop' }
  | { status: 'aborted'; stopReason: 'aborted' }
  | {
      status: 'failed';
      stopReason: 'error';
      failure: { code: string; origin: 'provider' | 'runtime'; message: string; retriable: boolean };
    };

const FAILURE_MESSAGE_MAX_CHARS = 500;
const AUTH_FAILURE = /authenticat|oauth|\blog ?in\b|api key/i;

export type NativeResult = { isError: boolean; text?: string };

export function resolvePromptOutcome(input: { cancelled: boolean; result?: NativeResult }): PromptOutcome {
  if (input.cancelled) return { status: 'aborted', stopReason: 'aborted' };
  if (input.result === undefined) {
    return failed('runtime', 'backend-worker-crash', 'claude exited without a result', true);
  }
  if (!input.result.isError) return { status: 'completed', stopReason: 'stop' };
  const text = input.result.text ?? 'Claude Code reported an error';
  // Prose only picks the code; the native text stays display detail.
  return AUTH_FAILURE.test(text)
    ? failed('provider', 'provider-authentication', text, false)
    : failed('provider', 'unknown-agent-failure', text, false);
}

function failed(origin: 'provider' | 'runtime', code: string, message: string, retriable: boolean): PromptOutcome {
  return {
    status: 'failed',
    stopReason: 'error',
    failure: { code, origin, message: message.slice(0, FAILURE_MESSAGE_MAX_CHARS), retriable },
  };
}
