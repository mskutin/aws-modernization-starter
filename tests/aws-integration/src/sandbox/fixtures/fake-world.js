#!/usr/bin/env node
/**
 * A fake AWS sandbox for the offline self-test of tests/aws-integration/sandbox/*.sh.
 *
 *   node fake-world.js <tool> [args…]     tool: aws | pnpm | skopeo | cosign | podman | finops |
 *                                         issuer-tool | smoke
 *
 * State lives in $FAKE_STATE (JSON, read-modify-write per call; the scripts call tools one at a
 * time), every call is appended to $FAKE_LOG as `CALL <tool> <args>`. It answers exactly the calls
 * the scripts make (including the `--query` shapes they use) and fails loudly on anything else, so
 * a new AWS call in a script must be added here deliberately. No network, no credentials.
 *
 * Knobs (env): FAKE_FAIL_DEPLOY=<Stack> (cdk deploy of that stack fails), FAKE_CI_IMAGE=ok|missing,
 * FAKE_ROLLBACK=auto|none, FAKE_TASK_EXIT_<NAME>=<code> (e.g. FAKE_TASK_EXIT_DB_MIGRATE=1),
 * FAKE_E2E=pass|fail, FAKE_E2E_OFFLINE=pass|fail (the offline aws-auth check),
 * FAKE_FINOPS_UNVERIFIABLE=1 (verify-clean exit 5), FAKE_HEAD=<git sha the CI image claims>.
 */
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

const [, , tool, ...argv] = process.argv;
const env = process.env;
const ACCOUNT = '111122223333';
const REGION = 'ap-southeast-1';
const PREFIX = 'starter-sbx';

appendFileSync(env.FAKE_LOG, `CALL ${tool} ${argv.join(' ')}\n`);

const load = () =>
  existsSync(env.FAKE_STATE)
    ? JSON.parse(readFileSync(env.FAKE_STATE, 'utf8'))
    : {
        toolkit: null,
        retainedBucket: null,
        stacks: {},
        secret: null,
        ecrImages: [],
        taskDefs: {},
        service: null,
        tasks: {},
        logGroups: [],
        keys: {},
        seq: 0,
        retainedRepo: false,
        // The account is shared: resources of others that must survive untouched.
        foreign: {
          stacks: {
            CDKToolkit: { status: 'UPDATE_COMPLETE', tags: {} },
            'Sandbox-Reports': { status: 'CREATE_COMPLETE', tags: { Owner: 'other-team' } },
            'OtherTeam-Api': { status: 'CREATE_COMPLETE', tags: { 'starter:run-id': 'it-aaaaaa' } },
          },
          logGroups: [
            '/aws/lambda/Sandbox-Reports-Handler-xyz',
            '/aws/rds/instance/other-db/postgresql',
            '/aws/ecs/containerinsights/other-cluster/performance',
            '/starter/starter-dev/ecs/api',
          ],
          taskDefs: ['arn:aws:ecs:ap-southeast-1:111122223333:task-definition/other-api:3'],
        },
        foreignTouched: [],
      };
