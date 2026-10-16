/**
 * Decides whether the real-AWS tests may run, and with which mini-stack outputs.
 *
 * Real-AWS tests are OPT-IN. They run only when
 *   - AWS_INTEGRATION_ENABLED=true, and
 *   - a region is configured, and
 *   - AWS credentials resolve through the default provider chain.
 * Otherwise they are SKIPPED with the reason in the test name (never reported as passed).
 * When AWS_INTEGRATION_REQUIRED=true (set by scripts/run.sh after a deploy), a gate that would
 * skip turns into a hard failure so a misconfigured pipeline cannot go green by skipping.
 */
import { readFile } from 'node:fs/promises';
import { SFNClient } from '@aws-sdk/client-sfn';

export interface IntegrationStackOutputs {
  stateMachineArn: string;
  tableName: string;
  /**
   * TEST-ONLY document table of the mini-stack (ADR 0232): the tests seed synthetic documents
   * there because the mini-stack has no PostgreSQL.
   */
  documentsTableName: string;
  /** The reconciler Lambda (invoked directly by the reconciler tests); optional for older stacks. */
  reconcilerFunctionName?: string | undefined;
}

export type AwsGate =
  | { enabled: true; region: string; outputs: IntegrationStackOutputs; runId: string | null }
  | { enabled: false; required: boolean; reason: string };

/**
 * Extracts outputs from a `cdk deploy --outputs-file` JSON ({ <stack>: { <key>: <value> } }).
 * Key names are matched loosely (…StateMachineArn…, …TestDocumentsTableName…, …TableName…,
 * …ReconcilerFunctionName…) so the test does not depend on CDK logical-id hashing; the more
 * specific patterns are tested first.
 */
export function outputsFromCdkFile(json: unknown): Partial<IntegrationStackOutputs> {
  const found: Partial<IntegrationStackOutputs> = {};
  if (typeof json !== 'object' || json === null) return found;
  for (const stackOutputs of Object.values(json as Record<string, unknown>)) {
    if (typeof stackOutputs !== 'object' || stackOutputs === null) continue;
    for (const [key, value] of Object.entries(stackOutputs as Record<string, unknown>)) {
      if (typeof value !== 'string') continue;
      if (/statemachinearn/i.test(key) && value.startsWith('arn:')) found.stateMachineArn = value;
      else if (/testdocumentstablename/i.test(key)) found.documentsTableName = value;
      else if (/reconcilerfunctionname/i.test(key)) found.reconcilerFunctionName = value;
      else if (/tablename/i.test(key)) found.tableName = value;
    }
  }
  return found;
}

export async function resolveAwsGate(
  env: NodeJS.ProcessEnv,
  deps: {
    readText?: (path: string) => Promise<string>;
    resolveCredentials?: (region: string) => Promise<unknown>;
  } = {},
): Promise<AwsGate> {
  const required = env.AWS_INTEGRATION_REQUIRED === 'true';
  const skip = (reason: string): AwsGate => ({ enabled: false, required, reason });

  if (env.AWS_INTEGRATION_ENABLED !== 'true') {
    return skip('AWS_INTEGRATION_ENABLED is not "true" (real-AWS tests are opt-in)');
  }
  const region = env.AWS_REGION ?? env.AWS_DEFAULT_REGION;
  if (!region) return skip('no AWS_REGION / AWS_DEFAULT_REGION configured');

  const resolveCredentials =
    deps.resolveCredentials ??
    (async (r: string) => {
      const client = new SFNClient({ region: r, maxAttempts: 1 });
      try {
        return await client.config.credentials();
      } finally {
        client.destroy();
      }
    });
  try {
    await resolveCredentials(region);
  } catch (err) {
    const why = err instanceof Error ? err.message.split('\n')[0] : String(err);
    return skip(`no AWS credentials resolved from the default provider chain (${why})`);
  }

  let fileOutputs: Partial<IntegrationStackOutputs> = {};
  const outputsFile = env.AWS_INTEGRATION_OUTPUTS;
  if (outputsFile) {
    const readText = deps.readText ?? ((p: string) => readFile(p, 'utf8'));
    try {
      fileOutputs = outputsFromCdkFile(JSON.parse(await readText(outputsFile)));
    } catch (err) {
      // Enabled + credentials but unreadable outputs is a broken run, not a reason to skip.
      throw new Error(
        `AWS_INTEGRATION_OUTPUTS=${outputsFile} could not be read: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }
  const stateMachineArn = env.STATE_MACHINE_ARN ?? fileOutputs.stateMachineArn;
  const tableName = env.JOBS_TABLE_NAME ?? fileOutputs.tableName;
  const documentsTableName = env.TEST_DOCUMENTS_TABLE_NAME ?? fileOutputs.documentsTableName;
  const reconcilerFunctionName = env.RECONCILER_FUNCTION_NAME ?? fileOutputs.reconcilerFunctionName;
  if (!stateMachineArn || !tableName || !documentsTableName) {
    throw new Error(
      'AWS integration is enabled but the mini-stack outputs are missing: set STATE_MACHINE_ARN, ' +
        'JOBS_TABLE_NAME and TEST_DOCUMENTS_TABLE_NAME, or AWS_INTEGRATION_OUTPUTS=<cdk outputs json> ' +
        '(scripts/deploy.sh writes it).',
    );
  }
  return {
    enabled: true,
    region,
    outputs: {
      stateMachineArn,
      tableName,
      documentsTableName,
      ...(reconcilerFunctionName ? { reconcilerFunctionName } : {}),
    },
    runId: env.AWS_INTEGRATION_RUN_ID ?? null,
  };
}
