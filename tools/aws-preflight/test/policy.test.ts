import { describe, expect, it } from 'vitest';
import { BOUNDARY_OPERATIONS, FORBIDDEN_OPTION_PREFIXES, STANDARD_FLAGS } from '../src/boundary.ts';
import { buildArgv } from '../src/executor.ts';
import { iamActionResources, iamPolicy } from '../src/plan.ts';
import {
  assertArgvSafe,
  assertValidRegistry,
  BoundaryViolation,
  DENIED_FLAGS,
  DENIED_OPERATIONS,
  DENIED_SERVICES,
  IAM_VERB_EXCEPTIONS,
  isDeniedOperation,
  probeDefProblems,
  renderArgs,
  type ProbeDef,
} from '../src/policy.ts';
import { P } from '../src/projections.ts';
import { PROBES, PROBES_BY_ID } from '../src/probes.ts';
import { allowedRegions, AREAS, type Area } from '../src/types.ts';
import { compileRolePattern } from '../src/validate.ts';
import { ROLE, SANDBOX } from './support.ts';

/**
 * Operations that the AWS CLI (2.35.11) paginates, i.e. accept --max-items; taken from
 * `aws <service> <operation> help` ("... is a paginated operation"). The others reject it.
 */
const CLI_PAGINATED = new Set([
  'acm list-certificates',
  'budgets describe-budgets',
  'budgets describe-notifications-for-budget',
  'cloudformation describe-account-limits',
  'cloudformation describe-stacks',
  'cloudformation list-stacks',
  'cloudformation list-types',
  'ec2 describe-internet-gateways',
  'ec2 describe-managed-prefix-lists',
  'ec2 describe-nat-gateways',
  'ec2 describe-route-tables',
  'ec2 describe-subnets',
  'ec2 describe-vpc-endpoints',
  'ec2 describe-vpcs',
  'ecs list-account-settings',
  'elbv2 describe-account-limits',
  'iam list-account-aliases',
  'iam list-attached-role-policies',
  'iam list-policies',
  'iam list-role-policies',
  'kms list-aliases',
  'logs describe-resource-policies',
  'organizations list-parents',
  'organizations list-policies-for-target',
  'rds describe-certificates',
  'rds describe-db-engine-versions',
  'rds describe-orderable-db-instance-options',
  'route53 list-hosted-zones',
  'service-quotas list-requested-service-quota-change-history-by-quota',
  'service-quotas list-service-quotas',
]);

const base: ProbeDef = {
  id: 'x.test.probe',
  area: 'network-edge',
  phase: 'discovery',
  service: 'ec2',
  operation: 'describe-vpcs',
  iamAction: 'ec2:DescribeVpcs',
  regions: ['ap-southeast-1'],
  args: [],
  bound: { kind: 'max-items', value: 10 },
  purpose: 'test',
  project: P.vpcs,
};