const state = load();
// Atomic replace: fake tools run concurrently (e.g. `aws … | skopeo login`), and a reader must
// never see a half-written state file.
const save = () => {
  const tmp = `${env.FAKE_STATE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, env.FAKE_STATE);
};

const out = (v) => {
  process.stdout.write(typeof v === 'string' ? `${v}\n` : `${JSON.stringify(v)}\n`);
  return 0;
};
function fail(message, code = 254) {
  process.stderr.write(`${message}\n`);
  save();
  process.exit(code);
}
const opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (name) => argv.includes(name);
const query = () => opt('--query') ?? '';
const sha = (s) => `sha256:${createHash('sha256').update(s).digest('hex')}`;
const tdArn = (family, rev) => `arn:aws:ecs:${REGION}:${ACCOUNT}:task-definition/${family}:${rev}`;
const repoUri = `${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/${PREFIX}-api`;

const OUTPUTS = {
  Foundation: {
    VpcId: 'vpc-1',
    DataKeyArn: `arn:aws:kms:${REGION}:${ACCOUNT}:key/k-data`,
    LogsKeyArn: `arn:aws:kms:${REGION}:${ACCOUNT}:key/k-logs`,
  },
  TestIssuer: {
    IssuerUrl: 'https://issuer.sbx.example',
    IssuerBucketName: 'issuer-bucket',
    IssuerDistributionId: 'EISSUER',
  },
  Platform: { ClusterName: PREFIX, ApiRepositoryName: `${PREFIX}-api`, ApiRepositoryUri: repoUri },
  Data: {
    DbEndpoint: 'db.sbx.example',
    DbMasterSecretArn: 'arn:secret',
    JobTableName: `${PREFIX}-jobs`,
  },
  Workflow: {
    StateMachineArn: `arn:aws:states:${REGION}:${ACCOUNT}:stateMachine:${PREFIX}-processing`,
    ValidatorFunctionName: `${PREFIX}-validator`,
    ProcessorFunctionName: `${PREFIX}-processor`,
    ReconcilerFunctionName: `${PREFIX}-reconciler`,
  },
  Migrations: {
    BootstrapTaskDefinitionArn: tdArn(`${PREFIX}-db-bootstrap`, 1),
    MigrationTaskDefinitionArn: tdArn(`${PREFIX}-db-migrate`, 1),
    TaskSubnetIds: 'subnet-a,subnet-b',
    TaskSecurityGroupId: 'sg-task',
    BootstrapSecurityGroupId: 'sg-bootstrap',
  },
  Api: {
    ServiceName: `${PREFIX}-api`,
    TaskDefinitionFamily: `${PREFIX}-api`,
    AlbDnsName: 'alb.sbx.example',
    ApiLogGroupName: `/starter/${PREFIX}/ecs/api`,
  },
  Frontend: {
    DistributionDomainName: 'dweb.cloudfront.example',
    DistributionId: 'EWEB',
    WebBucketName: 'web-bucket',
  },
  Observability: { AlarmTopicArn: 'arn:sns' },
};
const DB_INSTANCE = 'sandbox-data-dbinstance-abc123';
const STACK_RESOURCES = {
  Foundation: { 'AWS::KMS::Key': ['k-data', 'k-logs'], 'AWS::EC2::VPC': ['vpc-1'] },
  TestIssuer: { 'AWS::S3::Bucket': ['issuer-bucket'] },
  Platform: {
    'AWS::ECR::Repository': [`${PREFIX}-api`],
    'AWS::ECS::Cluster': [`${PREFIX}-cluster`],
  },
  Data: { 'AWS::RDS::DBInstance': [DB_INSTANCE], 'AWS::DynamoDB::Table': [`${PREFIX}-jobs`] },
  Workflow: {
    'AWS::Lambda::Function': [`${PREFIX}-validator`, `${PREFIX}-processor`],
    'AWS::Logs::LogGroup': [`/starter/${PREFIX}/lambda/validator`],
  },
  Migrations: {
    'AWS::ECS::TaskDefinition': [
      tdArn(`${PREFIX}-db-bootstrap`, 1),
      tdArn(`${PREFIX}-db-migrate`, 1),
    ],
  },
  Api: {
    'AWS::ECS::TaskDefinition': [tdArn(`${PREFIX}-api`, 1)],
    'AWS::Logs::LogGroup': [`/starter/${PREFIX}/ecs/api`],
  },
  Frontend: {
    'AWS::S3::Bucket': ['web-bucket'],
    'AWS::Lambda::Function': ['Sandbox-Frontend-CustomS3AutoDelete-abc'],
  },
  Observability: {},
};

function addTaskDef(family, image, extra = {}) {
  const revs = Object.values(state.taskDefs).filter((t) => t.family === family).length;
  const arn = tdArn(family, revs + 1);
  state.taskDefs[arn] = { arn, family, image, status: 'ACTIVE', ...extra };
  return arn;
}

// ── pnpm: cdk, builds, test runners ─────────────────────────────────────────────────────────
function pnpm() {
  const joined = argv.join(' ');
  const ci = argv.indexOf('cdk');
  if (argv[ci - 1] === 'exec' && ci >= 0) return cdk(argv.slice(ci + 1));
  if (joined.includes('exec vitest run')) {
    const file = argv.find((a) => a.startsWith('--outputFile.json='))?.split('=')[1];
    const rate = argv.includes('src/suites/rate-limit.test.ts');
    if (!rate && !argv.includes('**/rate-limit.test.ts'))
      return fail('fake vitest: the main security run must exclude the rate-limit suite', 99);
    const tests = rate
      ? [
          { fullName: 'rate limits per-principal read limit', status: 'passed' },
          { fullName: 'rate limits failed authentications', status: 'skipped' },
        ]
      : [
          { fullName: 'authentication positive control', status: 'passed' },
          { fullName: 'leakage DynamoDB: no item contains document data', status: 'passed' },
          { fullName: 'jwks rotation [skipped: self-started harness only]', status: 'skipped' },
        ];
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({
        testResults: [{ name: 'suite.test.ts', status: 'passed', assertionResults: tests }],
      }),
    );
    appendFileSync(
      env.FAKE_LOG,
      `ENV SECTEST ${['WEB_BASE_URL', 'API_BASE_URL', 'TEST_IDP_URL', 'AUTH_AUDIENCE', 'JOBS_TABLE_NAME', 'SECTEST_DYNAMODB_AWS', 'SECTEST_LOG_FILES', 'SECTEST_KNOWN_SECRET_FILES', 'SECTEST_MAX_TOKEN_AGE_SECONDS'].map((k) => `${k}=${env[k] ?? ''}`).join(' ')}\n`,
    );
    return 0;
  }
  if (joined.includes('run test:aws-auth-offline')) {
    // The offline routing check (Chromium + openssl, no AWS, no E2E_* needed).
    if (env.E2E_AUTH_MODE || env.WEB_BASE_URL)
      return fail('fake pnpm: the offline check got live E2E settings', 2);
    return (env.FAKE_E2E_OFFLINE ?? 'pass') === 'pass'
      ? 0
      : fail('fake aws-auth offline: 1 failed', 1);
  }
  if (joined.includes('exec playwright test')) {
    const ok = (env.FAKE_E2E ?? 'pass') === 'pass';
    writeFileSync(
      env.PLAYWRIGHT_JSON_OUTPUT_NAME,
      JSON.stringify({
        suites: [
          {
            title: 'jobs.spec.ts',
            specs: [
              {
                title: 'submit → SUCCEEDED',
                tests: [
                  {
                    status: ok ? 'expected' : 'unexpected',
                    results: [{ error: ok ? undefined : { message: 'timeout' } }],
                  },
                ],
              },
            ],
          },
        ],
        errors: [],
      }),
    );
    appendFileSync(
      env.FAKE_LOG,
      `ENV E2E ${['E2E_AUTH_MODE', 'E2E_ISSUER', 'E2E_IDP_URL', 'WEB_BASE_URL'].map((k) => `${k}=${env[k] ?? ''}`).join(' ')}\n`,
    );
    return ok ? 0 : 1;
  }
  if (/run build$/.test(joined)) return 0;
  return fail(`fake pnpm: unexpected ${joined}`, 99);
}

function context() {
  const ctx = {};
  argv.forEach((a, i) => {
    if (a === '-c' || a === '--context') {
      const [k, ...v] = String(argv[i + 1]).split('=');
      ctx[k] = v.join('=');
    }
  });
  return ctx;
}

function cdk(args) {
  const [sub, target] = args;
  if (sub === 'bootstrap') {
    if (!target?.startsWith(`aws://${ACCOUNT}/`))
      return fail('fake cdk bootstrap: wrong environment', 1);
    // Runs with the operator's own credentials: no KMS key (kms:CreateKey denied), no tags
    // (ecr:TagResource / ssm:AddTagsToResource not granted), never the default toolkit.
    for (const banned of ['--tags', '--bootstrap-customer-key', '--bootstrap-kms-key-id']) {
      if (has(banned))
        return fail(`fake cdk bootstrap: ${banned} needs permissions the operator lacks`, 1);
    }
    if (opt('--toolkit-stack-name') !== 'starter-cdk-toolkit' || opt('--qualifier') !== 'starter') {
      return fail('fake cdk bootstrap: not the starter toolkit', 1);
    }
    state.toolkit = {
      status: 'CREATE_COMPLETE',
      version: '32',
      bucket: `cdk-starter-assets-${ACCOUNT}-${REGION}`,
      repo: `cdk-starter-container-assets-${ACCOUNT}-${REGION}`,
    };
    save();
    return 0;
  }
  const ctx = { ...context() };
  const stack = String(target).replace(/^Sandbox\//, '');
  if (!OUTPUTS[stack] || !has('--exclusively')) return fail(`fake cdk: bad target ${target}`, 99);
  if (ctx['account.sandbox'] !== ACCOUNT || ctx.envs !== 'sandbox')
    return fail('fake cdk: wrong account/envs context', 1);
  if (!new RegExp(`^arn:aws:iam::${ACCOUNT}:role/`).test(ctx.operatorPrincipalArn ?? '')) {
    return fail('fake cdk: no -c operatorPrincipalArn=<operator role ARN>', 1);
  }
  if (!state.toolkit)
    return fail(
      'fake cdk: not bootstrapped (SSM parameter /cdk-bootstrap/starter/version not found)',
      1,
    );
  const name = `Sandbox-${stack}`;
  if (ctx.originVerifySecret)
    return fail('fake cdk: the origin-verify value must come from a file, not argv', 1);
  if (sub === 'deploy') {
    // Like the real app with -c requireDeployInputs=true: no placeholder may reach a deploy.
    if (ctx.requireDeployInputs !== 'true')
      return fail('fake cdk: deploy without requireDeployInputs=true', 1);
    if (!/^sha256:[a-f0-9]{64}$/.test(ctx.apiImageDigest ?? ''))
      return fail('fake cdk: no apiImageDigest', 1);
    if (!/^sbx-[0-9a-f]{6}$/.test(ctx.runId ?? '') || !(Date.parse(ctx.expiresAt) > Date.now())) {
      return fail('fake cdk: run id / expiry', 1);
    }
    const file = ctx.originVerifySecretFile;
    if (!file || !existsSync(file) || (statSync(file).mode & 0o077) !== 0) {
      return fail('fake cdk: originVerifySecretFile missing or not 0600', 1);
    }
    const secret = readFileSync(file, 'utf8').trim();
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(secret))
      return fail('fake cdk: weak origin-verify value', 1);
    if (env.FAKE_FAIL_DEPLOY === stack) return fail(`fake cdk: ${name} failed: CREATE_FAILED`, 1);
    state.secret = secret;
    state.stacks[name] = {
      status: 'CREATE_COMPLETE',
      tags: {
        'starter:experiment': 'live-validation',
        'starter:run-id': ctx.runId,
        'starter:expires-at': ctx.expiresAt,
      },
      outputs: OUTPUTS[stack],
      deployedWith: { apiImageDigest: ctx.apiImageDigest ?? null },
    };
    if (stack === 'Migrations') {
      if (!ctx.apiImageDigest) return fail('fake cdk: Migrations needs apiImageDigest', 1);
      for (const f of ['db-bootstrap', 'db-migrate']) {
        const arn = tdArn(`${PREFIX}-${f}`, 1);
        state.taskDefs[arn] = {
          arn,
          family: `${PREFIX}-${f}`,
          image: `${repoUri}@${ctx.apiImageDigest}`,
          status: 'ACTIVE',
        };
      }
    }
    if (stack === 'Api') {
      if (!ctx.apiImageDigest) return fail('fake cdk: Api needs apiImageDigest', 1);
      const arn = addTaskDef(`${PREFIX}-api`, `${repoUri}@${ctx.apiImageDigest}`);
      state.service = {
        taskDefinition: arn,
        baseline: arn,
        desired: 1,
        running: 1,
        deployments: [{ status: 'PRIMARY', taskDefinition: arn, rolloutState: 'COMPLETED' }],
        ticks: 0,
        target: null,
      };
    }
    for (const g of {
      Api: [`/starter/${PREFIX}/ecs/api`],
      Workflow: [
        `/aws/vendedlogs/states/${PREFIX}-processing`,
        `/starter/${PREFIX}/lambda/validator`,
      ],
    }[stack] ?? []) {
      if (!state.logGroups.includes(g)) state.logGroups.push(g);
    }
    if (stack === 'Foundation') state.keys = { 'k-data': 'Enabled', 'k-logs': 'Enabled' };
    // Runtime-created groups CloudFormation will not delete.
    const runtime = {
      Data: [`/aws/rds/instance/${DB_INSTANCE}/postgresql`, `/aws/lambda/${PREFIX}-rds-rotation`],
      Platform: [`/aws/ecs/containerinsights/${PREFIX}-cluster/performance`],
      Workflow: [`/aws/lambda/${PREFIX}-validator`],
      Frontend: ['/aws/lambda/Sandbox-Frontend-CustomS3AutoDelete-abc'],
    }[stack];
    for (const g of runtime ?? []) if (!state.logGroups.includes(g)) state.logGroups.push(g);
    save();
    return 0;
  }
  if (sub === 'destroy') {
    if (!has('--force')) return fail('fake cdk destroy without --force would prompt', 99);
    deleteStack(name);
    save();
    return 0;
  }
  return fail(`fake cdk: unexpected ${sub}`, 99);
}

