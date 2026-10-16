/**
 * A guarded, read-only AWS session: every call first ensures a fresh account-guard verification
 * (GuardSession), then runs one allowlisted AWS CLI operation. A credentials error (expired SSO
 * session) aborts the run: nothing after it could be trusted to be complete.
 */
import type { AwsCallResult, AwsCli } from './executor.js';
import type { GuardRecord, GuardSession } from './guard.js';

export interface ReadOnlyAws {
  call(service: string, operation: string, args?: readonly string[]): Promise<AwsCallResult>;
}

export class CredentialsError extends Error {
  override name = 'CredentialsError';
}

export class GuardedSession implements ReadOnlyAws {
  constructor(
    private readonly cli: AwsCli,
    private readonly guard: GuardSession,
    private readonly label: string,
  ) {}

  get guardChecks(): readonly GuardRecord[] {
    return this.guard.checks;
  }

  get records() {
    return this.cli.records;
  }

  async call(service: string, operation: string, args: readonly string[] = []) {
    await this.guard.ensure(this.label);
    const result = await this.cli.call(service, operation, args);
    if (!result.ok && result.error.kind === 'credentials') {
      throw new CredentialsError(`${service} ${operation}: ${result.error.message}`);
    }
    return result;
  }
}
