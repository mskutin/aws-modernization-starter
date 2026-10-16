import { ArnFormat, Aws, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import type * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import type * as route53 from 'aws-cdk-lib/aws-route53';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { RegionInfo } from 'aws-cdk-lib/region-info';
import { Construct } from 'constructs';
import type { SandboxFoundationConfig } from '../../environments/schema.js';
import { acknowledgeCfnValidate, acknowledgeRule } from '../../lib/policy-hook.js';
import { importEdge } from './imported-foundation.js';
import type { ILandingZoneFoundation } from './types.js';

export interface SandboxFoundationProps {
  readonly config: SandboxFoundationConfig;
  readonly resourcePrefix: string;
  readonly logRetention: logs.RetentionDays;
  /**
   * Live sandbox only: the operator's IAM role, granted use of the data key through DynamoDB
   * and Step Functions (see `SANDBOX_OPERATOR_KEY_ACTIONS`), and of the logs key through CloudWatch
   * Logs (decrypt only).
   */
  readonly operatorPrincipalArn?: string;
  /**
   * Live sandbox only: allow `delivery.logs.amazonaws.com` to decrypt with the data key, as
   * Step Functions requires for a CMK-encrypted state machine that logs to CloudWatch Logs.
   * CDK adds that statement only to keys in the state machine's own stack; consumers
   * import this key by ARN, so the foundation must carry it. @default false
   */
  readonly stepFunctionsLogDelivery?: boolean;
}

/**
 * What the sandbox operator may do with the data key, and only through DynamoDB and Step Functions
 * (`kms:ViaService`): read and write the CMK-encrypted job table (GetItem/Scan/PutItem) and read
 * execution input, output and history (DescribeExecution, GetExecutionHistory). Nothing direct.
 */
export const SANDBOX_OPERATOR_KEY_ACTIONS = [
  'kms:Decrypt',
  'kms:Encrypt',
  'kms:GenerateDataKey*',
  'kms:ReEncrypt*',
  'kms:DescribeKey',
] as const;
export const SANDBOX_OPERATOR_KEY_SID = 'SandboxOperatorViaDynamoDbAndStepFunctions';
/** Data key: Step Functions execution-log delivery. */
export const STEP_FUNCTIONS_LOG_DELIVERY_SID = 'StepFunctionsLogDeliveryDecrypt';
/** Logs key: the sandbox operator reads CMK-encrypted log groups through CloudWatch Logs. */
export const SANDBOX_OPERATOR_LOGS_KEY_SIDS = {
  decrypt: 'SandboxOperatorDecryptViaCloudWatchLogs',
  describe: 'SandboxOperatorDescribeViaCloudWatchLogs',
} as const;

/**
 * OPT-IN minimal foundation for an isolated sandbox account ONLY. It creates
 * what a landing zone would normally provide: a 3-tier VPC (ingress /
 * app / data) with flow logs and gateway endpoints, two CMKs and an
 * access-log bucket. It is NOT a landing zone; staging/prod configs are
 * rejected if they select it.
 *
 * The live-validation sandbox (`accessLogs: false`, `flowLogs: reject`) creates no access-log
 * bucket and logs only rejected flows, so `cdk destroy` leaves nothing behind.
 */
export class SandboxFoundation extends Construct implements ILandingZoneFoundation {
  public readonly mode = 'sandbox' as const;
  public readonly vpc: ec2.Vpc;
  public readonly appSubnets: ec2.SubnetSelection = { subnetGroupName: 'app' };
  public readonly ingressSubnets: ec2.SubnetSelection = { subnetGroupName: 'ingress' };
  public readonly dataSubnets: ec2.SubnetSelection = { subnetGroupName: 'data' };
  public readonly dataKey: kms.Key;
  public readonly logsKey: kms.Key;
  public readonly accessLogsBucket?: s3.Bucket;
  public readonly permissionsBoundary?: iam.IManagedPolicy;
  public readonly albCertificate?: acm.ICertificate;
  public readonly apiOriginDomainName?: string;
  public readonly cloudFrontCertificate?: acm.ICertificate;
  public readonly webDomainName?: string;
  public readonly hostedZone?: route53.IHostedZone;
  public readonly wafWebAclArn?: string;
  public readonly cloudFrontOriginFacingPrefixListId: string;
  public readonly mandatoryTags: Readonly<Record<string, string>>;

  constructor(scope: Construct, id: string, props: SandboxFoundationProps) {
    super(scope, id);
    const { config, resourcePrefix } = props;
    const region = Stack.of(this).region;

    this.logsKey = new kms.Key(this, 'LogsKey', {
      alias: `alias/${resourcePrefix}/logs`,
      description: `${resourcePrefix} sandbox CMK for CloudWatch Logs`,
      enableKeyRotation: true,
      pendingWindow: Duration.days(7),
      removalPolicy: RemovalPolicy.DESTROY,
    });
    this.logsKey.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowCloudWatchLogs',
        principals: [new iam.ServicePrincipal(`logs.${region}.amazonaws.com`)],
        actions: [
          'kms:Encrypt*',
          'kms:Decrypt*',
          'kms:ReEncrypt*',
          'kms:GenerateDataKey*',
          'kms:Describe*',
        ],
        resources: ['*'],
        conditions: {
          ArnLike: {
            'kms:EncryptionContext:aws:logs:arn': `arn:${Aws.PARTITION}:logs:${region}:${Aws.ACCOUNT_ID}:log-group:*`,
          },
        },
      }),
    );
    if (props.operatorPrincipalArn) {
      // CloudWatch Logs user guide, "Encrypt log data in CloudWatch Logs using AWS KMS", Step 3
      // "Permissions for reading and writing encrypted log data": callers of GetLogEvents,
      // FilterLogEvents or StartQuery need KMS permissions through kms:ViaService logs.<region>.
      // The operator reads only: Decrypt (bound to this account's log groups by the encryption
      // context CloudWatch Logs sets) and DescribeKey (no encryption context).
      const viaLogs = { 'kms:ViaService': `logs.${region}.amazonaws.com` };
      this.logsKey.addToResourcePolicy(
        new iam.PolicyStatement({
          sid: SANDBOX_OPERATOR_LOGS_KEY_SIDS.decrypt,
          principals: [new iam.ArnPrincipal(props.operatorPrincipalArn)],
          actions: ['kms:Decrypt'],
          resources: ['*'],
          conditions: {
            StringEquals: viaLogs,
            ArnLike: {
              'kms:EncryptionContext:aws:logs:arn': `arn:${Aws.PARTITION}:logs:${region}:${Aws.ACCOUNT_ID}:log-group:*`,
            },
          },
        }),
      );
      this.logsKey.addToResourcePolicy(
        new iam.PolicyStatement({
          sid: SANDBOX_OPERATOR_LOGS_KEY_SIDS.describe,
          principals: [new iam.ArnPrincipal(props.operatorPrincipalArn)],
          actions: ['kms:DescribeKey'],
          resources: ['*'],
          conditions: { StringEquals: viaLogs },
        }),
      );
    }
    this.dataKey = new kms.Key(this, 'DataKey', {
      alias: `alias/${resourcePrefix}/data`,
      description: `${resourcePrefix} sandbox CMK for data at rest`,
      enableKeyRotation: true,
      pendingWindow: Duration.days(7),
      removalPolicy: RemovalPolicy.DESTROY,
    });
    if (props.stepFunctionsLogDelivery) {
      // AWS Step Functions developer guide, "Data at rest encryption", Step 3 "Add key policy to
      // encrypt CloudWatch logs": allow delivery.logs.amazonaws.com kms:Decrypt. Scoped with the
      // encryption context of the log data keys: the execution role generates them with
      // kms:EncryptionContext:SourceArn = arn:aws:logs:<region>:<account>:* (same guide; the
      // Workflow stack's role statement), and a Decrypt must present the same context.
      this.dataKey.addToResourcePolicy(
        new iam.PolicyStatement({
          sid: STEP_FUNCTIONS_LOG_DELIVERY_SID,
          principals: [new iam.ServicePrincipal('delivery.logs.amazonaws.com')],
          actions: ['kms:Decrypt'],
          resources: ['*'],
          conditions: {
            StringLike: {
              'kms:EncryptionContext:SourceArn': Stack.of(this).formatArn({
                service: 'logs',
                resource: '*',
                arnFormat: ArnFormat.NO_RESOURCE_NAME,
              }),
            },
          },
        }),
      );
    }
    // The data key encrypts the job table and the state machine (history, input/output). The
    // operator's own IAM policies have no KMS actions, so the key policy names the role directly.
    if (props.operatorPrincipalArn) {
      this.dataKey.addToResourcePolicy(
        new iam.PolicyStatement({
          sid: SANDBOX_OPERATOR_KEY_SID,
          principals: [new iam.ArnPrincipal(props.operatorPrincipalArn)],
          actions: [...SANDBOX_OPERATOR_KEY_ACTIONS],
          resources: ['*'],
          conditions: {
            StringEquals: {
              'kms:ViaService': [
                `dynamodb.${region}.amazonaws.com`,
                `states.${region}.amazonaws.com`,
              ],
            },
          },
        }),
      );
    }

    if (config.accessLogs) {
      const bucket = new s3.Bucket(this, 'AccessLogsBucket', {
        encryption: s3.BucketEncryption.S3_MANAGED, // ALB access logs require SSE-S3
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        enforceSSL: true,
        minimumTLSVersion: 1.2,
        // CloudFront standard logging writes objects with ACLs.
        objectOwnership: s3.ObjectOwnership.OBJECT_WRITER,
        lifecycleRules: [{ id: 'expire-access-logs', expiration: Duration.days(90) }],
        removalPolicy: RemovalPolicy.RETAIN,
      });
      this.accessLogsBucket = bucket;
      acknowledgeRule(
        bucket,
        'AwsSolutions-S1',
        'This bucket is itself the server-access-log destination; logging it into itself would loop.',
      );
      // Grants consumers would add are pre-authorised here, because consumers in
      // other stacks reference this bucket as an import (no policy edits/cycles).
      bucket.addToResourcePolicy(
        new iam.PolicyStatement({
          sid: 'S3ServerAccessLogs',
          principals: [new iam.ServicePrincipal('logging.s3.amazonaws.com')],
          actions: ['s3:PutObject'],
          resources: [bucket.arnForObjects('s3/*')],
          conditions: { StringEquals: { 'aws:SourceAccount': Aws.ACCOUNT_ID } },
        }),
      );
      const elbAccount = RegionInfo.get(region).elbv2Account;
      bucket.addToResourcePolicy(
        new iam.PolicyStatement({
          sid: 'AlbAccessLogs',
          principals: [
            elbAccount
              ? new iam.AccountPrincipal(elbAccount)
              : new iam.ServicePrincipal('logdelivery.elasticloadbalancing.amazonaws.com'),
          ],
          actions: ['s3:PutObject'],
          resources: [bucket.arnForObjects(`alb/AWSLogs/${Aws.ACCOUNT_ID}/*`)],
        }),
      );
    }

    const flowLogGroup = new logs.LogGroup(this, 'FlowLogs', {
      logGroupName: `/starter/${resourcePrefix}/vpc-flow-logs`,
      retention: props.logRetention,
      encryptionKey: this.logsKey,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr(config.vpcCidr),
      // Explicit AZs: avoids the availability-zones context lookup (offline synth).
      availabilityZones: config.availabilityZones,
      natGateways: config.natGateways,
      // Avoids a custom-resource Lambda; the default SG is never used.
      restrictDefaultSecurityGroup: false,
      subnetConfiguration: [
        {
          name: 'ingress',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
          mapPublicIpOnLaunch: false,
        },
        { name: 'app', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 22 },
        { name: 'data', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
      gatewayEndpoints: {
        S3: { service: ec2.GatewayVpcEndpointAwsService.S3 },
        DynamoDB: { service: ec2.GatewayVpcEndpointAwsService.DYNAMODB },
      },
      flowLogs: {
        // Construct id = traffic type ('all' keeps the dev sandbox template unchanged).
        [config.flowLogs]: {
          destination: ec2.FlowLogDestination.toCloudWatchLogs(flowLogGroup),
          trafficType:
            config.flowLogs === 'reject'
              ? ec2.FlowLogTrafficType.REJECT
              : ec2.FlowLogTrafficType.ALL,
        },
      },
    });

    acknowledgeCfnValidate(
      this.vpc,
      'W3010',
      'AZs are pinned explicitly in config so synth needs no availability-zones lookup (offline CI); sandbox only.',
    );

    this.permissionsBoundary = config.permissionsBoundaryPolicyArn
      ? iam.ManagedPolicy.fromManagedPolicyArn(
          this,
          'PermissionsBoundary',
          config.permissionsBoundaryPolicyArn,
        )
      : undefined;

    const edge = importEdge(this, config.edge);
    this.albCertificate = edge.albCertificate;
    this.apiOriginDomainName = edge.apiOriginDomainName;
    this.cloudFrontCertificate = edge.cloudFrontCertificate;
    this.webDomainName = edge.webDomainName;
    this.hostedZone = edge.hostedZone;
    this.wafWebAclArn = edge.wafWebAclArn;
    this.cloudFrontOriginFacingPrefixListId = edge.cloudFrontOriginFacingPrefixListId;
    this.mandatoryTags = config.mandatoryTags;
  }
}