function deleteStack(name) {
  const stack = name.replace(/^Sandbox-/, '');
  delete state.stacks[name];
  if (stack === 'Api') {
    state.service = null;
    for (const t of Object.values(state.taskDefs))
      if (t.family === `${PREFIX}-api` && !t.external) t.status = 'INACTIVE';
    state.logGroups = state.logGroups.filter((g) => g !== `/starter/${PREFIX}/ecs/api`);
  }
  if (stack === 'Migrations')
    for (const t of Object.values(state.taskDefs))
      if (/db-(bootstrap|migrate)/.test(t.family)) t.status = 'INACTIVE';
  if (stack === 'Foundation')
    for (const k of Object.keys(state.keys)) state.keys[k] = 'PendingDeletion';
  if (stack === 'Platform') state.ecrImages = [];
}

// ── aws ──────────────────────────────────────────────────────────────────────────────────────
/** The operator's permission set: anything else answers AccessDenied (and is logged as DENIED). */
const PERMITTED = JSON.parse(
  readFileSync(new URL('./permission-set.json', import.meta.url), 'utf8'),
);
const permitted = (service, op) => {
  const p = PERMITTED[service];
  return p === '*' || (Array.isArray(p) && p.includes(op));
};

function stackJson(name) {
  const f = state.foreign?.stacks?.[name];
  if (f) {
    return {
      StackName: name,
      StackId: `arn:aws:cloudformation:${REGION}:${ACCOUNT}:stack/${name}/9`,
      StackStatus: f.status,
      Tags: Object.entries(f.tags).map(([Key, Value]) => ({ Key, Value })),
      Outputs: [],
    };
  }
  if (name === 'starter-cdk-toolkit' && state.toolkit) {
    return {
      StackName: name,
      StackId: `arn:aws:cloudformation:${REGION}:${ACCOUNT}:stack/${name}/1`,
      StackStatus: state.toolkit.status,
      Outputs: [
        { OutputKey: 'BucketName', OutputValue: state.toolkit.bucket },
        { OutputKey: 'ImageRepositoryName', OutputValue: state.toolkit.repo },
      ],
      Tags: [],
    };
  }
  const s = state.stacks[name];
  if (!s) return null;
  return {
    StackName: name,
    StackId: `arn:aws:cloudformation:${REGION}:${ACCOUNT}:stack/${name}/1`,
    StackStatus: s.status,
    EnableTerminationProtection: false,
    Tags: Object.entries(s.tags).map(([Key, Value]) => ({ Key, Value })),
    Outputs: Object.entries(s.outputs).map(([OutputKey, OutputValue]) => ({
      OutputKey,
      OutputValue,
    })),
  };
}

