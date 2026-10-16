/** Tag index, CloudFormation, CloudFront, CloudWatch (logs, alarms, dashboards), IAM, SNS, SSM. */
import { BOOTSTRAP_VERSION_PARAMETER } from '../aws/allowlist.js';
import { EXPERIMENT_TAG, EXPERIMENT_VALUE, normalizeArn, RUN_ID_TAG } from '../match.js';
import { HOURS_PER_MONTH } from '../model/prices.js';
import {
  call,
  items,
  iso,
  num,
  obj,
  outcome,
  record,
  str,
  tagMap,
  type SweepEnv,
  type SweepOutcome,
} from './common.js';

/** Reads the regional tag index for the run and the experiment tags (fills env.match.taggedArns). */
export async function sweepTagIndex(
  env: SweepEnv,
): Promise<SweepOutcome & { arns: Map<string, Record<string, string>> }> {
  const out = outcome('resourcegroupstaggingapi');
  const arns = new Map<string, Record<string, string>>();
  for (const filter of [
    `Key=${RUN_ID_TAG},Values=${env.runId}`,
    `Key=${EXPERIMENT_TAG},Values=${EXPERIMENT_VALUE}`,
  ]) {
    const r = await call(env, out, 'resourcegroupstaggingapi', 'get-resources', [
      '--tag-filters',
      filter,
    ]);
    for (const m of items(r, 'ResourceTagMappingList')) {
      const arn = str(m['ResourceARN']);
      if (arn) arns.set(normalizeArn(arn), tagMap(m['Tags']));
    }
  }
  return { ...out, arns };
}

export async function sweepCloudFormation(env: SweepEnv): Promise<SweepOutcome> {
  const out = outcome('cloudformation');
  for (const s of items(await call(env, out, 'cloudformation', 'describe-stacks'), 'Stacks')) {
    const name = str(s['StackName']);
    const arn = str(s['StackId']);
    if (!name) continue;
    const status = str(s['StackStatus']);
    record(
      env,
      out,
      { names: [name], tags: tagMap(s['Tags']), arn },
      {
        service: 'cloudformation',
        resourceType: 'AWS::CloudFormation::Stack',
        id: name,
        name,
        state: status,
        createdAt: iso(s['CreationTime']),
        disposition: status === 'DELETE_COMPLETE' ? 'gone' : 'exists',
        note:
          status === 'DELETE_FAILED'
            ? 'DELETE_FAILED: inspect stack events, clear the blocker, delete again'
            : s['EnableTerminationProtection'] === true
              ? 'termination protection is enabled'
              : status?.endsWith('_IN_PROGRESS')
                ? 'operation in progress; re-run when it settles'
                : undefined,
      },
    );
  }
  return out;
}

