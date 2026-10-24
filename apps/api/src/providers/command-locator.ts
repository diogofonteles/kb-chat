import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * Finds a command the way a shell would, without running one (`which` without a shell):
 * a path is checked as is, a bare name in each PATH folder (KBC-007 FR-3).
 */
export async function findExecutable(
  command: string,
  pathEnv: string,
): Promise<string | null> {
  if (isAbsolute(command) || command.includes('/'))
    return (await isExecutable(command)) ? command : null;
  for (const folder of pathEnv.split(delimiter).filter(Boolean)) {
    const candidate = join(folder, command);
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
}