function cloudformation(op) {
  const q = query();
  const name = opt('--stack-name');
  if (op === 'describe-stacks') {
    if (!name) {
      const all = [
        ...(state.toolkit ? ['starter-cdk-toolkit'] : []),
        ...Object.keys(state.foreign?.stacks ?? {}),
        ...Object.keys(state.stacks),
      ].map(stackJson);
      if (q.includes("starts_with(StackName, 'starter-it-')"))
        return out(
          all
            .map((s) => s.StackName)
            .filter((n) => n.startsWith('starter-it-'))
            .join('\t'),
        );
      if (q) return fail(`fake aws: unexpected describe-stacks query ${q}`, 99);
      return out({ Stacks: all });
    }
    const s = stackJson(name);
    if (!s)
      return fail(
        `An error occurred (ValidationError) when calling the DescribeStacks operation: Stack with id ${name} does not exist`,
      );
    if (q === 'Stacks[0].StackStatus') return out(s.StackStatus);
    const m = /OutputKey=='(\w+)'/.exec(q);
    if (m) return out(s.Outputs.find((o) => o.OutputKey === m[1])?.OutputValue ?? 'None');
    if (q) return fail(`fake aws: unexpected describe-stacks query ${q}`, 99);
    return out({ Stacks: [s] });
  }
  if (op === 'describe-stack-resources') {
    if (state.foreign?.stacks?.[name]) {
      // Reading a foreign stack's resources is harmless, but our scripts have no reason to.
      state.foreignTouched.push(`describe-stack-resources ${name}`);
      save();
      return out('');
    }
    const s = state.stacks[name];
    if (!s) return fail(`Stack with id ${name} does not exist`);
    const resources = STACK_RESOURCES[name.replace(/^Sandbox-/, '')] ?? {};
    if (q === 'StackResources[].[ResourceType,PhysicalResourceId]') {
      return out(
        Object.entries(resources)
          .flatMap(([type, ids]) => ids.map((id) => `${type}\t${id}`))
          .join('\n'),
      );
    }
    const type = /ResourceType=='([^']+)'/.exec(q)?.[1];
    return out((resources[type] ?? []).join('\t'));
  }
  if (op === 'delete-stack') {
    if (state.foreign?.stacks?.[name]) {
      state.foreignTouched.push(`delete-stack ${name}`);
      save();
      return fail('fake: a FOREIGN stack was deleted', 97);
    }
    if (name === 'starter-cdk-toolkit') {
      state.retainedBucket = state.toolkit?.bucket ?? null;
      state.toolkit = null;
    } else deleteStack(name);
    save();
    return 0;
  }
  if (op === 'wait') return 0;
  return fail(`fake aws cloudformation ${op}`, 99);
}

function serviceSnapshot() {
  const s = state.service;
  if (!s) return { services: [] };
  if (s.target) {
    s.ticks += 1;
    const mode = env.FAKE_ROLLBACK ?? 'auto';
    if (mode === 'none' || s.ticks === 1) {
      s.taskDefinition = s.target;
      s.deployments = [
        {
          status: 'PRIMARY',
          taskDefinition: s.target,
          rolloutState: 'IN_PROGRESS',
          failedTasks: Math.min(s.ticks, 2),
        },
        { status: 'ACTIVE', taskDefinition: s.baseline, rolloutState: 'COMPLETED' },
      ];
    } else if (s.ticks === 2) {
      s.taskDefinition = s.baseline;
      s.deployments = [
        { status: 'PRIMARY', taskDefinition: s.baseline, rolloutState: 'IN_PROGRESS' },
        {
          status: 'ACTIVE',
          taskDefinition: s.target,
          rolloutState: 'FAILED',
          failedTasks: 3,
          rolloutStateReason: 'ECS deployment circuit breaker: tasks failed to start.',
        },
      ];
      s.events = [
        {
          createdAt: new Date().toISOString(),
          message: `(service ${PREFIX}-api) rolling back to deployment`,
        },
      ];
    } else {
      s.taskDefinition = s.baseline;
      s.deployments = [
        { status: 'PRIMARY', taskDefinition: s.baseline, rolloutState: 'COMPLETED' },
      ];
      s.target = null;
    }
  }
  return {
    services: [
      {
        serviceName: `${PREFIX}-api`,
        taskDefinition: s.taskDefinition,
        desiredCount: s.desired,
        runningCount: s.running,
        deployments: s.deployments,
        events: s.events ?? [],
      },
    ],
  };
}