describe('the static allowlist', () => {
  it('passes every read-only rule (also enforced at module load)', () => {
    expect(() => assertValidRegistry(PROBES)).not.toThrow();
    for (const def of PROBES) expect(probeDefProblems(def), def.id).toEqual([]);
  });

  it('has the reviewed size: 79 definitions, 53 CLI operations, 52 IAM actions, 19 services', () => {
    expect(PROBES).toHaveLength(79);
    expect(new Set(PROBES.map((p) => `${p.service} ${p.operation}`)).size).toBe(53);
    expect(new Set(PROBES.map((p) => p.iamAction)).size).toBe(52);
    expect(new Set(PROBES.map((p) => p.service)).size).toBe(19);
  });

  it('assigns every definition one named discovery area; the identity area is the identity gate', () => {
    expect(AREAS).toEqual(['org-iam', 'network-edge', 'quotas-services', 'finops', 'identity']);
    for (const def of PROBES) {
      expect(AREAS, def.id).toContain(def.area);
      expect(def.area === 'identity', def.id).toBe(def.phase === 'identity');
    }
    expect(new Set(PROBES.map((p) => p.area))).toEqual(new Set(AREAS));
  });

  it('contains only get-/list-/describe- operations with Get/List/Describe IAM actions', () => {
    for (const def of PROBES) {
      expect(def.operation, def.id).toMatch(/^(get|list|describe)-[a-z0-9-]+$/);
      if (!IAM_VERB_EXCEPTIONS.has(def.iamAction)) {
        expect(def.iamAction, def.id).toMatch(/^[a-z0-9-]+:(Get|List|Describe)[A-Za-z0-9]+$/);
      }
    }
    // The only verb exception is budgets:ViewBudget for the two budgets operations.
    const exceptions = PROBES.filter((p) => IAM_VERB_EXCEPTIONS.has(p.iamAction));
    expect(exceptions.map((p) => `${p.service} ${p.operation} ${p.iamAction}`).sort()).toEqual([
      'budgets describe-budgets budgets:ViewBudget',
      'budgets describe-notifications-for-budget budgets:ViewBudget',
    ]);
  });

  it('sends every probe only to ap-southeast-1 and/or us-east-1', () => {
    for (const def of PROBES) {
      expect(def.regions.length, def.id).toBeGreaterThan(0);
      for (const r of def.regions) expect(['ap-southeast-1', 'us-east-1'], def.id).toContain(r);
      expect(allowedRegions()).toEqual(['ap-southeast-1', 'us-east-1']);
    }
  });

  it('bounds responses the way the CLI accepts (--max-items only for paginated operations)', () => {
    for (const def of PROBES) {
      const key = `${def.service} ${def.operation}`;
      if (def.bound.kind === 'max-items') expect(CLI_PAGINATED.has(key), def.id).toBe(true);
      else expect(CLI_PAGINATED.has(key), def.id).toBe(false);
    }
  });

  it('contains none of the dangerous read-like operations', () => {
    const present = new Set(PROBES.map((p) => `${p.service} ${p.operation}`));
    for (const [s, o] of DENIED_OPERATIONS)
      expect(present.has(`${s} ${o}`), `${s} ${o}`).toBe(false);
    for (const def of PROBES) {
      expect(['s3', 's3api', 'ce', 'configure', 'secretsmanager']).not.toContain(def.service);
      expect(DENIED_SERVICES).not.toContain(def.service);
    }
  });

  it('never decrypts: the only ssm call is get-parameter with --no-with-decryption', () => {
    const ssm = PROBES.filter((p) => p.service === 'ssm');
    expect(ssm.map((p) => p.operation)).toEqual(['get-parameter']);
    for (const p of ssm) {
      expect(p.args).toContain('--no-with-decryption');
      expect(p.args).not.toContain('--with-decryption');
    }
  });

  it('interpolates every value as --option={placeholder}', () => {
    for (const def of PROBES) {
      for (const token of [...def.args, ...(def.vpcFilter ?? [])]) {
        if (token.includes('{') && token.startsWith('--')) {
          expect(token, def.id).toMatch(/^--[a-z0-9-]+=[^=]*\{[A-Za-z]+\}/);
        }
        expect(token, def.id).not.toMatch(/^\{[A-Za-z]+\}$/);
      }
    }
  });

  it('is deep-frozen (cannot be extended or edited at runtime)', () => {
    expect(Object.isFrozen(PROBES)).toBe(true);
    const def = PROBES_BY_ID.get('b.ec2.vpcs');
    expect(def && Object.isFrozen(def) && Object.isFrozen(def.args)).toBe(true);
    expect(() => (PROBES as ProbeDef[]).push(base)).toThrow();
  });

  it('labels the Lambda concurrency requirement correctly', () => {
    const purpose = PROBES_BY_ID.get('c.lambda.account-settings')?.purpose ?? '';
    expect(purpose).toContain('the full sandbox stack needs an applied concurrency of 109 or more');
    expect(purpose).toContain('the integration mini-stack none');
    expect(purpose).not.toMatch(/\b19\b/);
  });
});

