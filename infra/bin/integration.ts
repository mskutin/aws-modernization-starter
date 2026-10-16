/**
 * CDK app for the EPHEMERAL integration mini-stack (AWS integration tests).
 *
 * Required context:
 *   -c runId=<3-24 chars [a-z0-9-]>   unique per pipeline run (stack starter-it-<runId>)
 * Required whenever the CDK CLI resolved AWS credentials (deploy, destroy, any synth with them):
 *   -c account=<12 digits>            pinned into the stack environment and compared with the
 *                                     credentials' account (CDK_DEFAULT_ACCOUNT); synth refuses
 *                                     a missing or different account. Offline synth
 *                                     without credentials may omit it: the template is then
 *                                     environment-agnostic and carries a CloudFormation rule
 *                                     that refuses any deployment of it.
 *   -c operatorPrincipalArn=<arn>     IAM ROLE ARN incl. path of the operator running the tests
 *                                     (same account). Named in the CMK key policy and the
 *                                     KeyProbeRole trust. Offline: a non-deployable placeholder.
 * Optional context:
 *   -c ttlHours=<1..72> | -c expiresAt=<ISO-8601>   sweeper expiry (default 6h)
 *   -c region=<region>                               default ap-southeast-1 (DEFAULT_AWS_REGION of
 *                                                    @starter/config/region); any region of the aws
 *                                                    partition, others are refused. Emulator:
 *                                                    EMULATOR_REGION only
 *   -c qualifier=<bootstrap qualifier>               default starter: the sandbox stage's
 *                                                    bootstrap (toolkit stack starter-cdk-toolkit)
 *   -c permissionsBoundaryArn=<arn>                  boundary for created roles
 *   -c executionTimeoutSeconds=<30..600|spec>        default 45 (execution-timeout test)
 *   -c experiment=<id>                               starter:experiment tag (default live-validation)
 *   -c owner=<o> -c costCentre=<c> -c dataClassification=<d>
 *                                                    tag overrides (default: sandbox values)
 *   -c target=emulator                               MiniStack emulator variant (no state machine
 *                                                    version/alias); requires -c account=000000000001
 *                                                    and an environment the shared emulator guard
 *                                                    accepts (infra/lib/emulator-guard.ts: loopback
 *                                                    or allowlisted CI-service endpoint, fake keys)
 *   -c lambdaHandlers=fixtures                       bundle infra test fixtures
 *   -c appVersion=<git-sha>                          APP_VERSION for the Lambdas
 */
import { applyBaselinePolicies } from '@starter/policies';
import { App } from 'aws-cdk-lib';
import { resolveAppVersion } from '../lib/image.js';
import { resolveHandlerEntries } from '../lib/lambda-entries.js';
import { assertEmulatorAccount, resolveDeployTarget } from '../lib/emulator-guard.js';
import { applyPolicyChecks } from '../lib/policy-hook.js';
import {
  IntegrationWorkflowStack,
  assertEmulatorRegion,
  integrationRequiredTags,
  resolveExecutionTimeout,
  resolveExpiresAt,
  resolveIntegrationAccount,
  resolveOperatorPrincipalArn,
  validateRegion,
  validateRunId,
} from '../stacks/integration-workflow-stack.js';

function main(): void {
  const app = new App();
  const ctx = (key: string): unknown => app.node.tryGetContext(key);
  const str = (key: string): string | undefined => {
    const v = ctx(key);
    return typeof v === 'string' && v !== '' ? v : undefined;
  };

  const runId = validateRunId(ctx('runId'));
  const boundary = str('permissionsBoundaryArn');
  const account = resolveIntegrationAccount({
    contextAccount: str('account'),
    cdkDefaultAccount: process.env.CDK_DEFAULT_ACCOUNT,
  });
  const region = validateRegion(str('region'));
  const target = resolveDeployTarget(str('target'), process.env);
  if (target === 'emulator') {
    assertEmulatorAccount(account);
    assertEmulatorRegion(region);
  }
  const operatorPrincipalArn = resolveOperatorPrincipalArn({
    contextValue: str('operatorPrincipalArn'),
    account,
    cdkDefaultAccount: process.env.CDK_DEFAULT_ACCOUNT,
  });

  new IntegrationWorkflowStack(app, 'IntegrationWorkflowStack', {
    env: { account, region },
    runId,
    expiresAt: resolveExpiresAt(ctx),
    // Integration entries: documents from the mini-stack's TEST-ONLY table (ADR 0232).
    handlerEntries: resolveHandlerEntries(ctx('lambdaHandlers'), 'integration'),
    permissionsBoundaryArn: boundary,
    qualifier: str('qualifier'),
    appVersion: resolveAppVersion(ctx),
    executionTimeoutSeconds: resolveExecutionTimeout(ctx('executionTimeoutSeconds')),
    experiment: str('experiment'),
    operatorPrincipalArn,
    emulator: target === 'emulator',
    requiredTags: integrationRequiredTags({
      owner: str('owner'),
      costCentre: str('costCentre'),
      dataClassification: str('dataClassification'),
    }),
  });

  // Same policy gate as the environment app: AwsSolutions + the proposed baseline.
  applyPolicyChecks(app, {
    additionalPacks: [
      (scope) =>
        applyBaselinePolicies(scope, {
          register: false,
          // BASE-IAM-004 is enforced only when a boundary is supplied for the run.
          ...(boundary ? { permissionsBoundaryArn: boundary } : {}),
        }).pack,
    ],
  });
  app.synth();
}

try {
  main();
} catch (err) {
  console.error(`[starter-infra:integration] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