function taskDefinitionJson(arn) {
  const t = state.taskDefs[arn];
  if (!t) return null;
  const isApi = t.family === `${PREFIX}-api`;
  return {
    taskDefinition: {
      taskDefinitionArn: arn,
      family: t.family,
      revision: Number(arn.split(':').pop()),
      status: t.status,
      cpu: '256',
      memory: '512',
      containerDefinitions: [
        {
          name: isApi ? 'api' : 'migrations',
          image: t.image,
          logConfiguration: {
            logDriver: 'awslogs',
            options: {
              'awslogs-group': `/starter/${PREFIX}/ecs/${isApi ? 'api' : 'migrations'}`,
              'awslogs-stream-prefix': isApi ? 'api' : 'migrations',
            },
          },
          environment: [
            { name: 'AUTH_MAX_TOKEN_AGE_SECONDS', value: '3600' },
            { name: 'RATE_LIMIT_UNAUTHENTICATED_MAX', value: '200' },
          ],
        },
      ],
      registeredAt: 'x',
      requiresAttributes: [],
    },
    tags: [{ key: 'starter:run-id', value: 'sbx' }],
  };
}

function probeEvents(runId) {
  const lines = JSON.parse(readFileSync(env.FAKE_PROBE_LINES, 'utf8'));
  return lines.map((l, i) => ({
    eventId: `p${i}`,
    timestamp: Date.now(),
    message: l.replaceAll('__RUN__', runId),
  }));
}