describe('the generated IAM policy', () => {
  const policy = iamPolicy() as {
    Statement: {
      Sid: string;
      Action: string[];
      Effect: string;
      Resource: string | string[];
      Condition: unknown;
    }[];
  };

  it('allows exactly the allowlisted actions, only in the two regions', () => {
    const actions = policy.Statement.flatMap((s) => s.Action);
    expect(actions.sort()).toEqual([...new Set(PROBES.map((p) => p.iamAction))].sort());
    expect(new Set(actions).size).toBe(actions.length);
    for (const s of policy.Statement) {
      expect(s.Effect).toBe('Allow');
      expect(s.Condition).toEqual({
        StringEquals: { 'aws:RequestedRegion': ['ap-southeast-1', 'us-east-1'] },
      });
    }
  });

  it('never grants a document- or value-reading action on "*"', () => {
    const star = policy.Statement.filter((s) => s.Resource === '*').flatMap((s) => s.Action);
    for (const action of [
      'ssm:GetParameter',
      'cloudformation:DescribeStacks',
      'iam:GetRolePolicy',
    ]) {
      expect(star, action).not.toContain(action);
    }
    const scoped = Object.fromEntries(
      policy.Statement.filter((s) => s.Resource !== '*').map((s) => [s.Action.join(), s.Resource]),
    );
    expect(scoped).toEqual({
      'cloudformation:DescribeStacks': [
        'arn:aws:cloudformation:ap-southeast-1:*:stack/CDKToolkit/*',
        'arn:aws:cloudformation:us-east-1:*:stack/CDKToolkit/*',
      ],
      'iam:GetRolePolicy': ['arn:aws:iam::*:role/aws-reserved/sso.amazonaws.com/*'],
      'ssm:GetParameter': [
        'arn:aws:ssm:ap-southeast-1:*:parameter/cdk-bootstrap/*',
        'arn:aws:ssm:us-east-1:*:parameter/cdk-bootstrap/*',
      ],
    });
    expect(iamActionResources().get('sts:GetCallerIdentity')).toBe('*');
  });
});

describe('the read-only rules reject unsafe definitions', () => {
  const problems = (patch: Partial<ProbeDef>) => probeDefProblems({ ...base, ...patch });

  it('rejects an area that is not one of AREAS', () => {
    expect(problems({ area: 'B' as Area })).toContain(
      'area "B" is not one of org-iam, network-edge, quotas-services, finops, identity',
    );
  });

  it.each([
    [{ operation: 'create-vpc', iamAction: 'ec2:CreateVpc' }, 'not a get-/list-/describe-'],
    [{ operation: 'describe-vpcs', iamAction: 'ec2:CreateVpc' }, 'not a Get/List/Describe action'],
    [{ iamAction: 'ec2:DescribeSubnets' }, 'does not match operation'],
    [{ iamAction: 's3:ListBuckets' }, 'IAM prefix'],
    [{ iamAction: 'budgets:ViewBudget' }, 'only allowed for'],
    [
      { operation: 'describe-instances', iamAction: 'ec2:DescribeInstances' },
      'is not in the boundary list',
    ],
    [
      {
        service: 'secretsmanager',
        operation: 'get-secret-value',
        iamAction: 'secretsmanager:GetSecretValue',
      },
      'not an allowed AWS CLI service',
    ],
    [{ service: 's3api', operation: 'get-object', iamAction: 's3:GetObject' }, 'denylisted'],
    [{ service: 'kms', operation: 'get-key-policy', iamAction: 'kms:GetKeyPolicy' }, 'denylisted'],
    [{ regions: ['eu-west-1'] as unknown as ProbeDef['regions'] }, 'not allowed'],
    [{ regions: [] }, 'regions is empty'],
    [{ args: ['--debug'] }, 'forbidden or reserved flag --debug'],
    [{ args: ['--endpoint-url=http://localhost'] }, 'forbidden or reserved flag --endpoint-url'],
    [{ args: ['--no-verify-ssl'] }, 'forbidden or reserved flag --no-verify-ssl'],
    [{ args: ['--with-decryption'] }, 'forbidden or reserved flag --with-decryption'],
    [{ args: ['--profile', 'other'] }, 'forbidden or reserved flag --profile'],
    [{ args: ['--max-items', '5000'] }, 'forbidden or reserved flag --max-items'],
    [{ args: ['--no-verify'] }, 'starts with --no-verify'],
    [{ args: ['--deb'] }, 'starts with --deb'],
    [{ args: ['--endpoint=x.example'] }, 'starts with --endpoint'],
    [{ args: ['-h'] }, 'short option -h'],
    [{ args: ['--filters', '{vpcId}'] }, 'is a bare placeholder'],
    [{ args: ['--role-name', '{roleName}'] }, 'is a bare placeholder'],
    [{ args: ['--filters', '{secret}'] }, 'unknown placeholder {secret}'],
    [{ args: ['--name', 'a b'] }, 'disallowed characters'],
    [{ iamResources: ['*'] }, 'iamResources entry "*" is malformed'],
    [{ bound: { kind: 'max-items', value: 100000 } }, 'bound is out of range'],
  ] as const)('%o -> %s', (patch, expected) => {
    expect(problems(patch as Partial<ProbeDef>).join(' | ')).toContain(expected);
  });

  it('refuses to load a registry with a bad entry or duplicate ids', () => {
    expect(() => assertValidRegistry([...PROBES, { ...base, operation: 'delete-vpc' }])).toThrow(
      /invalid/,
    );
    expect(() => assertValidRegistry([base, base])).toThrow(/duplicate id/);
  });

  it('pins the documented denylist', () => {
    for (const [service, operation] of [
      ['secretsmanager', 'get-secret-value'],
      ['ssm', 'get-parameters-by-path'],
      ['ssm', 'get-parameters'],
      ['ssm', 'get-parameter-history'],
      ['kms', 'get-key-policy'],
      ['kms', 'decrypt'],
      ['ec2', 'get-password-data'],
      ['ec2', 'get-console-output'],
      ['ecr', 'get-login-password'],
      ['ecr', 'get-authorization-token'],
      ['sts', 'get-session-token'],
      ['sts', 'get-federation-token'],
      ['sts', 'assume-role'],
      ['lambda', 'get-function'],
      ['lambda', 'get-function-configuration'],
      ['cloudformation', 'get-template'],
      ['iam', 'get-account-authorization-details'],
      ['iam', 'get-credential-report'],
      ['logs', 'get-log-events'],
      ['logs', 'filter-log-events'],
      ['s3api', 'get-object'],
      ['ce', 'get-cost-and-usage'],
      ['configure', 'export-credentials'],
      ['sso', 'get-role-credentials'],
      ['budgets', 'describe-subscribers-for-notification'],
      ['budgets', 'describe-budget-performance-history'],
      ['organizations', 'describe-account'],
      ['account', 'get-primary-email'],
    ] as const) {
      expect(isDeniedOperation(service, operation), `${service} ${operation}`).toBe(true);
    }
    expect(isDeniedOperation('ec2', 'describe-vpcs')).toBe(false);
    expect(DENIED_OPERATIONS).toHaveLength(52);
  });
});

