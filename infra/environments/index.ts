import { DEFAULT_AWS_REGION, regionOverride } from '../lib/region.js';
import { dev, devConfig, devSandboxFoundationFor } from './dev.js';
import { prod, prodConfig } from './prod.js';
import { PLACEHOLDER_SANDBOX_RUN, sandbox, sandboxConfig } from './sandbox.js';
import { staging, stagingConfig } from './staging.js';
import {
  ALL_ENVIRONMENT_NAMES,
  ConfigValidationError,
  ENVIRONMENT_NAMES,
  SANDBOX_ENVIRONMENT_NAME,
  parseEnvironmentConfig,
  type EnvironmentConfig,
  type EnvironmentConfigInput,
  type EnvironmentName,
} from './schema.js';

export * from './schema.js';
export { placeholderOriginFacingPrefixListId } from './placeholders.js';
export { PLACEHOLDER_SANDBOX_RUN } from './sandbox.js';
export {
  CLOUDFRONT_ORIGIN_FACING_PREFIX_LIST_IDS,
  PLACEHOLDER_PREFIX_LIST_ID,
  knownCloudFrontOriginFacingPrefixListId,
} from '../lib/region.js';

/** The committed environment configs in the default region. */
export const RAW_ENVIRONMENT_CONFIGS: Readonly<Record<EnvironmentName, EnvironmentConfigInput>> = {
  dev,
  staging,
  prod,
  sandbox,
};

/** The committed environment configs, built for a region (region-specific placeholders follow it). */
export const ENVIRONMENT_CONFIG_BUILDERS: Readonly<
  Record<EnvironmentName, (region?: string) => EnvironmentConfigInput>
> = {
  dev: devConfig,
  staging: stagingConfig,
  prod: prodConfig,
  sandbox: sandboxConfig,
};

export interface ConfigOverrides {
  /** Target account (replaces the placeholder). */
  readonly account?: string;
  /**
   * Deployment region (validated, aws partition). The committed config is built for it, so its
   * placeholders follow; real region-specific values in a config stay and are refused by the
   * schema when they belong to another region.
   */
  readonly region?: string;
  /** `sandbox` swaps in the isolated sandbox foundation (dev only; validated). */
  readonly foundationMode?: 'import' | 'sandbox';
  /** Sandbox only: the ephemeral run identity (replaces the placeholder run). */
  readonly run?: { readonly runId: string; readonly expiresAt: string };
  /** Sandbox only: reserved concurrency of the workflow functions; `null` = unreserved. */
  readonly reservedConcurrency?: number | null;
  /**
   * Sandbox only: id of `com.amazonaws.global.cloudfront.origin-facing` in the account's region,
   * as confirmed by discovery (replaces the committed assumption).
   */
  readonly originPrefixListId?: string;
  /** Sandbox only: the operator's IAM role ARN (replaces the placeholder). */
  readonly operatorPrincipalArn?: string;
  /** Sandbox only: `false` switches master-secret rotation off (transform fallback). */
  readonly masterSecretRotation?: boolean;
}

export function isEnvironmentName(value: string): value is EnvironmentName {
  return (ALL_ENVIRONMENT_NAMES as readonly string[]).includes(value);
}

/**
 * `-c envs`: the governed environments (dev, staging, prod) by default; the opt-in `sandbox` only
 * when named explicitly.
 */
export function selectEnvironments(value: unknown): EnvironmentName[] {
  if (value === undefined || value === '') return [...ENVIRONMENT_NAMES];
  const names = String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const invalid = names.filter((n) => !isEnvironmentName(n));
  if (invalid.length > 0) {
    throw new ConfigValidationError(
      `Unknown environment(s) in -c envs: ${invalid.join(', ')} (expected ${ALL_ENVIRONMENT_NAMES.join(', ')})`,
    );
  }
  return names as EnvironmentName[];
}

/** Loads, overrides and validates one environment's configuration. */
export function loadEnvironmentConfig(
  name: EnvironmentName,
  overrides: ConfigOverrides = {},
): EnvironmentConfig {
  const raw: EnvironmentConfigInput = structuredClone(
    overrides.region === undefined
      ? RAW_ENVIRONMENT_CONFIGS[name]
      : ENVIRONMENT_CONFIG_BUILDERS[name](overrides.region),
  );
  const isSandbox = name === SANDBOX_ENVIRONMENT_NAME;
  if (
    !isSandbox &&
    (overrides.run ||
      overrides.reservedConcurrency !== undefined ||
      overrides.originPrefixListId !== undefined ||
      overrides.operatorPrincipalArn !== undefined ||
      overrides.masterSecretRotation !== undefined)
  ) {
    throw new ConfigValidationError(
      `Run identity, reserved-concurrency, prefix-list, operator and rotation overrides are sandbox-only; not allowed for ${name}`,
    );
  }
  const withOverrides: EnvironmentConfigInput = {
    ...raw,
    ...(overrides.account ? { account: overrides.account } : {}),
    // Even if a config ignores the builder's region argument, the override wins (and the schema
    // then refuses region-specific values of another region).
    ...(overrides.region !== undefined ? { region: overrides.region } : {}),
    // The sandbox environment always creates its own foundation; foundationMode is for dev.
    ...(overrides.foundationMode === 'sandbox' && !isSandbox
      ? {
          foundation: devSandboxFoundationFor(overrides.region ?? raw.region ?? DEFAULT_AWS_REGION),
        }
      : {}),
    ...(overrides.run ? { run: { ...overrides.run } } : {}),
    ...(overrides.operatorPrincipalArn !== undefined
      ? { operatorPrincipalArn: overrides.operatorPrincipalArn }
      : {}),
    ...(overrides.reservedConcurrency !== undefined
      ? { workflow: { ...raw.workflow, reservedConcurrency: overrides.reservedConcurrency } }
      : {}),
  };
  if (overrides.masterSecretRotation !== undefined) {
    withOverrides.database = {
      ...raw.database,
      rotation: { ...raw.database.rotation, enabled: overrides.masterSecretRotation },
    };
  }
  if (overrides.originPrefixListId !== undefined) {
    withOverrides.foundation = {
      ...raw.foundation,
      edge: {
        ...raw.foundation.edge,
        cloudFrontOriginFacingPrefixListId: overrides.originPrefixListId,
      },
    } as EnvironmentConfigInput['foundation'];
  }
  return parseEnvironmentConfig(name, withOverrides);
}