function ecs(op) {
  if (op === 'run-task') {
    const startedBy = opt('--started-by');
    const name = startedBy.replace(/^sbx-[0-9a-f]{6}-/, '');
    state.seq += 1;
    const arn = `arn:aws:ecs:${REGION}:${ACCOUNT}:task/${PREFIX}/${name}-${state.seq}`;
    let probeRunId = null;
    const o = opt('--overrides');
    if (o) {
      const overrides = JSON.parse(readFileSync(o.replace(/^file:\/\//, ''), 'utf8'));
      probeRunId =
        overrides.containerOverrides[0].environment.find((e) => e.name === 'PROBE_RUN_ID')?.value ??
        null;
    }
    const code = env[`FAKE_TASK_EXIT_${name.toUpperCase().replace(/-/g, '_')}`] ?? '0';
    const sg =
      /securityGroups=\[([^\]]*)\]/.exec(opt('--network-configuration') ?? '')?.[1] ?? null;
    state.tasks[arn] = {
      name,
      td: opt('--task-definition'),
      exitCode: Number(code),
      probeRunId,
      sg,
    };
    save();
    return out({ tasks: [{ taskArn: arn }], failures: [] });
  }
  if (op === 'describe-tasks') {
    const arns = argv.slice(argv.indexOf('--tasks') + 1).filter((a) => a.startsWith('arn:'));
    return out({
      tasks: arns.map((arn) => {
        const t = state.tasks[arn];
        if (t)
          return {
            taskArn: arn,
            lastStatus: 'STOPPED',
            stoppedReason: 'Essential container in task exited',
            containers: [{ exitCode: t.exitCode }],
          };
        const digest = state.taskDefs[state.service?.taskDefinition]?.image.split('@')[1];
        return { taskArn: arn, lastStatus: 'RUNNING', containers: [{ imageDigest: digest }] };
      }),
    });
  }
  if (op === 'describe-task-definition') {
    const j = taskDefinitionJson(opt('--task-definition'));
    return j ? out(j) : fail('Unable to describe task definition.');
  }
  if (op === 'describe-services') {
    const snap = serviceSnapshot();
    save();
    if (query() === 'services[0].taskDefinition')
      return out(snap.services[0]?.taskDefinition ?? 'None');
    return out(snap);
  }
  if (op === 'update-service') {
    const td = opt('--task-definition');
    const s = state.service;
    if (td === s.baseline) {
      s.taskDefinition = td;
      s.target = null;
      s.deployments = [{ status: 'PRIMARY', taskDefinition: td, rolloutState: 'COMPLETED' }];
    } else {
      s.target = td;
      s.ticks = 0;
    }
    save();
    return out({ service: { serviceName: `${PREFIX}-api` } });
  }
  if (op === 'register-task-definition') {
    const input = JSON.parse(
      readFileSync(opt('--cli-input-json').replace(/^file:\/\//, ''), 'utf8'),
    );
    if (input.taskDefinitionArn || input.revision || input.status)
      return fail('fake: read-only fields in register input', 1);
    const arn = addTaskDef(input.family, input.containerDefinitions[0].image, { external: true });
    save();
    return out(
      query() === 'taskDefinition.taskDefinitionArn'
        ? arn
        : { taskDefinition: { taskDefinitionArn: arn } },
    );
  }
  if (op === 'list-tasks')
    return out(state.service ? `arn:aws:ecs:${REGION}:${ACCOUNT}:task/${PREFIX}/running-1` : '');
  if (op === 'wait') return 0;
  if (op === 'list-task-definitions') {
    const prefix = opt('--family-prefix');
    const status = opt('--status');
    const foreign = status === 'ACTIVE' ? (state.foreign?.taskDefs ?? []) : [];
    return out(
      [
        ...Object.values(state.taskDefs)
          .filter((t) => t.family.startsWith(prefix) && t.status === status)
          .map((t) => t.arn),
        ...foreign.filter((a) => a.includes(`:task-definition/${prefix}`)),
      ].join('\t'),
    );
  }
  if (
    op === 'deregister-task-definition' &&
    state.foreign?.taskDefs?.includes(opt('--task-definition'))
  ) {
    state.foreignTouched.push(`deregister ${opt('--task-definition')}`);
    save();
    return fail('fake: a FOREIGN task definition was deregistered', 97);
  }
  if (op === 'deregister-task-definition') {
    state.taskDefs[opt('--task-definition')].status = 'INACTIVE';
    save();
    return out({});
  }
  if (op === 'delete-task-definitions') {
    for (const a of argv
      .slice(argv.indexOf('--task-definitions') + 1)
      .filter((x) => x.startsWith('arn:')))
      delete state.taskDefs[a];
    save();
    return out({});
  }
  return fail(`fake aws ecs ${op}`, 99);
}

function logs(op) {
  if (op === 'describe-log-groups') {
    const prefix = opt('--log-group-name-prefix');
    const all = [...state.logGroups, ...(state.foreign?.logGroups ?? [])].filter((g) =>
      g.startsWith(prefix),
    );
    const exact = /logGroupName=='([^']+)'/.exec(query())?.[1];
    return out((exact ? all.filter((g) => g === exact) : all).join('\t'));
  }
  if (op === 'filter-log-events') {
    const streams = opt('--log-stream-names');
    if (streams) {
      const taskId = streams.split('/').pop();
      const task = Object.entries(state.tasks).find(([arn]) => arn.endsWith(`/${taskId}`))?.[1];
      if (task?.probeRunId) return out({ events: probeEvents(task.probeRunId) });
      return out({
        events: [
          { eventId: 'm1', timestamp: Date.now(), message: `{"msg":"${task?.name ?? '?'} done"}` },
        ],
      });
    }
    const group = opt('--log-group-name');
    if (state.foreign?.logGroups?.includes(group)) {
      state.foreignTouched.push(`filter-log-events ${group}`);
      save();
    }
    const canary = existsSync(env.FAKE_CANARY_RUN ?? '')
      ? JSON.parse(readFileSync(env.FAKE_CANARY_RUN, 'utf8'))
      : null;
    if (group === `/starter/${PREFIX}/ecs/api` && canary) {
      return out({
        events: [canary.canaryJobId, canary.failureJobId].map((id, i) => ({
          eventId: `a${i}`,
          timestamp: Date.now(),
          message: `{"msg":"audit","audit":{"jobIds":["${id}"]}}`,
        })),
      });
    }
    return out({
      events: [{ eventId: 'x', timestamp: Date.now(), message: 'START RequestId: 1' }],
    });
  }
  if (op === 'delete-log-group') {
    if (state.foreign?.logGroups?.includes(opt('--log-group-name'))) {
      state.foreignTouched.push(`delete-log-group ${opt('--log-group-name')}`);
      save();
      return fail('fake: a FOREIGN log group was deleted', 97);
    }
    state.logGroups = state.logGroups.filter((g) => g !== opt('--log-group-name'));
    save();
    return 0;
  }
  return fail(`fake aws logs ${op}`, 99);
}

function stepfunctions(op) {
  const canary = existsSync(env.FAKE_CANARY_RUN ?? '')
    ? JSON.parse(readFileSync(env.FAKE_CANARY_RUN, 'utf8'))
    : null;
  const sm = OUTPUTS.Workflow.StateMachineArn;
  const exec = (id) => `${sm.replace(':stateMachine:', ':execution:')}:job-${id}`;
  if (op === 'list-executions') {
    const now = new Date().toISOString();
    const executions = canary
      ? [
          { executionArn: exec(canary.canaryJobId), status: 'SUCCEEDED', startDate: now },
          { executionArn: exec(canary.failureJobId), status: 'FAILED', startDate: now },
        ]
      : [];
    return out({ executions });
  }
  if (op === 'get-execution-history') {
    const arn = opt('--execution-arn');
    const id = arn.split(':job-')[1];
    const events = [
      {
        type: 'ExecutionStarted',
        executionStartedEventDetails: { input: JSON.stringify({ jobId: id }) },
      },
    ];
    if (canary && id === canary.failureJobId) {
      events.push(
        {
          type: 'LambdaFunctionFailed',
          lambdaFunctionFailedEventDetails: { error: 'JobValidationError', cause: 'too few words' },
        },
        { type: 'TaskStateEntered', stateEnteredEventDetails: { name: 'RecordFailure' } },
      );
    }
    return out({ events });
  }
  return fail(`fake aws stepfunctions ${op}`, 99);
}

/**
 * The real account guard (tools/aws-preflight guard-cli) resolves the first `aws` on PATH, checks
 * `aws --version` (exactly 2.35.11) and makes one `sts get-caller-identity` per check, in a child
 * environment reduced to HOME/PATH/locale (the world's shim bakes FAKE_LOG/FAKE_STATE in). The
 * account it answers is ${ACCOUNT}, or the content of <world>/sts-account (a mismatch scenario).
 */
function guardCalls() {
  // Read-only answers that never write the state (a log follower may run concurrently).
  const answer = (v) => {
    out(v);
    process.exit(0);
  };
  if (argv[0] === '--version') answer('aws-cli/2.35.11 Python/3.13.7 Darwin/25.0.0 source/arm64');
  if (argv[0] !== 'sts' || argv[1] !== 'get-caller-identity') return;
  if (opt('--profile') !== 'starter-sandbox-developer' || opt('--region') !== REGION) {
    process.stderr.write('fake aws: sts call not pinned to the profile/region\n');
    process.exit(98);
  }
  const accountFile = join(dirname(env.FAKE_STATE), 'sts-account');
  const account = existsSync(accountFile) ? readFileSync(accountFile, 'utf8').trim() : ACCOUNT;
  answer({
    UserId: 'AROAFAKEROLEID00000001:jane.doe@example.com',
    Account: account,
    Arn: `arn:aws:sts::${account}:assumed-role/AWSReservedSSO_Developer_0123456789abcdef/jane.doe@example.com`,
  });
}

function aws() {
  guardCalls();
  if (
    argv[0] !== '--profile' ||
    argv[1] !== 'starter-sandbox-developer' ||
    argv[2] !== '--region' ||
    argv[3] !== REGION
  ) {
    return fail(
      `fake aws: call not pinned to the profile/region: ${argv.slice(0, 4).join(' ')}`,
      98,
    );
  }
  const rest = argv.slice(argv[4] === '--no-cli-pager' ? 5 : 4);
  const [service, op] = rest;
  argv.splice(0, argv.length, ...rest);
  if (!permitted(service, op)) {
    appendFileSync(env.FAKE_LOG, `DENIED aws ${service} ${op}\n`);
    return fail(
      `An error occurred (AccessDeniedException) when calling the ${op} operation: not authorized (fake permission set)`,
    );
  }
  switch (service) {
    case 'cloudformation':
      return cloudformation(op);
    case 'ecs':
      return ecs(op);
    case 'logs':
      return logs(op);
    case 'stepfunctions':
      return stepfunctions(op);
    case 'ssm':
      if (op === 'get-parameters') return out(state.toolkit ? state.toolkit.version : 'None');
      return fail(`fake aws ssm ${op}`, 99);
    case 'ecr':
      if (op === 'get-login-password') return out('fake-ecr-token-0123456789');
      if (op === 'describe-images') {
        const d = opt('--image-ids').replace('imageDigest=', '');
        return state.ecrImages.includes(d)
          ? out({ imageDetails: [{ imageDigest: d }] })
          : fail('ImageNotFoundException');
      }
      if (op === 'list-images') return out(state.ecrImages.join('\t'));
      if (op === 'describe-repositories')
        return state.stacks['Sandbox-Platform'] || state.retainedRepo
          ? out({})
          : fail('RepositoryNotFoundException');
      if (op === 'delete-repository') {
        if (!has('--force')) return fail('RepositoryNotEmptyException', 254);
        state.retainedRepo = false;
        save();
        return out({});
      }
      return fail(`fake aws ecr ${op}`, 99);
    case 's3':
      if (op === 'cp' || op === 'sync') return 0;
      return fail(`fake aws s3 ${op}`, 99);
    case 's3api':
      if (op === 'list-object-versions') return out({});
      if (op === 'head-bucket') return state.retainedBucket ? 0 : fail('Not Found');
      if (op === 'delete-bucket') {
        state.retainedBucket = null;
        save();
        return 0;
      }
      if (op === 'delete-objects') return out({});
      return fail(`fake aws s3api ${op}`, 99);
    case 'cloudfront':
      if (op === 'create-invalidation') return out(query() ? 'I1' : { Invalidation: { Id: 'I1' } });
      if (op === 'wait') return 0;
      return fail(`fake aws cloudfront ${op}`, 99);
    case 'elbv2':
      if (op === 'describe-load-balancers') {
        if (query().includes('DNSName'))
          return out(
            `arn:aws:elasticloadbalancing:${REGION}:${ACCOUNT}:loadbalancer/app/${PREFIX}-api/1`,
          );
        if (query().includes('SecurityGroups')) return out('sg-alb');
        return out({ LoadBalancers: [{ SecurityGroups: ['sg-alb'] }] });
      }
      if (op === 'describe-listeners') return out({ Listeners: [{ ListenerArn: 'arn:listener' }] });
      if (op === 'describe-rules') {
        return out({
          Rules: [
            {
              IsDefault: true,
              Actions: [{ Type: 'fixed-response', FixedResponseConfig: { StatusCode: '403' } }],
            },
            {
              IsDefault: false,
              Actions: [{ Type: 'forward' }],
              Conditions: [
                {
                  Field: 'http-header',
                  HttpHeaderConfig: { HttpHeaderName: 'X-Origin-Verify', Values: [state.secret] },
                },
              ],
            },
          ],
        });
      }
      return fail(`fake aws elbv2 ${op}`, 99);
    case 'ec2':
      return out({
        SecurityGroups: [
          {
            GroupId: 'sg-alb',
            IpPermissions: [{ PrefixListIds: [{ PrefixListId: 'pl-cf' }], IpRanges: [] }],
          },
        ],
      });
    case 'cloudwatch':
      return out({});
    case 'rds':
      if (op === 'describe-db-instance-automated-backups' || op === 'describe-db-snapshots') {
        if (opt('--db-instance-identifier') !== DB_INSTANCE) {
          state.foreignTouched.push(`rds ${op} ${opt('--db-instance-identifier')}`);
          save();
        }
        return out('');
      }
      return fail(`fake aws rds ${op}`, 99);
    case 'kms':
      if (op === 'describe-key') {
        const id = opt('--key-id').split('/').pop();
        if (!state.keys[id]) return fail('NotFoundException');
        return out(
          query() === 'KeyMetadata.KeyState'
            ? state.keys[id]
            : { KeyMetadata: { KeyState: state.keys[id] } },
        );
      }
      return fail(`fake aws kms ${op}`, 99);
    default:
      return fail(`fake aws: unexpected service ${service} ${op}`, 99);
  }
}

// ── registry tools ───────────────────────────────────────────────────────────────────────────
function writeLayout(dir, tag) {
  const blob = (content) => {
    const d = sha(content);
    mkdirSync(join(dir, 'blobs', 'sha256'), { recursive: true });
    writeFileSync(join(dir, 'blobs', 'sha256', d.slice(7)), content);
    return { digest: d, size: Buffer.byteLength(content) };
  };
  const config = blob(
    JSON.stringify({
      architecture: 'arm64',
      os: 'linux',
      config: { Entrypoint: ['/nodejs/bin/node'], Cmd: ['dist/server.js'] },
    }),
  );
  const manifest = blob(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
      config: { mediaType: 'application/vnd.oci.image.config.v1+json', ...config },
      layers: [],
    }),
  );
  writeFileSync(
    join(dir, 'index.json'),
    JSON.stringify({
      schemaVersion: 2,
      manifests: [
        {
          mediaType: 'application/vnd.oci.image.manifest.v1+json',
          ...manifest,
          annotations: { 'org.opencontainers.image.ref.name': tag },
        },
      ],
    }),
  );
}

