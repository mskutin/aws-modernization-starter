/**
 * CDK app: one `WorkloadStage` per environment (Dev, Staging, Prod; opt-in Sandbox).
 *
 * Context (all optional, offline-safe):
 *   -c envs=dev,staging,prod        environments to synthesize (default: dev,staging,prod);
 *                                   `sandbox` (live validation in an ordinary account) only when named
 *   -c apiImageDigest=sha256:...    API image digest (or API_IMAGE_DIGEST)
 *   -c requireImageDigest=true      fail if no real digest is supplied (deploy jobs)
 *   -c account.<env>=123456789012   target account (or STARTER_ACCOUNT_ID_<ENV>)
 *   -c region=<region>              deployment region of every selected stage; -c region.<env>=<region>
 *                                   for one stage (or STARTER_REGION_<ENV>). Precedence:
 *                                   region.<env> > region > STARTER_REGION_<ENV> > the config's
 *                                   region > ap-southeast-1 (DEFAULT_AWS_REGION). AWS_REGION is
 *                                   never read. aws partition only; region-specific values
 *                                   (AZs, KMS, ACM, prefix list) must belong to the region
 *   -c foundationMode=sandbox       dev only: create a sandbox VPC/KMS instead of importing
 *   -c lambdaHandlers=fixtures      bundle test fixtures instead of functions/<name>/src
 *   -c appVersion=<git-sha>         APP_VERSION log field for the API, migrations and Lambdas
 *
 * Sandbox only (placeholders offline; real values required with requireDeployInputs):
 *   -c runId=sbx-<6 hex>            ephemeral run id (starter:run-id)
 *   -c expiresAt=<ISO-8601 UTC>     sweeper expiry (starter:expires-at), at most 72 h ahead
 *   -c originVerifySecretFile=<path>  per-run X-Origin-Verify value from a 0600 file (preferred)
 *   -c originVerifySecret=<token>   ... or inline (32-128 [A-Za-z0-9_-]; visible in argv)
 *   -c sandbox.reservedConcurrency=none|<n>  workflow Lambda reservation (none = unreserved)
 *   -c sandbox.originPrefixListId=pl-…  CloudFront origin-facing prefix list (from discovery)
 *   -c operatorPrincipalArn=<role ARN>   operator role named in the data CMK key policy (via
 *                                   DynamoDB and Step Functions only) and the logs CMK key
 *                                   policy (decrypt via CloudWatch Logs only)
 *   -c sandbox.masterSecretRotation=off  fallback if the hosted-rotation transform cannot deploy
 *   -c requireDeployInputs=true     deploy guard: implies requireImageDigest and refuses every
 *                                   sandbox placeholder (never pass it to `cdk destroy`)
 */
import { applyBaselinePolicies } from '@starter/policies';
import { App } from 'aws-cdk-lib';
import {
  SANDBOX_ENVIRONMENT_NAME,
  loadEnvironmentConfig,
  resolveConfigOverrides,
  selectEnvironments,
  type EnvironmentConfig,
} from '../environments/index.js';
import { resolveAppVersion, resolveImageDigest } from '../lib/image.js';
import { resolveHandlerEntries } from '../lib/lambda-entries.js';
import { applyPolicyChecks } from '../lib/policy-hook.js';
import { baselinePolicyOptions } from '../lib/policy-options.js';
import {
  PLACEHOLDER_ORIGIN_VERIFY_SECRET,
  assertSandboxDeployable,
  isDeployRequested,
  resolveOriginVerifySecret,
} from '../lib/sandbox-inputs.js';
import { WorkloadStage, STAGE_IDS } from '../stages/workload-stage.js';

function main(): void {
  const app = new App();
  const ctx = (key: string): unknown => app.node.tryGetContext(key);

  const image = resolveImageDigest(ctx);
  const handlerEntries = resolveHandlerEntries(ctx('lambdaHandlers'));
  const appVersion = resolveAppVersion(ctx);
  const deploy = isDeployRequested(ctx);
  const configs: EnvironmentConfig[] = [];
  let originVerifySecret: string | undefined;
  for (const name of selectEnvironments(ctx('envs'))) {
    const config = loadEnvironmentConfig(name, resolveConfigOverrides(name, ctx));
    configs.push(config);
    if (config.api.originMode === 'public-alb-http') {
      originVerifySecret ??= resolveOriginVerifySecret(ctx);
    }
    if (deploy && name === SANDBOX_ENVIRONMENT_NAME) {
      assertSandboxDeployable(config, {
        originVerifySecret: originVerifySecret ?? PLACEHOLDER_ORIGIN_VERIFY_SECRET,
        imageDigestIsPlaceholder: image.isPlaceholder,
      });
    }
    new WorkloadStage(app, STAGE_IDS[name], {
      config,
      imageDigest: image.digest,
      handlerEntries,
      appVersion,
      ...(config.api.originMode === 'public-alb-http' ? { originVerifySecret } : {}),
    });
  }

  // Policy hook: AwsSolutions + the proposed baseline (@starter/policies). Must run after
  // every stage exists: governed exceptions (policies/exceptions/exceptions.yaml) become
  // targeted acknowledgements on the resources present now; later resources get none.
  applyPolicyChecks(app, {
    // BASE-IAM-004 resolves per stage against that stage's exact configured permissions boundary
    // (lib/policy-options.ts `permissionsBoundaryFor`); a boundary-less sandbox stage does not
    // disable the check for the other stages (ADR 0511).
    additionalPacks: [(scope) => applyBaselinePolicies(scope, baselinePolicyOptions(configs)).pack],
  });

  if (image.isPlaceholder) {
    console.warn(
      '[starter-infra] No apiImageDigest supplied: using the all-zero placeholder digest (synth/validation only, not deployable).',
    );
  }
  if (originVerifySecret === PLACEHOLDER_ORIGIN_VERIFY_SECRET) {
    console.warn(
      '[starter-infra] No originVerifySecret supplied: the sandbox uses a placeholder (synth/validation only, not deployable).',
    );
  }
  app.synth();
}

try {
  main();
} catch (err) {
  // Configuration/input errors: print a clear message instead of a stack trace.
  if (err instanceof Error && !process.env.STARTER_INFRA_DEBUG) {
    console.error(`[starter-infra] ${err.message}`);
    process.exit(1);
  }
  throw err;
}
