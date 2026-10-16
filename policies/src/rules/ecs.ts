import type { Finding, PolicyRule, RuleContext } from '../types.js';
import {
  clientAllowListFindings,
  containerEntries,
  databaseAuthFindings,
  relaxationFindings,
} from './runtime.js';
import { asArray, finding, get, isPresent, isRecord, props } from './util.js';

const TASKDEF = 'AWS::ECS::TaskDefinition';

/** Matches `root`, `0`, `root:<group>` and `0:<group>`. */
export const ROOT_USER_PATTERN = /^(0|root)(:.*)?$/;
/** Environment variable names that look like credentials (must come from `Secrets`). */
export const SECRET_ENV_NAME_PATTERN =
  /(PASSWORD|PASSWD|SECRET|TOKEN|API_KEY|PRIVATE_KEY|ACCESS_KEY)$/;
export const ALLOWED_LOG_DRIVERS = ['awslogs', 'awsfirelens'] as const;

/** Applies `check` to each container definition and collects findings. */
const perContainer =
  (check: (container: Record<string, unknown>, base: string) => Finding[]) =>
  ({ resource }: RuleContext): Finding[] =>
    asArray(props(resource)['ContainerDefinitions']).flatMap((c, i) =>
      isRecord(c) ? check(c, `Properties/ContainerDefinitions/${i}`) : [],
    );

const label = (c: Record<string, unknown>) =>
  typeof c['Name'] === 'string' ? `Container "${c['Name']}"` : 'Container';

