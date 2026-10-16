import { Size, type Duration } from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as kms from 'aws-cdk-lib/aws-kms';
import type * as logs from 'aws-cdk-lib/aws-logs';
import type * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';

/**
 * Runtime user of the API image: distroless `nodejs24-debian13:nonroot`
 * (`apps/api/Dockerfile`, uid/gid 65532). Set explicitly so the task never runs
 * as root even if an image lacks a USER.
 */
export const NODE_CONTAINER_USER = '65532:65532';
/** Node binary in the distroless image (no shell, not on PATH). */
export const NODE_BINARY = '/nodejs/bin/node';
const TMP_VOLUME = 'tmp';

/**
 * Path of the vendored Amazon RDS CA bundle inside the API image (`apps/api/Dockerfile` copies
 * `packages/db/certs/rds-global-bundle.pem` there). Every task that sets `DB_HOST` verifies the
 * server against it (`DB_SSL=verify-full`, ADR 0222).
 */
export const IMAGE_RDS_CA_BUNDLE_PATH = '/app/certs/rds-global-bundle.pem';

/**
 * How a task authenticates to PostgreSQL (ADR 0221):
 * - `iam`: RDS IAM authentication; the task role holds `rds-db:connect` for exactly its database
 *   user and `@starter/db` signs a token per new connection. No credential in the task definition.
 * - `secrets-manager`: ONLY the one-off bootstrap task (master user): `@starter/db` reads the secret at
 *   connect time with the task role; the task definition carries only the secret ARN (governed
 *   exception to BASE-ECS-009).
 */
export type DatabaseAuthentication =
  | { readonly mode: 'iam' }
  | { readonly mode: 'secrets-manager'; readonly secret: secretsmanager.ISecret };

/** PostgreSQL connection settings of one task (API service, migration or bootstrap task). */
export interface DatabaseConnection {
  readonly host: string;
  readonly port: number;
  readonly name: string;
  /** Database user: `starter_app`, `starter_migrator`, ... or the master user (bootstrap). */
  readonly user: string;
  readonly auth: DatabaseAuthentication;
  /** CMK encrypting the secret (`secrets-manager` only; granted explicitly to the task role). */
  readonly secretKey?: kms.IKey;
  /** `DB_POOL_MAX` for this task; omitted = the application default. */
  readonly poolMax?: number;
  /** CA bundle path at runtime. @default IMAGE_RDS_CA_BUNDLE_PATH (API image) */
  readonly sslRootCertPath?: string;
}

/**
 * `DB_*` variables. Always explicit `DB_AUTH` and `DB_SSL=verify-full`:
 * BASE-ECS-008/009 reject defaults.
 */
export function databaseEnvironment(db: DatabaseConnection): Record<string, string> {
  return {
    DB_HOST: db.host,
    DB_PORT: String(db.port),
    DB_NAME: db.name,
    DB_USER: db.user,
    DB_AUTH: db.auth.mode,
    ...(db.auth.mode === 'secrets-manager' ? { DB_SECRET_ARN: db.auth.secret.secretArn } : {}),
    DB_SSL: 'verify-full',
    DB_SSL_ROOT_CERT: db.sslRootCertPath ?? IMAGE_RDS_CA_BUNDLE_PATH,
    ...(db.poolMax !== undefined ? { DB_POOL_MAX: String(db.poolMax) } : {}),
  };
}

/**
 * ECS-injected database secrets: none. IAM tokens are generated in-process and the bootstrap reads
 * the master secret itself, so no task definition holds a database credential.
 */
export function databaseSecrets(_db: DatabaseConnection): Record<string, ecs.Secret> {
  return {};
}

export interface HardenedNodeContainerProps {
  readonly containerName: string;
  readonly image: ecs.ContainerImage;
  readonly logGroup: logs.ILogGroup;
  readonly streamPrefix: string;
  readonly environment: Record<string, string>;
  readonly secrets?: Record<string, ecs.Secret>;
  /** Arguments to the image ENTRYPOINT (`/nodejs/bin/node`). */
  readonly command?: string[];
  readonly portMappings?: ecs.PortMapping[];
  readonly healthCheck?: ecs.HealthCheck;
  readonly stopTimeout?: Duration;
}

/**
 * Adds the single container of a Fargate task with the container
 * baseline: non-root user, read-only root filesystem (+ writable `/tmp`
 * volume), not privileged, ALL Linux capabilities dropped, init process,
 * non-blocking awslogs into a CMK-encrypted group.
 */
export function addHardenedNodeContainer(
  taskDefinition: ecs.FargateTaskDefinition,
  props: HardenedNodeContainerProps,
): ecs.ContainerDefinition {
  taskDefinition.addVolume({ name: TMP_VOLUME });
  const linuxParameters = new ecs.LinuxParameters(
    taskDefinition,
    `${props.containerName}LinuxParameters`,
    { initProcessEnabled: true },
  );
  linuxParameters.dropCapabilities(ecs.Capability.ALL);

  const container = taskDefinition.addContainer(props.containerName, {
    containerName: props.containerName,
    image: props.image,
    essential: true,
    user: NODE_CONTAINER_USER,
    readonlyRootFilesystem: true,
    privileged: false,
    linuxParameters,
    command: props.command,
    portMappings: props.portMappings,
    healthCheck: props.healthCheck,
    stopTimeout: props.stopTimeout,
    logging: ecs.LogDrivers.awsLogs({
      logGroup: props.logGroup,
      streamPrefix: props.streamPrefix,
      mode: ecs.AwsLogDriverMode.NON_BLOCKING,
      maxBufferSize: Size.mebibytes(25),
    }),
    environment: props.environment,
    secrets: props.secrets,
  });
  container.addMountPoints({ sourceVolume: TMP_VOLUME, containerPath: '/tmp', readOnly: false });
  return container;
}

/**
 * `secret.grantRead()` expresses the KMS part as a key-policy grant, which CDK
 * silently drops for imported (foundation) keys; grant it on the role instead.
 */
export function grantSecretKeyDecrypt(role: iam.IRole, key: kms.IKey, region: string): void {
  role.addToPrincipalPolicy(
    new iam.PolicyStatement({
      sid: 'DecryptDbSecretViaSecretsManager',
      actions: ['kms:Decrypt'],
      resources: [key.keyArn],
      conditions: { StringEquals: { 'kms:ViaService': `secretsmanager.${region}.amazonaws.com` } },
    }),
  );
}
