/**
 * Resource reconciliation of the integration stack deployed to the MiniStack EMULATOR
 * (`tests/aws-integration/emulator/ci.sh cdk`). NOT AWS evidence.
 *
 * `CREATE_COMPLETE` alone proves nothing: every resource of the synthesized template must have a
 * physical id in `DescribeStackResources` AND a service read-back that matches the template after
 * token resolution (Ref / Fn::GetAtt / Fn::Join / Fn::Sub / Fn::Select / Fn::Split resolved from the
 * read-back values themselves):
 *
 *  - DynamoDB tables: name, key schema, attribute definitions, billing mode, GSIs, deletion
 *    protection, TTL, PITR, SSE;
 *  - Lambda functions: runtime, architectures, handler, timeout, memory, role, environment
 *    (keys AND values), tracing, log group; versions exist; alias → version; event invoke config;
 *  - the state machine: definition equal to the synthesized ASL (JSON-equal after token
 *    resolution) including `TimeoutSeconds`, role, type, logging, tracing, encryption;
 *  - log groups: name, retention, KMS key; IAM roles (trust policy, description, session
 *    duration) and inline policies (document); the KMS key (state, spec, rotation, key policy);
 *  - tags of every taggable resource (CloudFormation's own `aws:` tags ignored).
 *
 * Honesty rules (see CheckStatus): every property is compared BEFORE it is classified. A value
 * MiniStack stores without effect is `compared-not-enforced` when equal and a mismatch when not;
 * a property MiniStack does not store is `unsupported` only while the read-back is absent or a
 * default. Template properties no comparer covers must be listed in UNCOMPARED_PROPERTIES with a
 * reason, otherwise they are `unknown` and fail. A resource is `reconciled` only with no
 * mismatch, no unknown property, nothing unsupported or not enforced; IAM / KMS resources are
 * `unsupported` (semantics not enforced). A function must be `Active` with LastUpdateStatus
 * `Successful` after the bounded settle-wait. A physical id of MiniStack's no-op placeholder
 * (`…-noop-…`) fails the run. Any other mismatch, missing resource or failed read fails the run.
 */
import {
  CloudFormationClient,
  DescribeStackResourcesCommand,
  DescribeStacksCommand,
} from '@aws-sdk/client-cloudformation';
import {
  CloudWatchLogsClient,
  DescribeLogGroupsCommand,
  ListTagsForResourceCommand as ListLogTagsCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import {
  DescribeContinuousBackupsCommand,
  DescribeTableCommand,
  DescribeTimeToLiveCommand,
  DynamoDBClient,
  ListTagsOfResourceCommand,
} from '@aws-sdk/client-dynamodb';
import {
  GetRoleCommand,
  GetRolePolicyCommand,
  IAMClient,
  ListRoleTagsCommand,
} from '@aws-sdk/client-iam';
import {
  DescribeKeyCommand,
  GetKeyPolicyCommand,
  GetKeyRotationStatusCommand,
  KMSClient,
  ListResourceTagsCommand,
} from '@aws-sdk/client-kms';
import {
  GetAliasCommand,
  GetFunctionConfigurationCommand,
  GetFunctionEventInvokeConfigCommand,
  LambdaClient,
  ListTagsCommand,
  ListVersionsByFunctionCommand,
} from '@aws-sdk/client-lambda';
import {
  DescribeStateMachineCommand,
  ListTagsForResourceCommand as ListSfnTagsCommand,
  SFNClient,
} from '@aws-sdk/client-sfn';

// ---------------------------------------------------------------------------------------------
// Template model and token resolution (pure)
// ---------------------------------------------------------------------------------------------

export interface TemplateResource {
  Type: string;
  Properties?: Record<string, unknown>;
}
export interface Template {
  Resources: Record<string, TemplateResource>;
}

export interface ResolutionContext {
  /** `Ref` of each logical id (the physical id, as on AWS for every type used here). */
  refs: Record<string, string>;
  /** `Fn::GetAtt` values, keyed `<logicalId>.<attribute>`, taken from the service read-backs. */
  attrs: Record<string, string>;
  /** Pseudo parameters (`AWS::Region`, `AWS::AccountId`, `AWS::Partition`, …). */
  pseudo: Record<string, string>;
}

export class UnresolvableTokenError extends Error {
  override name = 'UnresolvableTokenError';
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function lookupRef(name: string, ctx: ResolutionContext): string {
  const value = ctx.pseudo[name] ?? ctx.refs[name];
  if (value === undefined) throw new UnresolvableTokenError(`Ref ${name} has no value`);
  return value;
}

function lookupAttr(logicalId: string, attribute: string, ctx: ResolutionContext): string {
  const value = ctx.attrs[`${logicalId}.${attribute}`];
  if (value === undefined) {
    throw new UnresolvableTokenError(`Fn::GetAtt ${logicalId}.${attribute} has no read-back value`);
  }
  return value;
}

/** Resolves the CloudFormation intrinsics the template uses; anything else is an error. */
export function resolveTokens(value: unknown, ctx: ResolutionContext): unknown {
  if (Array.isArray(value)) return value.map((v) => resolveTokens(v, ctx));
  if (!isObject(value)) return value;
  const keys = Object.keys(value);
  if (keys.length === 1) {
    const [fn] = keys as [string];
    const arg = value[fn];
    switch (fn) {
      case 'Ref':
        return lookupRef(String(arg), ctx);
      case 'Fn::GetAtt': {
        const [id, attr] = Array.isArray(arg) ? arg.map(String) : String(arg).split(/\.(.*)/s);
        return lookupAttr(String(id), String(attr), ctx);
      }
      case 'Fn::Join': {
        const [sep, parts] = arg as [string, unknown[]];
        return (resolveTokens(parts, ctx) as unknown[]).map(String).join(sep);
      }
      case 'Fn::Select': {
        const [index, list] = arg as [unknown, unknown];
        const resolved = resolveTokens(list, ctx) as unknown[];
        const item = resolved[Number(resolveTokens(index, ctx))];
        if (item === undefined) throw new UnresolvableTokenError('Fn::Select index out of range');
        return item;
      }
      case 'Fn::Split': {
        const [sep, source] = arg as [string, unknown];
        return String(resolveTokens(source, ctx)).split(sep);
      }
      case 'Fn::Sub': {
        const [text, vars] = Array.isArray(arg)
          ? (arg as [string, Record<string, unknown>])
          : [String(arg), {}];
        return text.replace(/\$\{([^}!]+)\}/g, (_m, name: string) => {
          if (name in vars) return String(resolveTokens(vars[name], ctx));
          const [id, attr] = name.split(/\.(.*)/s);
          return attr ? lookupAttr(String(id), attr, ctx) : lookupRef(name, ctx);
        });
      }
      default:
        if (fn.startsWith('Fn::') || fn === 'Condition') {
          throw new UnresolvableTokenError(`intrinsic ${fn} is not supported by the reconciler`);
        }
    }
  }
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveTokens(v, ctx)]));
}

/** IAM action/resource lists: a single string and a one-element list mean the same. */
const IAM_LIST_KEYS = new Set(['Action', 'NotAction', 'Resource', 'NotResource']);

/** Canonical JSON: sorted object keys; IAM lists normalised and sorted. */
export function canonical(value: unknown, key?: string): unknown {
  if (Array.isArray(value)) {
    const items = value.map((v) => canonical(v));
    return key !== undefined && IAM_LIST_KEYS.has(key)
      ? [...items].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
      : items;
  }
  if (isObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => {
          const v = value[k];
          return [k, canonical(IAM_LIST_KEYS.has(k) && typeof v === 'string' ? [v] : v, k)];
        }),
    );
  }
  return value;
}

export const sameJson = (a: unknown, b: unknown): boolean =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

/** Parses a policy document returned as JSON text, possibly URL-encoded (IAM). */
export function parsePolicyDocument(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  const raw = text.trimStart().startsWith('{') ? text : decodeURIComponent(text);
  return JSON.parse(raw) as unknown;
}