export async function sweepCloudFront(env: SweepEnv): Promise<SweepOutcome> {
  const out = outcome('cloudfront');
  // Summaries include origin custom headers (the origin-verify value): only the fields below are
  // read; nothing else of the response is kept.
  const list = obj(
    obj(await call(env, out, 'cloudfront', 'list-distributions'))['DistributionList'],
  );
  for (const d of items(list, 'Items')) {
    const id = str(d['Id']);
    const arn = str(d['ARN']);
    if (!id) continue;
    const tagsRes = arn
      ? await call(env, out, 'cloudfront', 'list-tags-for-resource', ['--resource', arn], {
          notFoundIsEmpty: true,
        })
      : undefined;
    const tags = tagMap(obj(obj(tagsRes)['Tags'])['Items']);
    const enabled = d['Enabled'] === true;
    record(
      env,
      out,
      { names: [str(d['Comment'])], tags, arn },
      {
        service: 'cloudfront',
        resourceType: 'AWS::CloudFront::Distribution',
        id,
        name: str(d['DomainName']),
        state: `${str(d['Status']) ?? 'unknown'}, ${enabled ? 'enabled' : 'disabled'}`,
        disposition: 'exists',
        note: enabled
          ? 'enabled distribution (requests and data transfer bill)'
          : 'disabled distribution still exists; delete it after it is Deployed',
      },
    );
  }
  const simple = async (
    operation: string,
    listKey: string,
    type: string,
    pick: (i: Record<string, unknown>) => {
      id?: string | undefined;
      name?: string | undefined;
      created?: unknown;
    },
    args: string[] = [],
  ) => {
    const l = obj(obj(await call(env, out, 'cloudfront', operation, args))[listKey]);
    for (const i of items(l, 'Items')) {
      const { id, name, created } = pick(i);
      if (!id) continue;
      record(
        env,
        out,
        { names: [name] },
        {
          service: 'cloudfront',
          resourceType: type,
          id,
          name,
          createdAt: iso(created),
          disposition: 'exists',
        },
      );
    }
  };
  await simple(
    'list-origin-access-controls',
    'OriginAccessControlList',
    'AWS::CloudFront::OriginAccessControl',
    (i) => ({ id: str(i['Id']), name: str(i['Name']) }),
  );
  await simple('list-functions', 'FunctionList', 'AWS::CloudFront::Function', (i) => ({
    id: str(i['Name']),
    name: str(i['Name']),
    created: obj(i['FunctionMetadata'])['CreatedTime'],
  }));
  await simple(
    'list-cache-policies',
    'CachePolicyList',
    'AWS::CloudFront::CachePolicy',
    (i) => {
      const p = obj(i['CachePolicy']);
      return { id: str(p['Id']), name: str(obj(p['CachePolicyConfig'])['Name']) };
    },
    ['--type', 'custom'],
  );
  await simple(
    'list-response-headers-policies',
    'ResponseHeadersPolicyList',
    'AWS::CloudFront::ResponseHeadersPolicy',
    (i) => {
      const p = obj(i['ResponseHeadersPolicy']);
      return { id: str(p['Id']), name: str(obj(p['ResponseHeadersPolicyConfig'])['Name']) };
    },
    ['--type', 'custom'],
  );
  await simple(
    'list-origin-request-policies',
    'OriginRequestPolicyList',
    'AWS::CloudFront::OriginRequestPolicy',
    (i) => {
      const p = obj(i['OriginRequestPolicy']);
      return { id: str(p['Id']), name: str(obj(p['OriginRequestPolicyConfig'])['Name']) };
    },
    ['--type', 'custom'],
  );
  const vpcOrigins = obj(
    obj(await call(env, out, 'cloudfront', 'list-vpc-origins'))['VpcOriginList'],
  );
  for (const v of items(vpcOrigins, 'Items')) {
    const id = str(v['Id']);
    if (!id) continue;
    const endpoint = str(v['OriginEndpointArn']);
    record(
      env,
      out,
      { names: [str(v['Name']), endpoint?.split('/')[2]], arn: str(v['Arn']) },
      {
        service: 'cloudfront',
        resourceType: 'AWS::CloudFront::VpcOrigin',
        id,
        name: str(v['Name']),
        state: str(v['Status']),
        createdAt: iso(v['CreatedTime']),
        disposition: 'exists',
        note: 'its service-managed security group blocks VPC deletion until the VPC origin is gone',
      },
    );
  }
  return out;
}