export const ecsRules: PolicyRule[] = [
  {
    id: 'BASE-ECS-001',
    title: 'Containers run as a non-root user',
    description:
      'Every container definition sets `User` to a non-root user (not root, 0, root:* or 0:*).',
    rationale:
      'A compromised process running as root has a much larger blast radius (file system, capabilities).',
    severity: 'high',
    engines: ['cdk-nag', 'guard'],
    resourceTypes: [TASKDEF],
    remediation:
      'Set `user: "1000:1000"` (or the image user) on the container definition and build the image with a non-root USER.',
    evaluate: perContainer((c, base) => {
      const user = c['User'];
      if (!isPresent(user)) return [finding(`${base}/User`, `${label(c)} does not set User.`)];
      return typeof user === 'string' && ROOT_USER_PATTERN.test(user)
        ? [finding(`${base}/User`, `${label(c)} runs as root (${user}).`)]
        : [];
    }),
  },
  {
    id: 'BASE-ECS-002',
    title: 'Container root file systems are read-only',
    description: 'Every container definition sets ReadonlyRootFilesystem to true.',
    rationale:
      'Prevents attackers and buggy code from persisting changes in the container image layer; writable paths must be explicit volumes.',
    severity: 'medium',
    engines: ['cdk-nag', 'guard'],
    resourceTypes: [TASKDEF],
    remediation:
      'Set `readonlyRootFilesystem: true` and mount an ephemeral volume for /tmp if the app needs scratch space.',
    evaluate: perContainer((c, base) =>
      c['ReadonlyRootFilesystem'] === true
        ? []
        : [
            finding(
              `${base}/ReadonlyRootFilesystem`,
              `${label(c)} does not use a read-only root FS.`,
            ),
          ],
    ),
  },
  {
    id: 'BASE-ECS-003',
    title: 'Containers are not privileged',
    description: 'No container definition sets Privileged to true.',
    rationale: 'Privileged containers can escape to the host. Fargate rejects them anyway.',
    severity: 'critical',
    engines: ['cdk-nag', 'guard'],
    resourceTypes: [TASKDEF],
    remediation: 'Remove `privileged: true`.',
    evaluate: perContainer((c, base) =>
      c['Privileged'] === true ? [finding(`${base}/Privileged`, `${label(c)} is privileged.`)] : [],
    ),
  },
  {
    id: 'BASE-ECS-004',
    title: 'Task definitions use awsvpc networking',
    description: 'Task definitions set NetworkMode to awsvpc.',
    rationale:
      'awsvpc gives each task its own ENI and security group, enabling least-privilege network rules.',
    severity: 'medium',
    engines: ['cdk-nag', 'guard'],
    resourceTypes: [TASKDEF],
    remediation:
      'Use FargateTaskDefinition (always awsvpc) or set `networkMode: NetworkMode.AWS_VPC`.',
    evaluate: ({ resource }) =>
      props(resource)['NetworkMode'] === 'awsvpc'
        ? []
        : [finding('Properties/NetworkMode', 'NetworkMode must be awsvpc.')],
  },
  {
    id: 'BASE-ECS-005',
    title: 'Containers ship logs',
    description:
      'Every container definition has a LogConfiguration using the awslogs or awsfirelens driver.',
    rationale: 'Container stdout/stderr is otherwise lost when the task stops.',
    severity: 'medium',
    engines: ['cdk-nag', 'guard'],
    resourceTypes: [TASKDEF],
    remediation: 'Set `logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix })`.',
    evaluate: perContainer((c, base) => {
      const driver = get(c, 'LogConfiguration', 'LogDriver');
      return typeof driver === 'string' &&
        (ALLOWED_LOG_DRIVERS as readonly string[]).includes(driver)
        ? []
        : [
            finding(
              `${base}/LogConfiguration`,
              `${label(c)} has no awslogs/awsfirelens LogConfiguration.`,
            ),
          ];
    }),
  },
  {
    id: 'BASE-ECS-006',
    title: 'No credentials in plain-text container environment',
    description:
      'No container `Environment` variable name ends in PASSWORD, PASSWD, SECRET, TOKEN, API_KEY, PRIVATE_KEY or ACCESS_KEY; such values must be injected through `Secrets` (Secrets Manager / SSM).',
    rationale:
      'Plain-text environment values are visible in the task definition, the console and CloudFormation.',
    severity: 'high',
    engines: ['cdk-nag', 'guard'],
    resourceTypes: [TASKDEF],
    remediation:
      'Use `secrets: { DB_PASSWORD: ecs.Secret.fromSecretsManager(secret, "password") }`.',
    evaluate: perContainer((c, base) =>
      asArray(c['Environment']).flatMap((env, j) => {
        const name = get(env, 'Name');
        return typeof name === 'string' && SECRET_ENV_NAME_PATTERN.test(name)
          ? [
              finding(
                `${base}/Environment/${j}/Name`,
                `${label(c)} sets ${name} as a plain environment variable.`,
              ),
            ]
          : [];
      }),
    ),
  },
  {
    id: 'BASE-ECS-007',
    title: 'ECS services do not assign public IPs',
    description: 'ECS services do not set AwsvpcConfiguration.AssignPublicIp to ENABLED.',
    rationale:
      'Tasks belong in private subnets behind the ALB; egress goes through NAT or VPC endpoints.',
    severity: 'high',
    engines: ['cdk-nag', 'guard'],
    resourceTypes: ['AWS::ECS::Service'],
    remediation: 'Place tasks in private subnets and leave `assignPublicIp` false.',
    evaluate: ({ resource }) =>
      get(props(resource), 'NetworkConfiguration', 'AwsvpcConfiguration', 'AssignPublicIp') ===
      'ENABLED'
        ? [
            finding(
              'Properties/NetworkConfiguration/AwsvpcConfiguration/AssignPublicIp',
              'Service assigns public IPs to tasks.',
            ),
          ]
        : [],
  },
  {
    id: 'BASE-ECS-008',
    title: 'Task definitions carry no local/CI relaxations',
    description:
      'No container sets APP_RUNTIME other than aws, AUTH_ALLOW_INSECURE_ISSUER, an http: AUTH_ISSUER or AUTH_JWKS_URI, DB_SSL other than verify-full (a DB_HOST needs an explicit DB_SSL=verify-full), or DB_PASSWORD (environment or secrets); a container that verifies tokens (AUTH_ISSUER or AUTH_AUDIENCE) sets a non-empty AUTH_ALLOWED_CLIENT_IDS.',
    rationale:
      'Local and CI relaxations (test issuer over http, database TLS off, password authentication) key on APP_RUNTIME, which CDK never sets; a deployed task that carries one runs with production data and weakened controls.',
    severity: 'high',
    engines: ['cdk-nag', 'guard'],
    resourceTypes: [TASKDEF],
    remediation:
      'Remove the variable from the task definition; use DB_AUTH=iam with DB_SSL=verify-full and an https issuer; set AUTH_ALLOWED_CLIENT_IDS to the SPA client id.',
    notes:
      'Deployed-runtime settings (ADR 0511); client allow-list: an intrinsic or an ECS secret value is accepted (it cannot be evaluated at synth time). No exemptions.',
    evaluate: perContainer((c, base) => {
      const entries = containerEntries(c, base);
      return [
        ...relaxationFindings(entries, label(c)),
        ...clientAllowListFindings(entries, label(c)),
      ];
    }),
  },
  {
    id: 'BASE-ECS-009',
    title: 'Task definitions authenticate to PostgreSQL with IAM',
    description:
      'No container sets DB_AUTH other than iam (a DB_HOST needs an explicit DB_AUTH=iam), a DB_*SECRET* variable such as DB_SECRET_ARN, or injects a DB_* value from Secrets Manager.',
    rationale:
      'Runtime roles use short-lived RDS IAM tokens; a database secret (above all the RDS master secret) in a task definition gives every holder of the task role long-lived database credentials.',
    severity: 'high',
    engines: ['cdk-nag', 'guard'],
    resourceTypes: [TASKDEF],
    remediation: 'Set DB_AUTH=iam and grant rds-db:connect for the task role database user.',
    notes:
      'ADRs 0221 and 0511. Only the one-off database bootstrap task (break-glass, master secret) may be exempted, by a governed exception on exactly its task definition.',
    evaluate: perContainer((c, base) => databaseAuthFindings(containerEntries(c, base), label(c))),
  },
];