// ---------------------------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------------------------

/**
 * Every template property ends in exactly one category:
 *  - `match` / `mismatch`: compared with the read-back (a mismatch fails the run);
 *  - `compared-not-enforced`: MiniStack stores and returns the value and it EQUALS the template,
 *    but the emulator does not provide its effect (no encryption, no tracing): never a semantic
 *    verification. A different value is a `mismatch`;
 *  - `unsupported`: MiniStack does not store or return the value: the read-back is absent or a
 *    default (what was read is recorded). A non-default read-back that differs is a `mismatch`;
 *  - `uncompared`: listed in UNCOMPARED_PROPERTIES with the reason it cannot be read back;
 *  - `unknown`: a template property no comparer and no list covers: FAILS the run, so a new
 *    template property can never pass silently.
 */
export type CheckStatus =
  'match' | 'mismatch' | 'compared-not-enforced' | 'unsupported' | 'uncompared' | 'unknown';

export const CHECK_STATUSES: readonly CheckStatus[] = [
  'match',
  'mismatch',
  'compared-not-enforced',
  'unsupported',
  'uncompared',
  'unknown',
];

export interface PropertyCheck {
  property: string;
  status: CheckStatus;
  expected?: unknown;
  actual?: unknown;
  /** Why the property is not enforced, unsupported or uncompared on the emulator. */
  reason?: string;
}

/**
 * `reconciled`: every property compared equal (or uncompared with a listed reason) and every
 * effect is provided by the emulator. `compared-not-enforced`: compared equal, but at least one
 * property has no effect on the emulator. `unsupported`: a property is not stored, or the type's
 * semantics are not enforced (IAM, KMS). `failed`: a mismatch, an unknown property, a missing
 * resource or a failed read.
 */
export type ResourceStatus =
  'reconciled' | 'compared-not-enforced' | 'unsupported' | 'metadata-only' | 'failed';

export interface ResourceResult {
  logicalId: string;
  type: string;
  physicalId?: string;
  stackStatus?: string;
  status: ResourceStatus;
  checks: PropertyCheck[];
  /** Semantics the emulator does not provide for this type (unsupported resources). */
  unsupportedSemantics?: string;
  error?: string;
}

/** One row of the per-property classification summary (same type, property and category). */
export interface PropertyClassification {
  type: string;
  property: string;
  status: CheckStatus;
  resources: number;
  reason?: string;
}

export interface ReconciliationReport {
  target: 'ministack-emulator';
  stackName: string;
  stackStatus?: string;
  templateResources: number;
  stackResources: number;
  counts: Record<ResourceStatus, number>;
  /** Property checks of all resources, per category. */
  propertyCounts: Record<CheckStatus, number>;
  /** Per type and property: the category and its reason (the classification summary). */
  classification: PropertyClassification[];
  noopPlaceholders: string[];
  /** Stack resources without a template counterpart (should never happen). */
  extraStackResources: string[];
  unsupported: { logicalId: string; type: string; reasons: string[] }[];
  resources: ResourceResult[];
  ok: boolean;
}

/** Types whose semantics MiniStack 1.5.26 stores but does not enforce. */
export const UNSUPPORTED_SEMANTICS: Record<string, string> = {
  'AWS::IAM::Role':
    'iamNotEnforced: MiniStack stores roles and trust policies but does not evaluate them (AUTH off)',
  'AWS::IAM::Policy':
    'iamNotEnforced: MiniStack stores inline policies but does not evaluate them (AUTH off)',
  'AWS::KMS::Key':
    'kmsNotEnforced: MiniStack evaluates no key policy; its symmetric crypto is not AWS KMS',
};

/**
 * Stored and returned by MiniStack 1.5.26, but without effect (type → template property → why).
 * Compared: equal → `compared-not-enforced`, different → `mismatch` (fails).
 * Verified in CI and locally against MiniStack 1.5.26: the values read back equal what was stored.
 */
export const NOT_ENFORCED_PROPERTIES: Record<string, Record<string, string>> = {
  'AWS::Logs::LogGroup': {
    KmsKeyId:
      'MiniStack stores and returns kmsKeyId, but log events are not encrypted with the CMK',
  },
  'AWS::Lambda::Function': {
    TracingConfig: 'MiniStack stores and returns TracingConfig.Mode, but emulates no X-Ray tracing',
  },
};

/**
 * NOT stored or returned by MiniStack 1.5.26 (type → template property → why). Compared first: an
 * absent or default read-back → `unsupported`; an equal one → `compared-not-enforced`; any other
 * value → `mismatch`.
 */
export const UNSUPPORTED_PROPERTIES: Record<string, Record<string, string>> = {
  'AWS::DynamoDB::Table': {
    SSESpecification:
      'MiniStack CloudFormation does not apply SSE: DescribeTable returns no SSEDescription (no CMK encryption)',
    PointInTimeRecoverySpecification:
      'MiniStack CloudFormation does not apply PITR: DescribeContinuousBackups reports DISABLED',
    TimeToLiveSpecification:
      'MiniStack CloudFormation does not apply TimeToLiveSpecification: DescribeTimeToLive reports DISABLED',
  },
  'AWS::StepFunctions::StateMachine': {
    EncryptionConfiguration:
      'MiniStack CloudFormation does not store EncryptionConfiguration: DescribeStateMachine returns none (no encryption)',
    LoggingConfiguration:
      'sfnExecutionLogs: MiniStack CloudFormation does not store LoggingConfiguration: DescribeStateMachine returns no level and no destinations, and no execution events are delivered',
    TracingConfiguration:
      'MiniStack CloudFormation does not store TracingConfiguration: DescribeStateMachine returns none (no X-Ray)',
  },
};

/**
 * Template properties the reconciler deliberately does NOT compare, each with the reason it cannot
 * be read back meaningfully. Anything not compared and not listed here is `unknown` and fails.
 */
export const UNCOMPARED_PROPERTIES: Record<string, Record<string, string>> = {
  'AWS::Lambda::Function': {
    Code: 'the template names the S3 asset (bucket/key) only; the service returns CodeSha256 of the deployed zip, which the template does not carry. The deployed code is exercised by "verify update" (new version, APP_VERSION) and the workflows suite',
  },
  'AWS::KMS::Key': {
    PendingWindowInDays:
      'applies only once the key is scheduled for deletion; DescribeKey of an enabled key does not return it (on AWS either). "verify destroyed" checks the key is PendingDeletion',
  },
  'AWS::CDK::Metadata': {
    Analytics: 'CDK version-reporting record: template-only, no service object (on AWS either)',
  },
};

const NOOP_PHYSICAL_ID = /-noop-[0-9a-f]{8}$/;

// ---------------------------------------------------------------------------------------------
// Service reads (injectable for the unit test)
// ---------------------------------------------------------------------------------------------

export interface StackResourceInfo {
  logicalId: string;
  type: string;
  physicalId?: string;
  status?: string;
}

/** Every read the reconciliation needs; the real one calls MiniStack through the AWS SDK. */
export interface EmulatorReader {
  stack(
    stackName: string,
  ): Promise<{ stackId?: string; status?: string; tags?: Record<string, string> } | undefined>;
  stackResources(stackName: string): Promise<StackResourceInfo[]>;
  table(name: string): Promise<Record<string, unknown> | undefined>;
  timeToLive(name: string): Promise<Record<string, unknown> | undefined>;
  continuousBackups(name: string): Promise<Record<string, unknown> | undefined>;
  functionConfiguration(
    name: string,
    qualifier?: string,
  ): Promise<Record<string, unknown> | undefined>;
  functionVersions(name: string): Promise<string[]>;
  alias(functionName: string, alias: string): Promise<Record<string, unknown> | undefined>;
  eventInvokeConfig(
    functionName: string,
    qualifier: string,
  ): Promise<Record<string, unknown> | undefined>;
  stateMachine(arn: string): Promise<Record<string, unknown> | undefined>;
  logGroup(name: string): Promise<Record<string, unknown> | undefined>;
  role(name: string): Promise<Record<string, unknown> | undefined>;
  rolePolicy(role: string, policy: string): Promise<string | undefined>;
  key(id: string): Promise<Record<string, unknown> | undefined>;
  keyRotation(id: string): Promise<boolean | undefined>;
  keyPolicy(id: string): Promise<string | undefined>;
  /**
   * The resource's tags as a map (`undefined`: the service has no tag store for it). `id` is the
   * ARN, except IAM roles (name) and KMS keys (key id).
   */
  tags(type: string, id: string): Promise<Record<string, string> | undefined>;
}

