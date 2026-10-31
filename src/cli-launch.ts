export function claudeCliLaunch(input: { backendSessionId: string; cwd: string }): { backendSessionId: string; args: string[] } {
  if (input.backendSessionId.length === 0) throw new Error('native-session-required');
  return {
    backendSessionId: input.backendSessionId,
    args: ['--resume', input.backendSessionId],
  };
}
