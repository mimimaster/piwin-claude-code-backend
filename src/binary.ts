import { existsSync } from 'node:fs';
import { delimiter } from 'node:path';

const SDK_PLATFORM = /claude-agent-sdk-(darwin|linux|win32)/i;

/** Reject SDK-bundled optional binaries. Host/user path only. */
export function isUserOwnedClaudeBinary(path: string): boolean {
  if (path.length === 0 || path.includes('\0')) return false;
  return !SDK_PLATFORM.test(path);
}

export function resolveClaudeBinary(input: {
  hostBinaryPath?: string;
  env?: NodeJS.ProcessEnv;
  pathExists?: (path: string) => boolean;
}): { ok: true; binaryPath: string } | { ok: false; searched: string[] } {
  const exists = input.pathExists ?? existsSync;
  const env = input.env ?? process.env;
  const searched: string[] = [];
  const candidates = [input.hostBinaryPath, env.CLAUDE_CLI, env.CLAUDE_CODE_EXECUTABLE];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate.length === 0) continue;
    searched.push(candidate);
    if (isUserOwnedClaudeBinary(candidate) && exists(candidate)) return { ok: true, binaryPath: candidate };
  }
  const pathEnv = env.PATH ?? env.Path ?? '';
  for (const dir of pathEnv.split(delimiter)) {
    if (dir.length === 0) continue;
    for (const name of ['claude', 'claude.exe']) {
      const candidate = `${dir.replace(/[/\\]$/, '')}/${name}`;
      searched.push(candidate);
      if (isUserOwnedClaudeBinary(candidate) && exists(candidate)) return { ok: true, binaryPath: candidate };
    }
  }
  return { ok: false, searched };
}