describe('the exec boundary list is independent of the registry', () => {
  const triples = PROBES.map((p) => `${p.service} ${p.operation} ${p.iamAction}`);

  it('agrees with the registry in both directions, is sorted and frozen', () => {
    for (const t of triples) expect(BOUNDARY_OPERATIONS, t).toContain(t);
    for (const entry of BOUNDARY_OPERATIONS) expect(triples, entry).toContain(entry);
    expect([...BOUNDARY_OPERATIONS].sort()).toEqual([...BOUNDARY_OPERATIONS]);
    expect(Object.isFrozen(BOUNDARY_OPERATIONS)).toBe(true);
    expect(BOUNDARY_OPERATIONS).toHaveLength(53);
  });

  it('refuses the abbreviations the CLI argument parser would expand', () => {
    for (const prefix of [
      '--no-verify',
      '--endpoint',
      '--deb',
      '--with-dec',
      '--cli-input',
      '--query',
    ]) {
      expect(FORBIDDEN_OPTION_PREFIXES).toContain(prefix);
    }
    expect(STANDARD_FLAGS).toEqual([
      '--profile',
      '--region',
      '--output',
      '--no-cli-pager',
      '--cli-connect-timeout',
      '--cli-read-timeout',
    ]);
  });
});

describe('the final argv check at the exec boundary', () => {
  const def = PROBES_BY_ID.get('b.ec2.vpcs');
  const role = PROBES_BY_ID.get('identity.role');
  if (!def || !role) throw new Error('missing probe');
  const good = buildArgv(
    def,
    { region: 'ap-southeast-1', values: {} },
    'starter-sandbox-developer',
  );
  const goodRole = buildArgv(
    role,
    { region: 'ap-southeast-1', values: { roleName: ROLE } },
    'starter-sandbox-developer',
  );

  it('accepts the argv the executor builds', () => {
    expect(() => assertArgvSafe(good, def, 'ap-southeast-1')).not.toThrow();
    expect(() => assertArgvSafe(goodRole, role, 'ap-southeast-1')).not.toThrow();
    expect(good).toEqual([
      'ec2',
      'describe-vpcs',
      '--max-items',
      '50',
      '--profile',
      'starter-sandbox-developer',
      '--region',
      'ap-southeast-1',
      '--output',
      'json',
      '--no-cli-pager',
      '--cli-connect-timeout',
      '10',
      '--cli-read-timeout',
      '30',
    ]);
    expect(goodRole.slice(0, 3)).toEqual(['iam', 'get-role', `--role-name=${ROLE}`]);
  });

  it.each([
    ['a forbidden flag', [...good, '--debug']],
    ['an endpoint override', [...good, '--endpoint-url', 'https://example.test']],
    ['TLS verification off', [...good, '--no-verify-ssl']],
    ['decryption', [...good, '--with-decryption']],
    ['a second profile', [...good, '--profile', 'admin']],
    ['text output', good.map((t) => (t === 'json' ? 'text' : t))],
    ['a missing pager flag', good.filter((t) => t !== '--no-cli-pager')],
    ['a changed timeout', good.map((t) => (t === '30' ? '0' : t))],
    ['a different operation', ['secretsmanager', 'get-secret-value', ...good.slice(2)]],
    ['a control character', [...good.slice(0, -1), '30\n']],
    // Abbreviations (argparse prefix matching) and options the probe does not use.
    ['--no-verify (= --no-verify-ssl)', [...good, '--no-verify']],
    ['--deb (= --debug)', [...good, '--deb']],
    ['--endpoint=x (= --endpoint-url)', [...good, '--endpoint=https://example.test']],
    ['--no-sign (= --no-sign-request)', [...good, '--no-sign']],
    ['--query=', [...good, '--query=Vpcs']],
    ['--profile= (a second profile)', [...good, '--profile=admin']],
    ['--region= (a second region)', [...good, '--region=eu-west-1']],
    ['an option of another probe', [...good, '--filters', 'Name=x,Values=y']],
    ['a second --max-items', [...good, '--max-items', '1000']],
    ['a short option', [...good, '-h']],
  ])('rejects %s', (_, argv) => {
    expect(() => assertArgvSafe(argv, def, 'ap-southeast-1')).toThrow(BoundaryViolation);
  });

  it('rejects an interpolated option in the wrong form or with an injected option', () => {
    const twoToken = ['iam', 'get-role', '--role-name', ROLE, ...goodRole.slice(3)];
    expect(() => assertArgvSafe(twoToken, role, 'ap-southeast-1')).toThrow(/wrong form/);
    const injected = ['iam', 'get-role', '--role-name=x', '--no-verify', ...goodRole.slice(3)];
    expect(() => assertArgvSafe(injected, role, 'ap-southeast-1')).toThrow(/--no-verify/);
  });

  // Each check is driven by a forged definition and identified by its message, so removing any
  // one of them fails a test.
  it.each([
    [
      'the denylist',
      {
        ...base,
        service: 'ssm',
        operation: 'get-parameters-by-path',
        iamAction: 'ssm:GetParametersByPath',
      },
      /operation is denylisted/,
    ],
    [
      'the verb rule',
      { ...base, operation: 'create-vpc', iamAction: 'ec2:CreateVpc' },
      /not get-\/list-\/describe-/,
    ],
    ['the IAM action rule', { ...base, iamAction: 'ec2:CreateVpc' }, /IAM action is not read-only/],
    [
      'the boundary list',
      { ...base, operation: 'describe-instances', iamAction: 'ec2:DescribeInstances' },
      /not in the boundary list/,
    ],
  ])('a forged definition is stopped by %s', (_, forged, message) => {
    const argv = [forged.service, forged.operation, ...good.slice(2)];
    expect(() => assertArgvSafe(argv, forged as ProbeDef, 'ap-southeast-1')).toThrow(message);
  });

  it('rejects a region the probe does not allow', () => {
    const argv = buildArgv(def, { region: 'us-east-1', values: {} }, 'starter-sandbox-developer');
    expect(() => assertArgvSafe(argv, def, 'us-east-1')).toThrow(/region us-east-1/);
  });

  it('interpolates only validated placeholder values (none may start with -)', () => {
    expect(renderArgs(['--budget-name={budgetName}'], { budgetName: 'sandbox-monthly' })).toEqual([
      '--budget-name=sandbox-monthly',
    ]);
    expect(
      renderArgs(['--role-name={roleName}'], { roleName: 'AWSReservedSSO_a@b-1_0123456789abcdef' }),
    ).toEqual(['--role-name=AWSReservedSSO_a@b-1_0123456789abcdef']);
    for (const [name, value] of [
      ['budgetName', '--endpoint-url=x'],
      ['budgetName', ''],
      ['vpcId', 'vpc-123; rm -rf /'],
      ['account', '11112222333'],
      ['qualifier', 'HNB659FDS'],
      ['kmsKeyRef', 'arn:aws:kms:ap-southeast-1:111122223333:key/x'],
      ['roleName', 'a/b'],
      ['roleName', '-debug'],
      ['roleName', '--no-verify'],
      ['policyName', '--deb'],
      ['customerPolicyArn', 'arn:aws:iam::aws:policy/AdministratorAccess'],
      ['policyVersionId', 'v0'],
      ['policyVersionId', '--version'],
    ] as const) {
      expect(() => renderArgs([`--x={${name}}`], { [name]: value }), `${name}=${value}`).toThrow(
        BoundaryViolation,
      );
    }
    expect(() => renderArgs(['--x={vpcId}'], {})).toThrow(/no valid value/);
    expect(
      renderArgs([`--policy-arn={customerPolicyArn}`], {
        customerPolicyArn: `arn:aws:iam::${SANDBOX}:policy/a/B`,
      }),
    ).toEqual([`--policy-arn=arn:aws:iam::${SANDBOX}:policy/a/B`]);
  });

  it('lists the forbidden flags of the task', () => {
    for (const f of ['--debug', '--endpoint-url', '--no-verify-ssl', '--with-decryption']) {
      expect(DENIED_FLAGS).toContain(f);
    }
  });
});