/** True when the sandbox run identity is (partly) the committed placeholder. */
export function hasPlaceholderRun(config: EnvironmentConfig): boolean {
  return (
    config.run?.runId === PLACEHOLDER_SANDBOX_RUN.runId ||
    config.run?.expiresAt === PLACEHOLDER_SANDBOX_RUN.expiresAt
  );
}

/**
 * Resolves overrides with precedence: CDK context > environment variable >
 * committed config. Region: `-c region.<env>` > `-c region` > `STARTER_REGION_<ENV>` > the
 * config's `region` (default DEFAULT_AWS_REGION, `ap-southeast-1`); `AWS_REGION` /
 * `AWS_DEFAULT_REGION` are never read. Context keys: `account.<env>`, `foundationMode` (dev), and for the sandbox
 * only `runId`, `expiresAt`, `operatorPrincipalArn`, `sandbox.reservedConcurrency` (`none` or
 * an integer), `sandbox.originPrefixListId` (`pl-…`) and `sandbox.masterSecretRotation`
 * (`on`|`off`). Environment variables: `STARTER_ACCOUNT_ID_<ENV>`.
 */
export function resolveConfigOverrides(
  name: EnvironmentName,
  tryGetContext: (key: string) => unknown,
  env: NodeJS.ProcessEnv = process.env,
): ConfigOverrides {
  const ctxAccount = tryGetContext(`account.${name}`);
  const envAccount = env[`STARTER_ACCOUNT_ID_${name.toUpperCase()}`];
  const account =
    typeof ctxAccount === 'string' && ctxAccount !== ''
      ? ctxAccount
      : envAccount !== undefined && envAccount !== ''
        ? envAccount
        : undefined;

  const region = regionOverride(tryGetContext, env, name);

  const mode = tryGetContext('foundationMode');
  if (mode !== undefined && mode !== 'import' && mode !== 'sandbox') {
    throw new ConfigValidationError(
      `Invalid context foundationMode=${String(mode)}; expected "import" or "sandbox"`,
    );
  }
  return {
    ...(account ? { account } : {}),
    ...(region !== undefined ? { region } : {}),
    ...(mode ? { foundationMode: mode } : {}),
    ...(name === SANDBOX_ENVIRONMENT_NAME ? sandboxOverrides(tryGetContext) : {}),
  };
}

/** `runId`, `expiresAt` and `sandbox.*` context of the sandbox stage. */
function sandboxOverrides(tryGetContext: (key: string) => unknown): ConfigOverrides {
  const text = (key: string): string | undefined => {
    const v = tryGetContext(key);
    return v === undefined || v === '' ? undefined : String(v);
  };
  const runId = text('runId');
  const expiresAt = text('expiresAt');
  const concurrency = text('sandbox.reservedConcurrency');
  const prefixList = text('sandbox.originPrefixListId');
  const operator = text('operatorPrincipalArn');
  const rotation = text('sandbox.masterSecretRotation');
  if (rotation !== undefined && rotation !== 'on' && rotation !== 'off') {
    throw new ConfigValidationError(
      `Invalid context sandbox.masterSecretRotation=${rotation}; expected "on" or "off"`,
    );
  }
  let reservedConcurrency: number | null | undefined;
  if (concurrency === 'none') {
    reservedConcurrency = null;
  } else if (concurrency !== undefined) {
    if (!/^\d{1,4}$/.test(concurrency)) {
      throw new ConfigValidationError(
        `Invalid context sandbox.reservedConcurrency=${concurrency}; expected "none" or an integer`,
      );
    }
    reservedConcurrency = Number(concurrency);
  }
  return {
    ...(runId !== undefined || expiresAt !== undefined
      ? {
          run: {
            runId: runId ?? PLACEHOLDER_SANDBOX_RUN.runId,
            expiresAt: expiresAt ?? PLACEHOLDER_SANDBOX_RUN.expiresAt,
          },
        }
      : {}),
    ...(reservedConcurrency !== undefined ? { reservedConcurrency } : {}),
    // Formats validated by the schema (pl-<hex>; IAM role ARN in the sandbox account).
    ...(prefixList !== undefined ? { originPrefixListId: prefixList } : {}),
    ...(operator !== undefined ? { operatorPrincipalArn: operator } : {}),
    ...(rotation !== undefined ? { masterSecretRotation: rotation === 'on' } : {}),
  };
}