/** The tag-listing types (each with its service's tag API). */
export const TAGGED_TYPES = new Set([
  'AWS::DynamoDB::Table',
  'AWS::Lambda::Function',
  'AWS::StepFunctions::StateMachine',
  'AWS::Logs::LogGroup',
  'AWS::IAM::Role',
  'AWS::KMS::Key',
]);

const tagMap = (
  list: readonly object[] | undefined,
  key: string,
  value: string,
): Record<string, string> =>
  Object.fromEntries(
    (list ?? []).map((t) => {
      const x = t as Record<string, unknown>;
      return [String(x[key]), String(x[value] ?? '')];
    }),
  );

const NOT_FOUND = new Set([
  'ResourceNotFoundException',
  'NoSuchEntityException',
  'NoSuchEntity',
  'NotFoundException',
  'StateMachineDoesNotExist',
  'ValidationError',
]);

async function orUndefined<T>(call: () => Promise<T>): Promise<T | undefined> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof Error && NOT_FOUND.has(error.name)) return undefined;
    throw error;
  }
}

const plain = <T extends object>(o: T | undefined): Record<string, unknown> | undefined => {
  if (o === undefined) return undefined;
  const { $metadata: _m, ...rest } = o as T & { $metadata?: unknown };
  return rest as Record<string, unknown>;
};