export async function sweepCloudWatch(env: SweepEnv): Promise<SweepOutcome> {
  const out = outcome('logs');
  const { book } = env;
  for (const g of items(await call(env, out, 'logs', 'describe-log-groups'), 'logGroups')) {
    const name = str(g['logGroupName']);
    if (!name) continue;
    const gb = (num(g['storedBytes']) ?? 0) / 1e9;
    record(
      env,
      out,
      { names: [name], arn: str(g['logGroupArn']) ?? str(g['arn']) },
      {
        service: 'logs',
        resourceType: 'AWS::Logs::LogGroup',
        id: name,
        name,
        createdAt: iso(g['creationTime']),
        state: `retention ${num(g['retentionInDays']) ?? 'never expires'}`,
        disposition: 'exists',
        hourlyUsdIfLeft: (gb * book.logStorageGbMonth.usd) / HOURS_PER_MONTH,
      },
    );
  }
  const alarms = await call(env, out, 'cloudwatch', 'describe-alarms');
  for (const a of [...items(alarms, 'MetricAlarms'), ...items(alarms, 'CompositeAlarms')]) {
    const name = str(a['AlarmName']);
    if (!name) continue;
    record(
      env,
      out,
      { names: [name], arn: str(a['AlarmArn']) },
      {
        service: 'cloudwatch',
        resourceType: 'AWS::CloudWatch::Alarm',
        id: name,
        name,
        state: str(a['StateValue']),
        disposition: 'exists',
        hourlyUsdIfLeft: book.alarmMonth.usd / HOURS_PER_MONTH,
      },
    );
  }
  for (const d of items(
    await call(env, out, 'cloudwatch', 'list-dashboards'),
    'DashboardEntries',
  )) {
    const name = str(d['DashboardName']);
    if (!name) continue;
    record(
      env,
      out,
      { names: [name], arn: str(d['DashboardArn']) },
      {
        service: 'cloudwatch',
        resourceType: 'AWS::CloudWatch::Dashboard',
        id: name,
        name,
        disposition: 'exists',
        hourlyUsdIfLeft: book.extra.cloudwatchDashboardMonth.usd / HOURS_PER_MONTH,
      },
    );
  }
  return out;
}

export async function sweepIamSns(env: SweepEnv): Promise<SweepOutcome> {
  const out = outcome('iam');
  for (const r of items(await call(env, out, 'iam', 'list-roles'), 'Roles')) {
    const name = str(r['RoleName']);
    if (!name || str(r['Path'])?.startsWith('/aws-service-role/')) continue;
    record(
      env,
      out,
      { names: [name], arn: str(r['Arn']) },
      {
        service: 'iam',
        resourceType: 'AWS::IAM::Role',
        id: name,
        name,
        createdAt: iso(r['CreateDate']),
        disposition: 'exists',
      },
    );
  }
  for (const p of items(
    await call(env, out, 'iam', 'list-policies', ['--scope', 'Local']),
    'Policies',
  )) {
    const name = str(p['PolicyName']);
    if (!name) continue;
    record(
      env,
      out,
      { names: [name], arn: str(p['Arn']) },
      {
        service: 'iam',
        resourceType: 'AWS::IAM::ManagedPolicy',
        id: name,
        name,
        createdAt: iso(p['CreateDate']),
        disposition: 'exists',
      },
    );
  }
  for (const t of items(await call(env, out, 'sns', 'list-topics'), 'Topics')) {
    const arn = str(t['TopicArn']);
    if (!arn) continue;
    const name = arn.split(':').pop() ?? arn;
    record(
      env,
      out,
      { names: [name], arn },
      { service: 'sns', resourceType: 'AWS::SNS::Topic', id: name, name, disposition: 'exists' },
    );
  }
  return out;
}

/**
 * SSM: the experiment stacks create no SSM parameter; the only one involved is the CDK bootstrap
 * version parameter of the `starter` qualifier. It is checked by name with the reviewed, pinned
 * `ssm get-parameters --names /cdk-bootstrap/starter/version` (the role has GetParameters, not
 * DescribeParameters); its value is never kept.
 */
export async function sweepSsm(env: SweepEnv): Promise<SweepOutcome> {
  const out = outcome('ssm');
  out.evidence.push(
    `only ${BOOTSTRAP_VERSION_PARAMETER} is checked: the Sandbox stage and the mini-stack create no SSM parameter`,
  );
  const r = await call(env, out, 'ssm', 'get-parameters', ['--names', BOOTSTRAP_VERSION_PARAMETER]);
  for (const p of items(r, 'Parameters')) {
    const name = str(p['Name']);
    if (name !== BOOTSTRAP_VERSION_PARAMETER) continue;
    record(
      env,
      out,
      { names: [name] },
      {
        service: 'ssm',
        resourceType: 'AWS::SSM::Parameter',
        id: name,
        name,
        disposition: 'exists',
        note: `CDK bootstrap version parameter, version ${num(p['Version']) ?? 'unknown'}, last modified ${iso(p['LastModifiedDate']) ?? 'unknown'} (value not kept)`,
      },
    );
  }
  return out;
}
