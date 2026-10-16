/**
 * REAL AWS (opt-in, see aws-gate.ts): IAM least privilege and KMS (CMK) enforcement of the
 * deployed mini-stack.
 *
 * IAM — method: `iam:SimulatePrincipalPolicy` (READ-ONLY) against the four DEPLOYED execution
 * roles, i.e. AWS's own policy evaluation of the policies (and permissions boundary, when one is
 * set) as deployed, with the request context the services send (`dynamodb:LeadingKeys`,
 * `kms:ViaService`). Chosen over real calls because the roles trust only lambda/states service
 * principals (they cannot be assumed by a test) and because a denied real call from a production
 * handler would need code that does not belong there. What the roles NEED is additionally proven
 * by real calls in every workflow/reconciler test (they would fail without it). Resource policies
 * are not part of a simulation; the CMK's key policy only delegates to IAM (account root), which
 * the KMS part below exercises for real.
 *
 * KMS — method: REAL calls by a principal WITHOUT a grant on the CMK: the test assumes the
 * mini-stack's TEST-ONLY `KeyProbeRole` (DynamoDB GetItem/DescribeTable on the job table, no KMS
 * permission at all) and shows that DynamoDB refuses to read an item of the CMK-encrypted table
 * and that KMS refuses direct use of the key, while the same item is readable by a principal with
 * the grant (positive control). Plus read-only proof that the tables, the execution history and
 * every log group are encrypted with the stack's CMK.
 *
 * The operator (the identity running these tests) holds no kms:* and no sts:AssumeRole of its
 * own: the mini-stack's key policy names its role (`-c operatorPrincipalArn`) for use via
 * DynamoDB, Step Functions and CloudWatch Logs plus key metadata, and the KeyProbeRole trust names
 * the same role. The operator's direct use of the key is therefore denied too (asserted).
 * Evidence: reports/aws-integration/evidence/iam-simulation.json, kms-*.json.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CloudWatchLogsClient, DescribeLogGroupsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { DescribeTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { IAMClient, SimulatePrincipalPolicyCommand, type ContextEntry } from '@aws-sdk/client-iam';
import {
  DescribeKeyCommand,
  GenerateDataKeyCommand,
  GetKeyRotationStatusCommand,
  KMSClient,
} from '@aws-sdk/client-kms';
import { DescribeStateMachineCommand } from '@aws-sdk/client-sfn';
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import {
  JobStateTable,
  executionNameFor,
  idempotencyKey,
  jobStateKey,
} from '@starter/workflow-processing';
import { VALID_DOCUMENT, anExecutionInput } from '@starter/testing';
import { resolveAwsGate } from './aws-gate.js';
import {
  LiveHarness,
  emulatorNotApplicable,
  maskAccountIds,
  recordEvidence,
  titled,
  onAws,
  suiteTitle,
} from './live-harness.js';

const gate = await resolveAwsGate(process.env);
const title = gate.enabled
  ? suiteTitle('IAM and KMS')
  : `${suiteTitle('IAM and KMS')} [SKIPPED: ${gate.reason}]`;

type Decision = 'allowed' | 'denied';
interface SimCase {
  role: 'validator' | 'processor' | 'reconciler' | 'stateMachine' | 'keyProbe';
  actions: string[];
  resource: string;
  context?: ContextEntry[];
  expect: Decision;
  why: string;
}

/** ARN parts of the deployed state machine: arn:<partition>:states:<region>:<account>:stateMachine:<name>. */
function arnParts(stateMachineArn: string) {
  const [, partition, , region, account, , name] = stateMachineArn.split(':');
  if (!partition || !region || !account || !name) throw new Error('unexpected state machine ARN');
  return { partition, region, account, name };
}