/** The real reader (AWS SDK v3, endpoint and fake credentials from the guarded environment). */
export function sdkReader(region: string): EmulatorReader & { destroy(): void } {
  const cfn = new CloudFormationClient({ region });
  const ddb = new DynamoDBClient({ region });
  const lambda = new LambdaClient({ region });
  const sfn = new SFNClient({ region });
  const logs = new CloudWatchLogsClient({ region });
  const iam = new IAMClient({ region });
  const kms = new KMSClient({ region });
  return {
    async stack(stackName) {
      const out = await orUndefined(() =>
        cfn.send(new DescribeStacksCommand({ StackName: stackName })),
      );
      const s = out?.Stacks?.[0];
      return s
        ? { stackId: s.StackId, status: s.StackStatus, tags: tagMap(s.Tags, 'Key', 'Value') }
        : undefined;
    },
    async stackResources(stackName) {
      const out = await cfn.send(new DescribeStackResourcesCommand({ StackName: stackName }));
      return (out.StackResources ?? []).map((r) => ({
        logicalId: r.LogicalResourceId ?? '',
        type: r.ResourceType ?? '',
        physicalId: r.PhysicalResourceId,
        status: r.ResourceStatus,
      }));
    },
    table: async (name) =>
      plain(
        (await orUndefined(() => ddb.send(new DescribeTableCommand({ TableName: name }))))?.Table,
      ),
    timeToLive: async (name) =>
      plain(
        (await orUndefined(() => ddb.send(new DescribeTimeToLiveCommand({ TableName: name }))))
          ?.TimeToLiveDescription,
      ),
    continuousBackups: async (name) =>
      plain(
        (
          await orUndefined(() =>
            ddb.send(new DescribeContinuousBackupsCommand({ TableName: name })),
          )
        )?.ContinuousBackupsDescription,
      ),
    functionConfiguration: async (name, qualifier) =>
      plain(
        await orUndefined(() =>
          lambda.send(
            new GetFunctionConfigurationCommand({ FunctionName: name, Qualifier: qualifier }),
          ),
        ),
      ),
    async functionVersions(name) {
      const versions: string[] = [];
      let marker: string | undefined;
      do {
        const page = await lambda.send(
          new ListVersionsByFunctionCommand({ FunctionName: name, Marker: marker }),
        );
        versions.push(...(page.Versions ?? []).map((v) => v.Version ?? ''));
        marker = page.NextMarker;
      } while (marker);
      return versions;
    },
    alias: async (functionName, name) =>
      plain(
        await orUndefined(() =>
          lambda.send(new GetAliasCommand({ FunctionName: functionName, Name: name })),
        ),
      ),
    eventInvokeConfig: async (functionName, qualifier) =>
      plain(
        await orUndefined(() =>
          lambda.send(
            new GetFunctionEventInvokeConfigCommand({
              FunctionName: functionName,
              Qualifier: qualifier,
            }),
          ),
        ),
      ),
    stateMachine: async (arn) =>
      plain(
        await orUndefined(() =>
          sfn.send(new DescribeStateMachineCommand({ stateMachineArn: arn })),
        ),
      ),
    async logGroup(name) {
      const out = await logs.send(new DescribeLogGroupsCommand({ logGroupNamePrefix: name }));
      return plain(out.logGroups?.find((g) => g.logGroupName === name));
    },
    role: async (name) =>
      plain((await orUndefined(() => iam.send(new GetRoleCommand({ RoleName: name }))))?.Role),
    rolePolicy: async (role, policy) =>
      (
        await orUndefined(() =>
          iam.send(new GetRolePolicyCommand({ RoleName: role, PolicyName: policy })),
        )
      )?.PolicyDocument,
    key: async (id) =>
      plain(
        (await orUndefined(() => kms.send(new DescribeKeyCommand({ KeyId: id }))))?.KeyMetadata,
      ),
    keyRotation: async (id) =>
      (await orUndefined(() => kms.send(new GetKeyRotationStatusCommand({ KeyId: id }))))
        ?.KeyRotationEnabled,
    keyPolicy: async (id) =>
      (
        await orUndefined(() =>
          kms.send(new GetKeyPolicyCommand({ KeyId: id, PolicyName: 'default' })),
        )
      )?.Policy,
    async tags(type, id) {
      switch (type) {
        case 'AWS::DynamoDB::Table': {
          const out = await ddb.send(new ListTagsOfResourceCommand({ ResourceArn: id }));
          return tagMap(out.Tags, 'Key', 'Value');
        }
        case 'AWS::Lambda::Function':
          return { ...(await lambda.send(new ListTagsCommand({ Resource: id }))).Tags };
        case 'AWS::StepFunctions::StateMachine': {
          const out = await sfn.send(new ListSfnTagsCommand({ resourceArn: id }));
          return tagMap(out.tags, 'key', 'value');
        }
        case 'AWS::Logs::LogGroup':
          return {
            ...(await logs.send(new ListLogTagsCommand({ resourceArn: id.replace(/:\*$/, '') })))
              .tags,
          };
        case 'AWS::IAM::Role': {
          const out = await iam.send(new ListRoleTagsCommand({ RoleName: id }));
          return tagMap(out.Tags, 'Key', 'Value');
        }
        case 'AWS::KMS::Key': {
          const out = await kms.send(new ListResourceTagsCommand({ KeyId: id }));
          return tagMap(out.Tags, 'TagKey', 'TagValue');
        }
        default:
          return undefined;
      }
    },
    destroy() {
      for (const c of [cfn, ddb, lambda, sfn, logs, iam, kms]) c.destroy();
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------------------------

/** Read-backs of one resource, gathered before comparing (GetAtt values come from them). */
interface Observed {
  main?: Record<string, unknown>;
  extra: Record<string, unknown>;
}

const lastSegment = (arn: string, sep = ':') => arn.slice(arn.lastIndexOf(sep) + 1);

/** How long a read-back waits for a Lambda function to leave a transitional state. */
export interface SettleOptions {
  timeoutMs: number;
  intervalMs: number;
  sleep?: (ms: number) => Promise<void>;
}
export const DEFAULT_SETTLE: SettleOptions = { timeoutMs: 60_000, intervalMs: 1_000 };

const isTransitional = (config: Record<string, unknown> | undefined) =>
  config !== undefined && (config.State === 'Pending' || config.LastUpdateStatus === 'InProgress');

/**
 * A function's configuration once it is no longer `Pending`/`InProgress`, as an AWS client waits
 * (`waitUntilFunctionActiveV2`/`…UpdatedV2`) after a create or update. Bounded: after the timeout
 * the last (still transitional) read is returned and the comparison reports it as a mismatch.
 */
export async function settledFunctionConfiguration(
  reader: EmulatorReader,
  name: string,
  settle: SettleOptions = DEFAULT_SETTLE,
): Promise<Record<string, unknown> | undefined> {
  const sleep = settle.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const deadline = Date.now() + settle.timeoutMs;
  let config = await reader.functionConfiguration(name);
  while (isTransitional(config) && Date.now() < deadline) {
    await sleep(settle.intervalMs);
    config = await reader.functionConfiguration(name);
  }
  return config;
}

/** The id the type's tag API takes: an ARN from the read-back, the role name or the key id. */
function tagId(type: string, o: Observed, physicalId: string): string | undefined {
  const m = o.main ?? {};
  const id = {
    'AWS::DynamoDB::Table': m.TableArn,
    'AWS::Lambda::Function': m.FunctionArn,
    'AWS::StepFunctions::StateMachine': m.stateMachineArn,
    'AWS::Logs::LogGroup': m.arn,
    'AWS::IAM::Role': physicalId,
    'AWS::KMS::Key': physicalId,
  }[type];
  return typeof id === 'string' && id !== '' ? id : undefined;
}

async function observe(
  reader: EmulatorReader,
  r: StackResourceInfo,
  props: Record<string, unknown>,
  settle: SettleOptions = DEFAULT_SETTLE,
): Promise<Observed> {
  const o = await observeMain(reader, r, props, settle);
  // Tags only where the template sets them (a type without a tag API leaves them unknown).
  const id = o.main && props.Tags !== undefined ? tagId(r.type, o, r.physicalId ?? '') : undefined;
  if (id !== undefined) o.extra.tags = await reader.tags(r.type, id);
  return o;
}

async function observeMain(
  reader: EmulatorReader,
  r: StackResourceInfo,
  props: Record<string, unknown>,
  settle: SettleOptions,
): Promise<Observed> {
  const id = r.physicalId ?? '';
  switch (r.type) {
    case 'AWS::DynamoDB::Table':
      return {
        main: await reader.table(id),
        extra: { ttl: await reader.timeToLive(id), backups: await reader.continuousBackups(id) },
      };
    case 'AWS::Lambda::Function':
      return { main: await settledFunctionConfiguration(reader, id, settle), extra: {} };
    case 'AWS::Lambda::Version': {
      // Physical id: the version ARN (…:function:<name>:<version>).
      const fnName = id.split(':').slice(-2, -1)[0] ?? '';
      const versions = await reader.functionVersions(fnName);
      const version = lastSegment(id);
      return {
        main: versions.includes(version)
          ? await reader.functionConfiguration(fnName, version)
          : undefined,
        extra: { functionName: fnName, version, versions },
      };
    }
    case 'AWS::Lambda::Alias': {
      const fnName = id.split(':').slice(-2, -1)[0] ?? '';
      return { main: await reader.alias(fnName, lastSegment(id)), extra: { functionName: fnName } };
    }
    case 'AWS::Lambda::EventInvokeConfig': {
      const [fnName = '', qualifier = ''] = id.split(':');
      return {
        main: await reader.eventInvokeConfig(fnName, qualifier),
        extra: { fnName, qualifier },
      };
    }
    case 'AWS::StepFunctions::StateMachine':
      return { main: await reader.stateMachine(id), extra: {} };
    case 'AWS::Logs::LogGroup':
      return { main: await reader.logGroup(id), extra: {} };
    case 'AWS::IAM::Role':
      return { main: await reader.role(id), extra: {} };
    case 'AWS::IAM::Policy': {
      const policyName = String(props.PolicyName ?? '');
      const documents: Record<string, string | undefined> = {};
      // Roles are Refs: resolved later; the read needs the role names now (physical ids).
      return { main: { PolicyName: policyName }, extra: { documents } };
    }
    case 'AWS::KMS::Key':
      return {
        main: await reader.key(id),
        extra: { rotation: await reader.keyRotation(id), policy: await reader.keyPolicy(id) },
      };
    default:
      return { extra: {} };
  }
}

/** GetAtt values the template may reference, from the read-backs (never from the template). */
function attributesOf(
  logicalId: string,
  type: string,
  o: Observed,
  physicalId: string,
): Record<string, string> {
  const m = o.main ?? {};
  const out: Record<string, string> = {};
  const put = (attr: string, v: unknown) => {
    if (typeof v === 'string' && v !== '') out[`${logicalId}.${attr}`] = v;
  };
  switch (type) {
    case 'AWS::DynamoDB::Table':
      put('Arn', m.TableArn);
      put('StreamArn', m.LatestStreamArn);
      break;
    case 'AWS::Lambda::Function':
      put('Arn', m.FunctionArn);
      break;
    case 'AWS::Lambda::Version':
      put('Version', o.extra.version);
      put('FunctionArn', physicalId);
      break;
    case 'AWS::Lambda::Alias':
      put('AliasArn', m.AliasArn);
      break;
    case 'AWS::StepFunctions::StateMachine':
      put('Arn', m.stateMachineArn);
      put('Name', m.name);
      break;
    case 'AWS::Logs::LogGroup':
      put('Arn', m.arn);
      break;
    case 'AWS::IAM::Role':
      put('Arn', m.Arn);
      put('RoleId', m.RoleId);
      break;
    case 'AWS::KMS::Key':
      put('Arn', m.Arn);
      put('KeyId', m.KeyId);
      break;
    default:
      break;
  }
  return out;
}

/** A read-back that carries no setting: absent, empty, disabled or a service default. */
export function isDefaultReadBack(value: unknown): boolean {
  if (value === undefined || value === null || value === false || value === '') return true;
  if (typeof value === 'string') return ['DISABLED', 'OFF', 'AWS_OWNED_KEY'].includes(value);
  if (Array.isArray(value)) return value.every(isDefaultReadBack);
  if (isObject(value)) return Object.values(value).every(isDefaultReadBack);
  return false;
}

/** The top-level template property of a check label or covered path (`A.B (x)` → `A`). */
const topLevel = (path: string) => path.split(/[ .(]/)[0] ?? path;

interface EqOptions {
  compare?: (expected: unknown, actual: unknown) => boolean;
  /**
   * Template property paths (`Prop` or `Prop.SubKey`) the check covers. Default: the label itself
   * when it is a plain path (`Runtime`, `LoggingConfig.LogGroup`); a descriptive label covers
   * nothing unless listed here.
   */
  covers?: readonly string[];
}

/** Collects the checks of one resource and the template property paths they cover. */
class Checks {
  readonly list: PropertyCheck[] = [];
  readonly covered = new Set<string>();
  constructor(private readonly type: string) {}

  /** Compares first, then classifies (NOT_ENFORCED_PROPERTIES / UNSUPPORTED_PROPERTIES). */
  eq(property: string, expected: unknown, actual: unknown, options: EqOptions = {}): void {
    const covers =
      options.covers ?? (/^[A-Za-z0-9]+(\.[A-Za-z0-9]+)*$/.test(property) ? [property] : []);
    for (const c of covers) this.covered.add(c);
    const equal = (options.compare ?? sameJson)(expected, actual);
    const top = topLevel(covers[0] ?? property);
    const notEnforced = NOT_ENFORCED_PROPERTIES[this.type]?.[top];
    const unsupported = UNSUPPORTED_PROPERTIES[this.type]?.[top];
    const reason = notEnforced ?? unsupported;
    let status: CheckStatus = equal ? 'match' : 'mismatch';
    if (equal && reason) status = 'compared-not-enforced';
    else if (!equal && unsupported && isDefaultReadBack(actual)) status = 'unsupported';
    this.list.push({ property, status, expected, actual, ...(reason ? { reason } : {}) });
  }

  /** Compares only when the template sets the property. */
  opt(property: string, expected: unknown, actual: unknown, options: EqOptions = {}): void {
    if (expected !== undefined) this.eq(property, expected, actual, options);
  }
}

/**
 * Template property paths no check covered: each is `uncompared` (listed, with its reason) or
 * `unknown` (fails). A property whose sub-keys were compared one by one (`TracingConfig.Mode`)
 * reports every other sub-key of the template value.
 */
export function classifyUncovered(
  type: string,
  props: Record<string, unknown>,
  covered: ReadonlySet<string>,
): PropertyCheck[] {
  const out: PropertyCheck[] = [];
  const add = (path: string, expected: unknown) => {
    const reason = UNCOMPARED_PROPERTIES[type]?.[path];
    out.push(
      reason
        ? { property: path, status: 'uncompared', expected, reason }
        : {
            property: path,
            status: 'unknown',
            expected,
            reason:
              'template property not compared and not listed in UNCOMPARED_PROPERTIES: add a comparison or a reviewed entry',
          },
    );
  };
  for (const [key, value] of Object.entries(props)) {
    if (covered.has(key)) continue;
    const subPaths = [...covered].filter((c) => c.startsWith(`${key}.`));
    if (subPaths.length === 0) {
      add(key, value);
      continue;
    }
    const items = Array.isArray(value) ? value : [value];
    const subKeys = new Set(items.filter(isObject).flatMap((v) => Object.keys(v)));
    for (const sub of [...subKeys].sort()) {
      if (!covered.has(`${key}.${sub}`)) {
        add(
          `${key}.${sub}`,
          Array.isArray(value)
            ? items.map((v) => (isObject(v) ? v[sub] : undefined))
            : (value as Record<string, unknown>)[sub],
        );
      }
    }
  }
  return out;
}

/**
 * Template tags (a Key/Value list) plus the stack-level tags CloudFormation propagates to every
 * resource (as on AWS), against the read-back map; `aws:` keys are CloudFormation's own.
 */
function compareTags(c: Checks, p: Record<string, unknown>, o: Observed): void {
  if (p.Tags === undefined) return;
  const expected = {
    ...(o.extra.stackTags as Record<string, string> | undefined),
    ...tagMap(p.Tags as object[], 'Key', 'Value'),
  };
  const read = o.extra.tags as Record<string, string> | undefined;
  const actual =
    read === undefined
      ? undefined
      : Object.fromEntries(Object.entries(read).filter(([k]) => !k.startsWith('aws:')));
  c.eq('Tags', expected, actual);
}

const sortBy = <T>(list: readonly T[] | undefined, key: (t: T) => string): T[] =>
  [...(list ?? [])].sort((a, b) => key(a).localeCompare(key(b)));

function compareTable(
  c: Checks,
  p: Record<string, unknown>,
  o: Observed,
  physicalId: string,
): void {
  const t = o.main ?? {};
  c.eq('TableName', p.TableName ?? physicalId, t.TableName);
  c.eq('TableStatus', 'ACTIVE', t.TableStatus);
  c.eq('KeySchema', p.KeySchema, t.KeySchema);
  const byName = (a: { AttributeName?: unknown }) => String(a.AttributeName);
  c.eq(
    'AttributeDefinitions',
    sortBy(p.AttributeDefinitions as { AttributeName?: unknown }[], byName),
    sortBy(t.AttributeDefinitions as { AttributeName?: unknown }[], byName),
  );
  c.opt(
    'BillingMode',
    p.BillingMode,
    (t.BillingModeSummary as Record<string, unknown> | undefined)?.BillingMode,
  );
  c.opt(
    'DeletionProtectionEnabled',
    p.DeletionProtectionEnabled,
    t.DeletionProtectionEnabled ?? false,
  );
  const gsi = (list: unknown) =>
    sortBy(list as { IndexName?: unknown }[] | undefined, (g) => String(g.IndexName)).map((g) => {
      const x = g as Record<string, unknown>;
      return { IndexName: x.IndexName, KeySchema: x.KeySchema, Projection: x.Projection };
    });
  c.eq('GlobalSecondaryIndexes', gsi(p.GlobalSecondaryIndexes), gsi(t.GlobalSecondaryIndexes), {
    covers: ['IndexName', 'KeySchema', 'Projection'].map((k) => `GlobalSecondaryIndexes.${k}`),
  });
  const ttl = p.TimeToLiveSpecification as
    { AttributeName?: string; Enabled?: boolean } | undefined;
  if (ttl) {
    const actual = o.extra.ttl as Record<string, unknown> | undefined;
    c.eq(
      'TimeToLiveSpecification',
      { AttributeName: ttl.AttributeName, Status: ttl.Enabled ? 'ENABLED' : 'DISABLED' },
      { AttributeName: actual?.AttributeName, Status: actual?.TimeToLiveStatus },
      { covers: ['TimeToLiveSpecification.AttributeName', 'TimeToLiveSpecification.Enabled'] },
    );
  }
  const pitr = p.PointInTimeRecoverySpecification as
    { PointInTimeRecoveryEnabled?: boolean; RecoveryPeriodInDays?: number } | undefined;
  if (pitr) {
    const b = o.extra.backups as
      { PointInTimeRecoveryDescription?: Record<string, unknown> } | undefined;
    const d = b?.PointInTimeRecoveryDescription;
    c.eq(
      'PointInTimeRecoverySpecification',
      {
        Status: pitr.PointInTimeRecoveryEnabled ? 'ENABLED' : 'DISABLED',
        RecoveryPeriodInDays: pitr.RecoveryPeriodInDays,
      },
      {
        Status: d?.PointInTimeRecoveryStatus,
        RecoveryPeriodInDays:
          pitr.RecoveryPeriodInDays === undefined ? undefined : d?.RecoveryPeriodInDays,
      },
      {
        covers: ['PointInTimeRecoveryEnabled', 'RecoveryPeriodInDays'].map(
          (k) => `PointInTimeRecoverySpecification.${k}`,
        ),
      },
    );
  }
  const sse = p.SSESpecification as
    { SSEEnabled?: boolean; SSEType?: string; KMSMasterKeyId?: string } | undefined;
  if (sse) {
    const d = t.SSEDescription as Record<string, unknown> | undefined;
    c.eq(
      'SSESpecification',
      {
        Status: sse.SSEEnabled ? 'ENABLED' : 'DISABLED',
        SSEType: sse.SSEType,
        KMSMasterKeyArn: sse.KMSMasterKeyId,
      },
      { Status: d?.Status, SSEType: d?.SSEType, KMSMasterKeyArn: d?.KMSMasterKeyArn },
      { covers: ['SSEEnabled', 'SSEType', 'KMSMasterKeyId'].map((k) => `SSESpecification.${k}`) },
    );
  }
  compareTags(c, p, o);
}

function compareFunction(
  c: Checks,
  p: Record<string, unknown>,
  o: Observed,
  physicalId: string,
): void {
  const f = o.main ?? {};
  c.eq('FunctionName', p.FunctionName ?? physicalId, f.FunctionName);
  // After the bounded settle-wait: Active AND the last update Successful (MiniStack 1.5.26
  // returns LastUpdateStatus, so an absent value is a mismatch too).
  c.eq('State', 'Active', f.State);
  c.eq(
    'LastUpdateStatus',
    'Successful',
    f.LastUpdateStatus === 'Successful' || f.LastUpdateStatus === undefined
      ? f.LastUpdateStatus
      : `${String(f.LastUpdateStatus)}${f.LastUpdateStatusReason ? ` (${String(f.LastUpdateStatusReason)})` : ''}`,
  );
  for (const key of [
    'Runtime',
    'Handler',
    'Timeout',
    'MemorySize',
    'Role',
    'Description',
    'Architectures',
  ] as const) {
    c.opt(key, p[key], f[key]);
  }
  const env = (p.Environment as { Variables?: Record<string, unknown> } | undefined)?.Variables;
  const actualEnv = (f.Environment as { Variables?: Record<string, unknown> } | undefined)
    ?.Variables;
  const envCovers = { covers: ['Environment.Variables'] };
  c.eq(
    'Environment.Variables (keys)',
    Object.keys(env ?? {}).sort(),
    Object.keys(actualEnv ?? {}).sort(),
    envCovers,
  );
  c.eq('Environment.Variables (values)', env ?? {}, actualEnv ?? {}, envCovers);
  const tracing = (p.TracingConfig as { Mode?: string } | undefined)?.Mode;
  c.opt('TracingConfig.Mode', tracing, (f.TracingConfig as { Mode?: string } | undefined)?.Mode);
  const logGroup = (p.LoggingConfig as { LogGroup?: string } | undefined)?.LogGroup;
  c.opt(
    'LoggingConfig.LogGroup',
    logGroup,
    (f.LoggingConfig as { LogGroup?: string } | undefined)?.LogGroup,
  );
  compareTags(c, p, o);
}

function compareStateMachine(
  c: Checks,
  p: Record<string, unknown>,
  o: Observed,
  physicalId: string,
): void {
  const m = o.main ?? {};
  c.eq('Arn', physicalId, m.stateMachineArn);
  c.opt('StateMachineName', p.StateMachineName, m.name);
  c.opt('StateMachineType', p.StateMachineType, m.type);
  c.opt('RoleArn', p.RoleArn, m.roleArn);
  let expected: Record<string, unknown> | undefined;
  let actual: Record<string, unknown> | undefined;
  try {
    expected = JSON.parse(String(p.DefinitionString)) as Record<string, unknown>;
    actual = JSON.parse(String(m.definition)) as Record<string, unknown>;
  } catch {
    // Reported by the definition check below.
  }
  c.eq(
    'DefinitionString (ASL, tokens resolved)',
    expected ?? p.DefinitionString,
    actual ?? m.definition,
    { covers: ['DefinitionString'] },
  );
  c.eq('Definition.TimeoutSeconds', expected?.TimeoutSeconds, actual?.TimeoutSeconds, {
    compare: (a, b) => a !== undefined && a === b,
    covers: [],
  });
  const logging = p.LoggingConfiguration as
    | {
        Level?: string;
        IncludeExecutionData?: boolean;
        Destinations?: { CloudWatchLogsLogGroup?: { LogGroupArn?: string } }[];
      }
    | undefined;
  if (logging) {
    const l = m.loggingConfiguration as
      | {
          level?: string;
          includeExecutionData?: boolean;
          destinations?: { cloudWatchLogsLogGroup?: { logGroupArn?: string } }[];
        }
      | undefined;
    c.eq(
      'LoggingConfiguration',
      {
        level: logging.Level,
        includeExecutionData: logging.IncludeExecutionData,
        destinations: (logging.Destinations ?? []).map(
          (d) => d.CloudWatchLogsLogGroup?.LogGroupArn,
        ),
      },
      {
        level: l?.level,
        includeExecutionData: l?.includeExecutionData,
        destinations: (l?.destinations ?? []).map((d) => d.cloudWatchLogsLogGroup?.logGroupArn),
      },
      {
        covers: ['Level', 'IncludeExecutionData', 'Destinations'].map(
          (k) => `LoggingConfiguration.${k}`,
        ),
      },
    );
  }
  const tracing = p.TracingConfiguration as { Enabled?: boolean } | undefined;
  if (tracing)
    c.eq(
      'TracingConfiguration.Enabled',
      tracing.Enabled,
      (m.tracingConfiguration as { enabled?: boolean } | undefined)?.enabled,
    );
  const enc = p.EncryptionConfiguration as
    { Type?: string; KmsKeyId?: string; KmsDataKeyReusePeriodSeconds?: number } | undefined;
  if (enc) {
    const e = m.encryptionConfiguration as
      { type?: string; kmsKeyId?: string; kmsDataKeyReusePeriodSeconds?: number } | undefined;
    c.eq(
      'EncryptionConfiguration',
      {
        type: enc.Type,
        kmsKeyId: enc.KmsKeyId,
        kmsDataKeyReusePeriodSeconds: enc.KmsDataKeyReusePeriodSeconds,
      },
      {
        type: e?.type,
        kmsKeyId: e?.kmsKeyId,
        kmsDataKeyReusePeriodSeconds: e?.kmsDataKeyReusePeriodSeconds,
      },
      {
        covers: ['Type', 'KmsKeyId', 'KmsDataKeyReusePeriodSeconds'].map(
          (k) => `EncryptionConfiguration.${k}`,
        ),
      },
    );
  }
  compareTags(c, p, o);
}

function compareKey(c: Checks, p: Record<string, unknown>, o: Observed): void {
  const k = o.main ?? {};
  c.eq('KeyState', 'Enabled', k.KeyState);
  c.opt('Description', p.Description, k.Description);
  c.eq('KeySpec', p.KeySpec ?? 'SYMMETRIC_DEFAULT', k.KeySpec);
  c.eq('KeyUsage', p.KeyUsage ?? 'ENCRYPT_DECRYPT', k.KeyUsage);
  c.eq('EnableKeyRotation', p.EnableKeyRotation ?? false, o.extra.rotation ?? false);
  c.opt('KeyPolicy', p.KeyPolicy, parsePolicyDocument(o.extra.policy as string | undefined));
  compareTags(c, p, o);
}

function compareRole(c: Checks, p: Record<string, unknown>, o: Observed, physicalId: string): void {
  const r = o.main ?? {};
  c.eq('RoleName', p.RoleName ?? physicalId, r.RoleName);
  c.eq(
    'AssumeRolePolicyDocument',
    p.AssumeRolePolicyDocument,
    parsePolicyDocument(r.AssumeRolePolicyDocument as string | undefined),
  );
  c.opt('Description', p.Description, r.Description);
  c.opt('MaxSessionDuration', p.MaxSessionDuration, r.MaxSessionDuration);
  c.eq('Path', p.Path ?? '/', r.Path);
  c.opt(
    'PermissionsBoundary',
    p.PermissionsBoundary,
    (r.PermissionsBoundary as { PermissionsBoundaryArn?: string } | undefined)
      ?.PermissionsBoundaryArn,
  );
  compareTags(c, p, o);
}

function compareResource(
  r: StackResourceInfo,
  p: Record<string, unknown>,
  o: Observed,
): PropertyCheck[] {
  const c = compareKnown(r, p, o);
  return [...c.list, ...classifyUncovered(r.type, p, c.covered)];
}

function compareKnown(r: StackResourceInfo, p: Record<string, unknown>, o: Observed): Checks {
  const c = new Checks(r.type);
  const id = r.physicalId ?? '';
  const m = o.main ?? {};
  switch (r.type) {
    case 'AWS::DynamoDB::Table':
      compareTable(c, p, o, id);
      break;
    case 'AWS::Lambda::Function':
      compareFunction(c, p, o, id);
      break;
    case 'AWS::Lambda::Version':
      c.eq('FunctionName', p.FunctionName, o.extra.functionName);
      c.eq(
        'Version published',
        true,
        (o.extra.versions as string[]).includes(String(o.extra.version)),
      );
      c.eq('Version', o.extra.version, m.Version);
      break;
    case 'AWS::Lambda::Alias':
      c.eq('Name', p.Name, m.Name);
      c.eq('FunctionName', p.FunctionName, o.extra.functionName);
      c.eq('FunctionVersion (alias → version)', p.FunctionVersion, m.FunctionVersion, {
        covers: ['FunctionVersion'],
      });
      c.opt('Description', p.Description, m.Description);
      break;
    case 'AWS::Lambda::EventInvokeConfig':
      c.eq('FunctionName', p.FunctionName, o.extra.fnName);
      c.eq('Qualifier', p.Qualifier, o.extra.qualifier);
      c.opt('MaximumRetryAttempts', p.MaximumRetryAttempts, m.MaximumRetryAttempts);
      c.opt('MaximumEventAgeInSeconds', p.MaximumEventAgeInSeconds, m.MaximumEventAgeInSeconds);
      break;
    case 'AWS::StepFunctions::StateMachine':
      compareStateMachine(c, p, o, id);
      break;
    case 'AWS::Logs::LogGroup':
      c.eq('LogGroupName', p.LogGroupName ?? id, m.logGroupName);
      c.opt('RetentionInDays', p.RetentionInDays, m.retentionInDays);
      c.opt('KmsKeyId', p.KmsKeyId, m.kmsKeyId);
      compareTags(c, p, o);
      break;
    case 'AWS::IAM::Role':
      compareRole(c, p, o, id);
      break;
    case 'AWS::IAM::Policy': {
      const docs = o.extra.documents as Record<string, string | undefined>;
      for (const role of (p.Roles as string[] | undefined) ?? []) {
        // The document is read by policy name per role: PolicyName and Roles are covered by it.
        c.eq(`PolicyDocument (${role})`, p.PolicyDocument, parsePolicyDocument(docs[role]), {
          covers: ['PolicyDocument', 'PolicyName', 'Roles'],
        });
      }
      break;
    }
    case 'AWS::KMS::Key':
      compareKey(c, p, o);
      break;
    default:
      break;
  }
  return c;
}

/** Types the reconciler reads back (anything else in a template fails as unknown). */
export const RECONCILED_TYPES = new Set([
  'AWS::DynamoDB::Table',
  'AWS::Lambda::Function',
  'AWS::Lambda::Version',
  'AWS::Lambda::Alias',
  'AWS::Lambda::EventInvokeConfig',
  'AWS::StepFunctions::StateMachine',
  'AWS::Logs::LogGroup',
  'AWS::IAM::Role',
  'AWS::IAM::Policy',
  'AWS::KMS::Key',
]);
/** Template-only records with no service object on AWS either. */
export const METADATA_TYPES = new Set(['AWS::CDK::Metadata']);

const OK_STATUSES = new Set(['CREATE_COMPLETE', 'UPDATE_COMPLETE']);

export async function reconcile(input: {
  reader: EmulatorReader;
  template: Template;
  stackName: string;
  region: string;
  account: string;
  settle?: SettleOptions;
}): Promise<ReconciliationReport> {
  const { reader, template, stackName } = input;
  const stack = await reader.stack(stackName);
  const stackResources = await reader.stackResources(stackName);
  const byLogical = new Map(stackResources.map((r) => [r.logicalId, r]));
  const templateIds = Object.keys(template.Resources).sort();

  // 1. Read every resource back (GetAtt values come from these reads).
  const observed = new Map<string, Observed>();
  const readErrors = new Map<string, string>();
  const ctx: ResolutionContext = {
    refs: {},
    attrs: {},
    pseudo: {
      'AWS::Region': input.region,
      'AWS::AccountId': input.account,
      'AWS::Partition': 'aws',
      'AWS::URLSuffix': 'amazonaws.com',
      'AWS::StackName': stackName,
      ...(stack?.stackId ? { 'AWS::StackId': stack.stackId } : {}),
    },
  };
  for (const id of templateIds) {
    const r = byLogical.get(id);
    if (!r?.physicalId) continue;
    ctx.refs[id] = r.physicalId;
    const props = template.Resources[id]?.Properties ?? {};
    try {
      const o = await observe(reader, r, props, input.settle);
      o.extra.stackTags = stack?.tags ?? {};
      observed.set(id, o);
      Object.assign(ctx.attrs, attributesOf(id, r.type, o, r.physicalId));
    } catch (error) {
      readErrors.set(
        id,
        error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      );
    }
  }
  // Inline policies: read per role, now that every role's name (Ref) is known.
  for (const id of templateIds) {
    const res = template.Resources[id];
    const o = observed.get(id);
    if (res?.Type !== 'AWS::IAM::Policy' || !o) continue;
    const docs = o.extra.documents as Record<string, string | undefined>;
    const name = String(res.Properties?.PolicyName ?? '');
    for (const roleRef of (res.Properties?.Roles as unknown[] | undefined) ?? []) {
      try {
        const role = String(resolveTokens(roleRef, ctx));
        docs[role] = await reader.rolePolicy(role, name);
      } catch (error) {
        readErrors.set(id, error instanceof Error ? error.message : String(error));
      }
    }
  }

  // 2. Compare each template resource with its read-back.
  const resources: ResourceResult[] = [];
  for (const id of templateIds) {
    const type = template.Resources[id]?.Type ?? '';
    const r = byLogical.get(id);
    const base = { logicalId: id, type, physicalId: r?.physicalId, stackStatus: r?.status };
    const fail = (error: string): ResourceResult => ({
      ...base,
      status: 'failed',
      checks: [],
      error,
    });
    if (!r?.physicalId) {
      resources.push(fail('no physical id in DescribeStackResources'));
      continue;
    }
    if (NOOP_PHYSICAL_ID.test(r.physicalId)) {
      resources.push(fail('MiniStack no-op placeholder: nothing was created'));
      continue;
    }
    if (!OK_STATUSES.has(r.status ?? '')) {
      resources.push(fail(`resource status ${r.status ?? 'unknown'}`));
      continue;
    }
    if (METADATA_TYPES.has(type)) {
      // No service object: every property is uncompared (listed) or unknown (fails).
      const checks = classifyUncovered(type, template.Resources[id]?.Properties ?? {}, new Set());
      const unknown = checks.filter((x) => x.status === 'unknown').map((x) => x.property);
      resources.push(
        unknown.length > 0
          ? {
              ...base,
              status: 'failed',
              checks,
              error: `unknown properties: ${unknown.join(', ')}`,
            }
          : { ...base, status: 'metadata-only', checks },
      );
      continue;
    }
    if (!RECONCILED_TYPES.has(type)) {
      resources.push(fail(`no service read-back implemented for ${type}`));
      continue;
    }
    const readError = readErrors.get(id);
    if (readError) {
      resources.push(fail(`read-back failed: ${readError}`));
      continue;
    }
    const o = observed.get(id) ?? { extra: {} };
    if (!o.main) {
      resources.push(fail('the service does not know the physical id (read-back empty)'));
      continue;
    }
    let props: Record<string, unknown>;
    try {
      props = resolveTokens(template.Resources[id]?.Properties ?? {}, ctx) as Record<
        string,
        unknown
      >;
    } catch (error) {
      resources.push(fail(error instanceof Error ? error.message : String(error)));
      continue;
    }
    const checks = compareResource(r, props, o);
    const semantics = UNSUPPORTED_SEMANTICS[type];
    const has = (s: CheckStatus) => checks.some((x) => x.status === s);
    const compared = checks.filter((x) => x.status !== 'uncompared' && x.status !== 'unknown');
    const unknown = checks.filter((x) => x.status === 'unknown').map((x) => x.property);
    const status: ResourceStatus =
      has('mismatch') || has('unknown') || compared.length === 0
        ? 'failed'
        : semantics || has('unsupported')
          ? 'unsupported'
          : has('compared-not-enforced')
            ? 'compared-not-enforced'
            : 'reconciled';
    const error = [
      ...(compared.length === 0 ? ['no property was checked'] : []),
      ...(unknown.length > 0 ? [`unknown properties: ${unknown.join(', ')}`] : []),
    ].join('; ');
    resources.push({
      ...base,
      status,
      checks,
      ...(semantics ? { unsupportedSemantics: semantics } : {}),
      ...(error ? { error } : {}),
    });
  }

  const count = (s: ResourceStatus) => resources.filter((x) => x.status === s).length;
  const noopPlaceholders = stackResources
    .filter((r) => NOOP_PHYSICAL_ID.test(r.physicalId ?? ''))
    .map((r) => r.logicalId);
  const extraStackResources = stackResources
    .map((r) => r.logicalId)
    .filter((id) => !(id in template.Resources));
  const counts = {
    reconciled: count('reconciled'),
    'compared-not-enforced': count('compared-not-enforced'),
    unsupported: count('unsupported'),
    'metadata-only': count('metadata-only'),
    failed: count('failed'),
  };
  const allChecks = resources.flatMap((x) => x.checks.map((c) => ({ type: x.type, c })));
  const propertyCounts = Object.fromEntries(
    CHECK_STATUSES.map((s) => [s, allChecks.filter((x) => x.c.status === s).length]),
  ) as Record<CheckStatus, number>;
  return {
    target: 'ministack-emulator',
    stackName,
    stackStatus: stack?.status,
    templateResources: templateIds.length,
    stackResources: stackResources.length,
    counts,
    propertyCounts,
    classification: classify(allChecks),
    noopPlaceholders,
    extraStackResources,
    unsupported: resources
      .filter((x) => x.status === 'unsupported')
      .map((x) => ({
        logicalId: x.logicalId,
        type: x.type,
        reasons: [
          ...(x.unsupportedSemantics ? [x.unsupportedSemantics] : []),
          ...x.checks
            .filter((c) => c.status === 'unsupported')
            .map((c) => `${c.property}: ${c.reason ?? ''}`),
        ],
      })),
    resources,
    ok:
      counts.failed === 0 &&
      noopPlaceholders.length === 0 &&
      extraStackResources.length === 0 &&
      templateIds.length === stackResources.length &&
      OK_STATUSES.has(stack?.status ?? ''),
  };
}

/** Groups property checks by type, property (role suffix dropped) and category. */
function classify(checks: readonly { type: string; c: PropertyCheck }[]): PropertyClassification[] {
  const rows = new Map<string, PropertyClassification>();
  for (const { type, c } of checks) {
    const property = c.property.startsWith('PolicyDocument (') ? 'PolicyDocument' : c.property;
    const key = `${type}|${property}|${c.status}`;
    const row = rows.get(key);
    if (row) row.resources += 1;
    else
      rows.set(key, {
        type,
        property,
        status: c.status,
        resources: 1,
        ...(c.reason && c.status !== 'match' && c.status !== 'mismatch'
          ? { reason: c.reason }
          : {}),
      });
  }
  return [...rows.values()].sort(
    (a, b) =>
      CHECK_STATUSES.indexOf(a.status) - CHECK_STATUSES.indexOf(b.status) ||
      a.type.localeCompare(b.type) ||
      a.property.localeCompare(b.property),
  );
}

// ---------------------------------------------------------------------------------------------
// Update deploy: Lambda versions and aliases moved
// ---------------------------------------------------------------------------------------------

export interface FunctionSnapshot {
  functionName: string;
  aliasVersion?: string;
  versions: string[];
  appVersion?: string;
}

/** Alias version, published versions and APP_VERSION of every function of the stack. */
export async function snapshotFunctions(
  reader: EmulatorReader,
  stackName: string,
): Promise<FunctionSnapshot[]> {
  const resources = await reader.stackResources(stackName);
  const out: FunctionSnapshot[] = [];
  for (const r of resources.filter((x) => x.type === 'AWS::Lambda::Function')) {
    const name = r.physicalId ?? '';
    const config = await reader.functionConfiguration(name);
    const env = (config?.Environment as { Variables?: Record<string, string> } | undefined)
      ?.Variables;
    const alias = await reader.alias(name, 'live');
    out.push({
      functionName: name,
      aliasVersion: alias?.FunctionVersion as string | undefined,
      versions: (await reader.functionVersions(name)).filter((v) => v !== '$LATEST'),
      appVersion: env?.APP_VERSION,
    });
  }
  return out.sort((a, b) => a.functionName.localeCompare(b.functionName));
}

export interface UpdateCheck {
  functionName: string;
  before: FunctionSnapshot | undefined;
  after: FunctionSnapshot;
  ok: boolean;
  problems: string[];
}

/** Every function: a NEW version published, the alias moved to it, APP_VERSION updated. */
export function verifyUpdate(
  before: readonly FunctionSnapshot[],
  after: readonly FunctionSnapshot[],
  appVersion: string,
): { ok: boolean; functions: UpdateCheck[] } {
  const functions = after.map((a) => {
    const b = before.find((x) => x.functionName === a.functionName);
    const problems: string[] = [];
    if (!b) problems.push('function not present before the update');
    if (a.appVersion !== appVersion)
      problems.push(`APP_VERSION is ${String(a.appVersion)}, expected ${appVersion}`);
    if (!a.aliasVersion) problems.push('alias live has no version');
    else if (!a.versions.includes(a.aliasVersion))
      problems.push(`alias points at unpublished version ${a.aliasVersion}`);
    if (b && a.aliasVersion === b.aliasVersion)
      problems.push(`alias did not move (still ${String(a.aliasVersion)})`);
    if (b && b.aliasVersion && a.aliasVersion && Number(a.aliasVersion) <= Number(b.aliasVersion)) {
      problems.push(`alias version ${a.aliasVersion} is not newer than ${b.aliasVersion}`);
    }
    return {
      functionName: a.functionName,
      before: b,
      after: a,
      ok: problems.length === 0,
      problems,
    };
  });
  return {
    ok: functions.length > 0 && functions.length === before.length && functions.every((f) => f.ok),
    functions,
  };
}

// ---------------------------------------------------------------------------------------------
// Destroy: the stack is gone, and so are its tables, functions, state machines, …
// ---------------------------------------------------------------------------------------------

export interface DestroyReport {
  stackName: string;
  stackId?: string;
  stackStatus: string;
  remaining: { logicalId: string; type: string; physicalId: string; state: string }[];
  checked: number;
  ok: boolean;
}

/** After `cdk destroy`: stack DELETE_COMPLETE (or unknown), no recorded resource left. */
export async function verifyDestroyed(input: {
  reader: EmulatorReader;
  stackName: string;
  stackId?: string;
  resources: readonly StackResourceInfo[];
}): Promise<DestroyReport> {
  const { reader } = input;
  const stack = await reader.stack(input.stackId ?? input.stackName);
  const stackStatus = stack?.status ?? 'DOES_NOT_EXIST';
  const remaining: DestroyReport['remaining'] = [];
  let checked = 0;
  for (const r of input.resources) {
    const id = r.physicalId ?? '';
    let state: string | undefined;
    switch (r.type) {
      case 'AWS::DynamoDB::Table':
        state = (await reader.table(id)) ? 'table exists' : undefined;
        break;
      case 'AWS::Lambda::Function':
        state = (await reader.functionConfiguration(id)) ? 'function exists' : undefined;
        break;
      case 'AWS::StepFunctions::StateMachine':
        state = (await reader.stateMachine(id)) ? 'state machine exists' : undefined;
        break;
      case 'AWS::Logs::LogGroup':
        state = (await reader.logGroup(id)) ? 'log group exists' : undefined;
        break;
      case 'AWS::IAM::Role':
        state = (await reader.role(id)) ? 'role exists' : undefined;
        break;
      case 'AWS::KMS::Key': {
        const key = await reader.key(id);
        // As on AWS, a destroyed CMK is scheduled for deletion, not removed.
        state =
          key && key.KeyState !== 'PendingDeletion' ? `key ${String(key.KeyState)}` : undefined;
        break;
      }
      default:
        continue;
    }
    checked += 1;
    if (state) remaining.push({ logicalId: r.logicalId, type: r.type, physicalId: id, state });
  }
  return {
    stackName: input.stackName,
    ...(input.stackId ? { stackId: input.stackId } : {}),
    stackStatus,
    remaining,
    checked,
    ok:
      (stackStatus === 'DELETE_COMPLETE' || stackStatus === 'DOES_NOT_EXIST') &&
      remaining.length === 0 &&
      checked > 0,
  };
}
