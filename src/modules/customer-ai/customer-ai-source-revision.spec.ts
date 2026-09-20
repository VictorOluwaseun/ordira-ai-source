import { execFileSync } from 'node:child_process';
import {
  isExactCustomerAiSourceRevision,
  resolveCustomerAiSourceRevision,
} from './customer-ai-source-revision';

jest.mock('node:child_process', () => ({ execFileSync: jest.fn() }));

const REVISION = 'a'.repeat(40);
const mockedExecFileSync = jest.mocked(execFileSync);

describe('customer AI source revision', () => {
  beforeEach(() => {
    mockedExecFileSync.mockReset();
  });

  it('uses exact immutable CI provenance without consulting a worktree', () => {
    expect(
      resolveCustomerAiSourceRevision({
        requireClean: true,
        environment: { CI: 'true', GIT_COMMIT_SHA: REVISION.toUpperCase() },
      }),
    ).toEqual({ revision: REVISION, dirty: false });
    expect(mockedExecFileSync).not.toHaveBeenCalled();
  });

  it('refuses CI evidence without an exact source revision', () => {
    expect(() =>
      resolveCustomerAiSourceRevision({
        requireClean: true,
        environment: { CI: 'true' },
      }),
    ).toThrow('GIT_COMMIT_SHA is required for CI evaluation evidence');
  });

  it('refuses recorded local evidence from a dirty worktree', () => {
    mockedExecFileSync.mockReturnValueOnce(' M src/file.ts');

    expect(() =>
      resolveCustomerAiSourceRevision({
        requireClean: true,
        environment: {},
        workingDirectory: '/workspace',
      }),
    ).toThrow('requires a clean source tree');
  });

  it('labels non-recorded local smoke evidence as dirty', () => {
    mockedExecFileSync
      .mockReturnValueOnce('?? local-artifact.json')
      .mockReturnValueOnce(`${REVISION}\n`);

    expect(
      resolveCustomerAiSourceRevision({
        requireClean: false,
        environment: {},
        workingDirectory: '/workspace',
      }),
    ).toEqual({ revision: REVISION, dirty: true });
  });

  it('accepts only full source revisions', () => {
    expect(isExactCustomerAiSourceRevision(REVISION)).toBe(true);
    expect(isExactCustomerAiSourceRevision('371761c')).toBe(false);
  });
});