describe.skipIf(!gate.enabled)(title, () => {
  let h: LiveHarness;
  let iam: IAMClient;
  let kms: KMSClient;
  let logs: CloudWatchLogsClient;
  let rawDdb: DynamoDBClient;

  beforeAll(async () => {
    if (!gate.enabled) return;
    h = await LiveHarness.create(gate);
    iam = new IAMClient({ region: gate.region });
    kms = new KMSClient({ region: gate.region });
    logs = new CloudWatchLogsClient({ region: gate.region });
    rawDdb = new DynamoDBClient({ region: gate.region });
  });
  afterAll(() => {
    h?.destroy();
    iam?.destroy();
    kms?.destroy();
    logs?.destroy();
    rawDdb?.destroy();
  });

  it.skipIf(emulatorNotApplicable('iamNotEnforced') !== undefined)(
    titled(
      'IAM: the deployed roles are allowed what they need and denied what they must not (SimulatePrincipalPolicy)',
      'iamNotEnforced',
    ),
    async () => {
      const {
        partition: p,
        region: r,
        account,
        name: machineName,
      } = arnParts(h.outputs.stateMachineArn);
      const roles = {
        validator: h.output('validatorRoleArn'),
        processor: h.output('processorRoleArn'),
        reconciler: h.output('reconcilerRoleArn'),
        stateMachine: h.output('stateMachineRoleArn'),
        keyProbe: h.output('keyProbeRoleArn'),
      };
      const keyArn = h.output('keyArn');
      const jobTable = `arn:${p}:dynamodb:${r}:${account}:table/${h.outputs.tableName}`;
      const statusIndex = `${jobTable}/index/${JobStateTable.statusIndex.name}`;
      const docsTable = `arn:${p}:dynamodb:${r}:${account}:table/${h.outputs.documentsTableName}`;
      const fn = (name: string) => `arn:${p}:lambda:${r}:${account}:function:${name}`;
      const logStream = (group: string) =>
        `arn:${p}:logs:${r}:${account}:log-group:${group}:log-stream:probe`;
      const ownExecution = `arn:${p}:states:${r}:${account}:execution:${machineName}:${executionNameFor(randomUUID())}`;
      const foreignExecution = `arn:${p}:states:${r}:${account}:execution:another-machine:probe`;
      const jobKey: ContextEntry[] = [
        {
          ContextKeyName: 'dynamodb:LeadingKeys',
          ContextKeyType: 'stringList',
          ContextKeyValues: [jobStateKey(randomUUID()).pk],
        },
      ];
      const idempotencyKeyCtx: ContextEntry[] = [
        {
          ContextKeyName: 'dynamodb:LeadingKeys',
          ContextKeyType: 'stringList',
          ContextKeyValues: [idempotencyKey('probe').pk],
        },
      ];
      const requestedRegion: ContextEntry = {
        ContextKeyName: 'aws:RequestedRegion',
        ContextKeyType: 'string',
        ContextKeyValues: [r],
      };
      const viaDynamo: ContextEntry[] = [
        {
          ContextKeyName: 'kms:ViaService',
          ContextKeyType: 'string',
          ContextKeyValues: [`dynamodb.${r}.amazonaws.com`],
        },
      ];

      const handlerCases = (role: 'validator' | 'processor'): SimCase[] => {
        const ownLogs = h.output(
          role === 'validator' ? 'validatorLogGroupName' : 'processorLogGroupName',
        );
        const otherAlias = h.output(
          role === 'validator' ? 'processorAliasArn' : 'validatorAliasArn',
        );
        return [
          {
            role,
            actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem'],
            resource: jobTable,
            context: jobKey,
            expect: 'allowed',
            why: 'job state, step audit and result on JOB# items',
          },
          {
            role,
            actions: ['dynamodb:GetItem'],
            resource: docsTable,
            expect: 'allowed',
            why: 'TEST-ONLY document read (claim check)',
          },
          {
            role,
            actions: ['kms:Decrypt', 'kms:GenerateDataKey'],
            resource: keyArn,
            context: viaDynamo,
            expect: 'allowed',
            why: 'CMK of the tables, only via DynamoDB',
          },
          {
            role,
            actions: ['logs:PutLogEvents'],
            resource: logStream(ownLogs),
            expect: 'allowed',
            why: 'own log group',
          },
          {
            role,
            actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem'],
            resource: jobTable,
            context: idempotencyKeyCtx,
            expect: 'denied',
            why: 'idempotency records belong to the API',
          },
          {
            role,
            actions: ['dynamodb:DeleteItem', 'dynamodb:BatchWriteItem', 'dynamodb:Query'],
            resource: jobTable,
            context: jobKey,
            expect: 'denied',
            why: 'no delete, batch or query',
          },
          {
            role,
            actions: ['dynamodb:Scan', 'dynamodb:DeleteTable', 'dynamodb:UpdateTable'],
            resource: jobTable,
            expect: 'denied',
            why: 'no table-wide access',
          },
          {
            role,
            actions: ['dynamodb:PutItem', 'dynamodb:DeleteItem'],
            resource: docsTable,
            expect: 'denied',
            why: 'documents are read-only',
          },
          {
            role,
            actions: ['kms:Decrypt', 'kms:GenerateDataKey'],
            resource: keyArn,
            expect: 'denied',
            why: 'no direct use of the CMK (kms:ViaService)',
          },
          {
            role,
            actions: ['kms:CreateGrant', 'kms:ScheduleKeyDeletion', 'kms:PutKeyPolicy'],
            resource: keyArn,
            expect: 'denied',
            why: 'no key administration',
          },
          {
            role,
            actions: ['states:StartExecution'],
            resource: h.outputs.stateMachineArn,
            expect: 'denied',
            why: 'steps never start workflows',
          },
          {
            role,
            actions: ['lambda:InvokeFunction'],
            resource: otherAlias,
            expect: 'denied',
            why: 'no function-to-function calls',
          },
          {
            role,
            actions: ['logs:PutLogEvents'],
            resource: logStream(h.output('reconcilerLogGroupName')),
            expect: 'denied',
            why: 'only its own log group',
          },
        ];
      };

      const cases: SimCase[] = [
        ...handlerCases('validator'),
        ...handlerCases('processor'),
        // Reconciler (ADR 0231)
        {
          role: 'reconciler',
          actions: ['dynamodb:Query'],
          resource: statusIndex,
          expect: 'allowed',
          why: 'stale candidates from the status index',
        },
        {
          role: 'reconciler',
          actions: ['dynamodb:GetItem', 'dynamodb:UpdateItem'],
          resource: jobTable,
          context: jobKey,
          expect: 'allowed',
          why: 'consistent read + conditional transition of JOB# items',
        },
        {
          role: 'reconciler',
          actions: ['states:DescribeExecution'],
          resource: ownExecution,
          expect: 'allowed',
          why: 'authoritative execution state (METADATA_ONLY)',
        },
        {
          role: 'reconciler',
          actions: ['kms:Decrypt'],
          resource: keyArn,
          context: viaDynamo,
          expect: 'allowed',
          why: 'job table CMK via DynamoDB',
        },
        {
          role: 'reconciler',
          actions: ['states:StartExecution'],
          resource: h.outputs.stateMachineArn,
          expect: 'denied',
          why: 'never (re)starts a workflow (ADR 0231)',
        },
        {
          role: 'reconciler',
          actions: ['states:StopExecution', 'states:RedriveExecution'],
          resource: ownExecution,
          expect: 'denied',
          why: 'never stops or redrives an execution (ADR 0231)',
        },
        {
          role: 'reconciler',
          actions: ['states:DescribeExecution'],
          resource: foreignExecution,
          expect: 'denied',
          why: 'only its own state machine',
        },
        {
          role: 'reconciler',
          actions: ['states:GetExecutionHistory'],
          resource: ownExecution,
          expect: 'denied',
          why: 'no execution data',
        },
        {
          role: 'reconciler',
          actions: ['kms:Decrypt'],
          resource: keyArn,
          expect: 'denied',
          why: 'no decrypt of the CMK-encrypted execution (METADATA_ONLY needs none)',
        },
        {
          role: 'reconciler',
          actions: ['dynamodb:Query', 'dynamodb:Scan'],
          resource: jobTable,
          expect: 'denied',
          why: 'no base-table query or scan',
        },
        {
          role: 'reconciler',
          actions: ['dynamodb:PutItem', 'dynamodb:DeleteItem'],
          resource: jobTable,
          context: jobKey,
          expect: 'denied',
          why: 'no put/delete',
        },
        {
          role: 'reconciler',
          actions: ['dynamodb:UpdateItem'],
          resource: jobTable,
          context: idempotencyKeyCtx,
          expect: 'denied',
          why: 'JOB# items only',
        },
        // State machine
        {
          role: 'stateMachine',
          actions: ['lambda:InvokeFunction'],
          resource: h.output('validatorAliasArn'),
          expect: 'allowed',
          why: 'ValidateJob invokes the live alias',
        },
        {
          role: 'stateMachine',
          actions: ['lambda:InvokeFunction'],
          resource: h.output('processorAliasArn'),
          expect: 'allowed',
          why: 'ProcessJob invokes the live alias',
        },
        {
          role: 'stateMachine',
          actions: ['dynamodb:UpdateItem'],
          resource: jobTable,
          expect: 'allowed',
          why: 'RecordSuccess / RecordFailure (native integration)',
        },
        {
          role: 'stateMachine',
          actions: ['kms:GenerateDataKey', 'kms:Decrypt'],
          resource: keyArn,
          context: viaDynamo,
          expect: 'allowed',
          why: 'job table CMK via DynamoDB',
        },
        {
          role: 'stateMachine',
          actions: ['lambda:InvokeFunction'],
          resource: fn(h.output('validatorFunctionName')),
          expect: 'denied',
          why: 'never the unpublished $LATEST',
        },
        {
          role: 'stateMachine',
          actions: ['lambda:InvokeFunction'],
          resource: fn(h.outputs.reconcilerFunctionName ?? 'reconciler'),
          expect: 'denied',
          why: 'only the two step functions',
        },
        {
          role: 'stateMachine',
          actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:DeleteItem', 'dynamodb:Scan'],
          resource: jobTable,
          expect: 'denied',
          why: 'UpdateItem only',
        },
        {
          role: 'stateMachine',
          actions: ['dynamodb:GetItem'],
          resource: docsTable,
          expect: 'denied',
          why: 'the workflow never reads documents (claim check)',
        },
        {
          role: 'stateMachine',
          actions: ['states:StartExecution'],
          resource: h.outputs.stateMachineArn,
          expect: 'denied',
          why: 'no recursion',
        },
        // KMS probe (identity side of the real-call test below)
        {
          role: 'keyProbe',
          actions: ['dynamodb:GetItem', 'dynamodb:DescribeTable'],
          resource: jobTable,
          expect: 'allowed',
          why: 'IAM lets the probe read the table',
        },
        {
          role: 'keyProbe',
          actions: ['kms:Decrypt', 'kms:GenerateDataKey', 'kms:DescribeKey'],
          resource: keyArn,
          context: viaDynamo,
          expect: 'denied',
          why: 'no grant on the CMK at all',
        },
      ];

      const results: Record<string, unknown>[] = [];
      for (const c of cases) {
        const out = await iam.send(
          new SimulatePrincipalPolicyCommand({
            PolicySourceArn: roles[c.role],
            ActionNames: c.actions,
            ResourceArns: [c.resource],
            // The region every real call carries (keeps region-scoped SCP conditions realistic).
            ContextEntries: [requestedRegion, ...(c.context ?? [])],
          }),
        );
        for (const action of c.actions) {
          const r0 = out.EvaluationResults?.find((e) => e.EvalActionName === action);
          const decision = r0?.EvalDecision ?? 'missing';
          results.push({
            role: c.role,
            action,
            resource: c.resource,
            context: c.context?.map(
              (e) => `${e.ContextKeyName}=${(e.ContextKeyValues ?? []).join(',')}`,
            ),
            expected: c.expect,
            evalDecision: decision,
            ok:
              c.expect === 'allowed'
                ? decision === 'allowed'
                : decision !== 'allowed' && decision !== 'missing',
            why: c.why,
          });
        }
      }
      recordEvidence('iam-simulation', {
        method: 'iam:SimulatePrincipalPolicy (read-only) on the deployed roles',
        roles,
        boundary: process.env.AWS_INTEGRATION_PERMISSIONS_BOUNDARY_ARN ? 'set' : 'none',
        total: results.length,
        failures: results.filter((x) => !x.ok).length,
        results,
      });
      expect(results.filter((x) => !x.ok)).toEqual([]);
    },
  );

  it.skipIf(emulatorNotApplicable('kmsNotEnforced') !== undefined)(
    titled(
      'KMS: tables, execution history and every log group use the stack CMK (rotation on)',
      'kmsNotEnforced',
    ),
    async () => {
      const keyArn = h.output('keyArn');
      const tables: Record<string, unknown> = {};
      for (const name of [h.outputs.tableName, h.outputs.documentsTableName]) {
        const t = await rawDdb.send(new DescribeTableCommand({ TableName: name }));
        tables[name] = t.Table?.SSEDescription;
      }
      const machine = await h.sfn.send(
        new DescribeStateMachineCommand({ stateMachineArn: h.outputs.stateMachineArn }),
      );
      const groupNames = [
        h.output('stateMachineLogGroupName'),
        h.output('validatorLogGroupName'),
        h.output('processorLogGroupName'),
        h.output('reconcilerLogGroupName'),
      ];
      const groups: Record<string, unknown> = {};
      for (const name of groupNames) {
        const out = await logs.send(new DescribeLogGroupsCommand({ logGroupNamePrefix: name }));
        const g = out.logGroups?.find((x) => x.logGroupName === name);
        groups[name] = { kmsKeyId: g?.kmsKeyId, retentionInDays: g?.retentionInDays };
      }
      const key = await kms.send(new DescribeKeyCommand({ KeyId: keyArn }));
      const rotation = await kms.send(new GetKeyRotationStatusCommand({ KeyId: keyArn }));
      // The operator's grant is scoped to use THROUGH the data services: direct use is refused.
      let operatorDirectUse: { allowed: boolean; errorName?: string };
      try {
        await kms.send(new GenerateDataKeyCommand({ KeyId: keyArn, KeySpec: 'AES_256' }));
        operatorDirectUse = { allowed: true };
      } catch (error) {
        operatorDirectUse = { allowed: false, errorName: (error as Error).name };
      }
      recordEvidence('kms-cmk-in-use', {
        keyArn,
        key: {
          keyState: key.KeyMetadata?.KeyState,
          keyManager: key.KeyMetadata?.KeyManager,
          keySpec: key.KeyMetadata?.KeySpec,
          rotationEnabled: rotation.KeyRotationEnabled,
        },
        tables,
        stateMachineEncryption: machine.encryptionConfiguration,
        logGroups: groups,
        operatorDirectGenerateDataKey: operatorDirectUse,
      });

      for (const sse of Object.values(tables)) {
        expect(sse).toMatchObject({ Status: 'ENABLED', SSEType: 'KMS', KMSMasterKeyArn: keyArn });
      }
      expect(machine.encryptionConfiguration?.type).toBe('CUSTOMER_MANAGED_KMS_KEY');
      // Reported as configured (key ARN); accept the bare key id as well.
      const smKey = String(machine.encryptionConfiguration?.kmsKeyId);
      expect(smKey === keyArn || keyArn.endsWith(`/${smKey}`)).toBe(true);
      for (const g of Object.values(groups)) {
        expect(g).toEqual({ kmsKeyId: keyArn, retentionInDays: 1 });
      }
      expect(key.KeyMetadata).toMatchObject({ KeyState: 'Enabled', KeyManager: 'CUSTOMER' });
      expect(rotation.KeyRotationEnabled).toBe(true);
      expect(operatorDirectUse).toEqual({ allowed: false, errorName: 'AccessDeniedException' });
    },
  );

  it.skipIf(emulatorNotApplicable('kmsNotEnforced') !== undefined)(
    titled(
      `KMS: a principal with DynamoDB read but no CMK grant cannot read the encrypted table or use the key${onAws(' (real calls)')}`,
      'kmsNotEnforced',
    ),
    async () => {
      // Positive control: an item the operator (with the grant) can read.
      const input = anExecutionInput({ submittedAt: new Date().toISOString() });
      await h.seed(input, { title: 'kms probe', content: VALID_DOCUMENT });
      const readable = await h.stateItem(input.jobId);

      const sts = new STSClient({ region: gate.enabled ? gate.region : 'ap-southeast-1' });
      const assumed = await sts.send(
        new AssumeRoleCommand({
          RoleArn: h.assertRunTarget(h.output('keyProbeRoleArn'), 'KeyProbeRole'),
          // The only session name the KeyProbeRole trust accepts (KEY_PROBE_SESSION_NAME in the stack).
          RoleSessionName: 'starter-it-kms-probe',
          DurationSeconds: 900,
        }),
      );
      sts.destroy();
      const c = assumed.Credentials;
      if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken) {
        throw new Error('AssumeRole returned no credentials');
      }
      const credentials = {
        accessKeyId: c.AccessKeyId,
        secretAccessKey: c.SecretAccessKey,
        sessionToken: c.SessionToken,
      };
      const region = h.region;
      const probeRaw = new DynamoDBClient({ region, credentials, maxAttempts: 1 });
      const probeDdb = DynamoDBDocumentClient.from(probeRaw);
      const probeKms = new KMSClient({ region, credentials, maxAttempts: 1 });
      const outcome = async (call: () => Promise<unknown>) => {
        try {
          await call();
          return { allowed: true } as const;
        } catch (error) {
          const e = error as { name?: string; message?: string };
          return {
            allowed: false,
            errorName: e.name ?? 'Error',
            // Masked and truncated: the message names the assumed role and the key.
            message: maskAccountIds(String(e.message ?? '')).slice(0, 400),
          } as const;
        }
      };
      try {
        const describe = await outcome(() =>
          probeRaw.send(new DescribeTableCommand({ TableName: h.outputs.tableName })),
        );
        const getItem = await outcome(() =>
          probeDdb.send(
            new GetCommand({
              TableName: h.outputs.tableName,
              Key: jobStateKey(input.jobId),
              ConsistentRead: true,
            }),
          ),
        );
        const generateDataKey = await outcome(() =>
          probeKms.send(
            new GenerateDataKeyCommand({ KeyId: h.output('keyArn'), KeySpec: 'AES_256' }),
          ),
        );
        const describeKey = await outcome(() =>
          probeKms.send(new DescribeKeyCommand({ KeyId: h.output('keyArn') })),
        );
        recordEvidence('kms-no-grant-denied', {
          method:
            'real calls with STS credentials of KeyProbeRole (no KMS permission, no key-policy grant)',
          positiveControl: {
            principal: 'operator (has the grant)',
            itemReadable: readable !== undefined,
          },
          probe: { describeTable: describe, getItem, generateDataKey, describeKey },
        });

        expect(readable).toBeDefined();
        // IAM lets the probe at the table (metadata needs no key) ...
        expect(describe.allowed).toBe(true);
        // ... but the item cannot be decrypted without a grant on the CMK ...
        expect(getItem.allowed).toBe(false);
        if (!getItem.allowed) {
          expect(getItem.errorName).toMatch(/AccessDenied|KMS/i);
          expect(`${getItem.errorName} ${getItem.message}`).toMatch(/kms/i);
        }
        // ... and the key cannot be used or even described directly.
        expect(generateDataKey).toMatchObject({
          allowed: false,
          errorName: 'AccessDeniedException',
        });
        expect(describeKey).toMatchObject({ allowed: false, errorName: 'AccessDeniedException' });
      } finally {
        probeRaw.destroy();
        probeKms.destroy();
      }
    },
  );
});