function skopeo() {
  const [cmd] = argv;
  if (cmd === 'login') {
    const file = opt('--authfile');
    readFileSync(0, 'utf8');
    writeFileSync(file, JSON.stringify({ auths: { [argv.at(-1)]: { auth: 'fake' } } }));
    return 0;
  }
  if (cmd === 'inspect') {
    if (argv.at(-1).startsWith('oci-archive:')) {
      return out({ Digest: `sha256:${'b'.repeat(64)}`, Architecture: 'arm64' });
    }
    if ((env.FAKE_CI_IMAGE ?? 'ok') !== 'ok') return fail('manifest unknown', 1);
    return out({
      Digest: `sha256:${'c'.repeat(64)}`,
      Architecture: 'arm64',
      Labels: { 'org.opencontainers.image.revision': env.FAKE_HEAD },
    });
  }
  if (cmd === 'copy') {
    const [src, dest] = argv.slice(-2);
    const digestFile = opt('--digestfile');
    if (dest.startsWith('oci:')) {
      const [, dir, tag] = dest.split(':');
      writeLayout(dir, tag);
      return 0;
    }
    let digest;
    if (src.startsWith('docker://')) digest = src.split('@')[1];
    else if (src.startsWith('oci-archive:')) digest = `sha256:${'b'.repeat(64)}`;
    else if (src.startsWith('oci:')) {
      const [, dir, tag] = src.split(':');
      const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'));
      digest = index.manifests.find(
        (m) => m.annotations['org.opencontainers.image.ref.name'] === tag,
      ).digest;
    }
    if (!dest.startsWith(`docker://${repoUri}:`))
      return fail(`fake skopeo: unexpected destination ${dest}`, 99);
    if (!existsSync(opt('--dest-authfile') ?? '')) return fail('fake skopeo: no ECR login', 1);
    state.ecrImages.push(digest);
    save();
    if (digestFile) writeFileSync(digestFile, digest);
    return 0;
  }
  return fail(`fake skopeo ${cmd}`, 99);
}

