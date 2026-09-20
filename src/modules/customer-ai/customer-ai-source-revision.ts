import { execFileSync } from 'node:child_process';

const SOURCE_REVISION = /^[a-f0-9]{40,64}$/i;

/**
 * Resolves the exact source revision exercised by a local or CI command.
 * Promotion evidence cannot represent a dirty tree, while non-recorded smoke
 * artifacts may identify HEAD and separately disclose that it was dirty.
 */
export function resolveCustomerAiSourceRevision(input: {
  requireClean: boolean;
  environment?: NodeJS.ProcessEnv;
  workingDirectory?: string;
}): { revision: string; dirty: boolean } {
  const environment = input.environment ?? process.env;
  const workingDirectory = input.workingDirectory ?? process.cwd();
  const ciRevision = environment.GIT_COMMIT_SHA?.trim();
  if (ciRevision) {
    if (!SOURCE_REVISION.test(ciRevision)) {
      throw new Error('GIT_COMMIT_SHA is not an exact source revision');
    }

    return { revision: ciRevision.toLowerCase(), dirty: false };
  }
  if (environment.CI === 'true') {
    throw new Error('GIT_COMMIT_SHA is required for CI evaluation evidence');
  }

  const worktree = execFileSync(
    'git',
    ['status', '--porcelain', '--untracked-files=normal'],
    { cwd: workingDirectory, encoding: 'utf8' },
  ).trim();
  const dirty = worktree.length > 0;
  if (input.requireClean && dirty) {
    throw new Error(
      'Customer AI promotion evidence requires a clean source tree',
    );
  }
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: workingDirectory,
    encoding: 'utf8',
  }).trim();
  if (!SOURCE_REVISION.test(revision)) {
    throw new Error('Git HEAD is not an exact source revision');
  }

  return { revision: revision.toLowerCase(), dirty };
}

export function isExactCustomerAiSourceRevision(value: string): boolean {
  return SOURCE_REVISION.test(value);
}