describe('--expected-role-pattern is an anchored glob', () => {
  const re = (p: string) => {
    const r = compileRolePattern(p);
    if (!(r instanceof RegExp)) throw new Error(r.error);
    return r;
  };

  it('matches the whole role name, never a part of it', () => {
    expect(re('AWSReservedSSO_AccountDiscovery_*').test(ROLE)).toBe(true);
    expect(re('AWSReservedSSO_AccountDiscovery_*').test(`x${ROLE}`)).toBe(false);
    expect(re('AccountDiscovery').test(ROLE)).toBe(false);
    expect(re(ROLE).test(`${ROLE}0`)).toBe(false);
    expect(re('AWSReservedSSO_AccountDiscovery_????????????????').test(ROLE)).toBe(true);
    expect(re('AWSReservedSSO_AccountDiscovery_???????????????').test(ROLE)).toBe(false);
  });

  it("treats '.', '+' and '@' literally", () => {
    expect(re('AWSReservedSSO_a.b_*').test('AWSReservedSSO_aXb_0123456789abcdef')).toBe(false);
    expect(re('AWSReservedSSO_a+b_*').test('AWSReservedSSO_aab_0123456789abcdef')).toBe(false);
    expect(
      re('AWSReservedSSO_acme-aws@Developer-0a1b2c3_*').test(
        'AWSReservedSSO_acme-aws@Developer-0a1b2c3_0123456789abcdef',
      ),
    ).toBe(true);
  });

  it('refuses patterns that are too broad or contain regular-expression syntax', () => {
    expect(compileRolePattern('*')).toHaveProperty('error');
    expect(compileRolePattern('a*b')).toHaveProperty('error');
    expect(compileRolePattern('Admin.*|x')).toHaveProperty('error');
    expect(compileRolePattern('(Admin)')).toHaveProperty('error');
    expect(compileRolePattern('*a*a*a*a*a*b')).toEqual({ error: 'at most 4 * wildcards' });
    expect(compileRolePattern('AWSReservedSSO_*_*')).toBeInstanceOf(RegExp);
  });
});