function cosign() {
  const ref = argv.at(-1);
  if (argv[0] !== 'verify' || !argv.includes('--key')) return fail('fake cosign: unexpected', 99);
  return out([{ critical: { image: { 'docker-manifest-digest': ref.split('@')[1] } } }]);
}

function podman() {
  if (argv.includes('save')) {
    writeFileSync(opt('-o'), 'fake oci archive');
    return 0;
  }
  if (argv.includes('build')) return 0;
  return fail('fake podman: unexpected', 99);
}

function finops() {
  const [cmd] = argv;
  const file = opt('--out');
  if (!opt('--guard-log')) return fail('fake finops: no --guard-log', 2);
  if (cmd === 'inventory') {
    writeFileSync(
      file,
      JSON.stringify({ runId: opt('--run-id'), stacks: Object.keys(state.stacks) }),
    );
    return 0;
  }
  if (cmd === 'verify-clean') {
    // Like the real tool: strict by default, --lenient opts out (the scripts never do);
    // --inventory must be this run's inventory.
    if (has('--lenient')) return fail('fake finops: --lenient was passed', 2);
    const inventory = opt('--inventory');
    if (inventory !== undefined) {
      if (!existsSync(inventory)) return fail(`fake finops: --inventory ${inventory} missing`, 2);
      if (JSON.parse(readFileSync(inventory, 'utf8')).runId !== opt('--run-id'))
        return fail('fake finops: --inventory is for another run', 2);
    }
    const left = [
      ...Object.keys(state.stacks),
      ...state.logGroups,
      ...Object.values(state.taskDefs).map((t) => t.arn),
      ...(has('--include-bootstrap') && (state.toolkit || state.retainedBucket)
        ? ['starter-cdk-toolkit']
        : []),
    ];
    // FAKE_FINOPS_UNVERIFIABLE=1: the role could not list KMS keys / secrets (exit 5 when clean).
    const unverifiable =
      env.FAKE_FINOPS_UNVERIFIABLE === '1'
        ? [
            {
              category: 'kms-keys',
              status: 'unverifiable-with-this-role',
              evidence: [
                'kms:ListKeys denied; 2 keys of the run proven PendingDeletion via describe-key (arn:aws:kms:ap-southeast-1:111122223333:key/k1)',
              ],
            },
            {
              category: 'secretsmanager-secrets',
              status: 'unverifiable-with-this-role',
              evidence: [
                'secretsmanager:* denied; DeleteStack events show starter-sbx/rds/master scheduled',
              ],
            },
          ]
        : [];
    const status =
      left.length > 0 ? 'not-clean' : unverifiable.length > 0 ? 'clean-with-unverifiable' : 'clean';
    writeFileSync(
      file,
      JSON.stringify({
        runId: opt('--run-id'),
        status,
        remaining: left,
        summary: { unverifiable },
      }),
    );
    return left.length > 0 ? 1 : unverifiable.length > 0 ? 5 : 0;
  }
  return fail(`fake finops ${cmd}`, 99);
}

function issuerTool() {
  const [cmd] = argv;
  if (cmd === 'keygen') {
    writeFileSync(
      opt('--out'),
      JSON.stringify({
        kty: 'EC',
        crv: 'P-256',
        kid: 'k1',
        x: 'X'.repeat(43),
        y: 'Y'.repeat(43),
        d: env.FAKE_JWK_D,
      }),
      { mode: 0o600 },
    );
    return 0;
  }
  if (cmd === 'export') {
    const dir = opt('--out');
    const issuer = opt('--issuer');
    writeFileSync(
      join(dir, 'openid-configuration'),
      JSON.stringify({ issuer, jwks_uri: `${issuer}/jwks.json` }),
    );
    writeFileSync(
      join(dir, 'jwks.json'),
      JSON.stringify({
        keys: [{ kty: 'EC', crv: 'P-256', kid: 'k1', x: 'X'.repeat(43), y: 'Y'.repeat(43) }],
      }),
    );
    return 0;
  }
  return fail(`fake sandbox-issuer ${cmd}`, 99);
}

function smoke() {
  const steps = [
    'liveness: GET /health/live -> 200',
    'readiness: GET /health/ready -> 200',
    'authentication enforced: GET /v1/jobs without a token -> 401',
    'valid job: POST /v1/jobs -> 202 -> SUCCEEDED with results',
    'business-rule failure: POST /v1/jobs -> 202 -> FAILED (JobValidationError)',
    'schema-invalid request: POST /v1/jobs -> 400 problem+json',
  ];
  out(`smoke: target ${env.BASE_URL} idp ${env.SMOKE_TEST_IDP_URL}`);
  for (const s of steps) out(`ok   - ${s} (3ms) fake`);
  out('smoke: PASSED (6/6 steps passed)');
  return 0;
}

const handlers = { aws, pnpm, skopeo, cosign, podman, finops, 'issuer-tool': issuerTool, smoke };
const handler = handlers[tool];
if (!handler) fail(`fake-world: unknown tool ${tool}`, 99);
const code = handler() ?? 0;
save();
process.exit(code);
