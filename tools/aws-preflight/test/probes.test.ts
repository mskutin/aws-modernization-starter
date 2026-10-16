/** Probes checked exactly as verified with `aws <service> <operation> help` (2.35.11). */
import { describe, expect, it } from 'vitest';
import { PROBES_BY_ID } from '../src/probes.ts';
import { P } from '../src/projections.ts';
import { createSanitizer } from '../src/sanitize.ts';
import { ROLE, SANDBOX, SESSION } from './support.ts';

const def = (id: string) => {
  const d = PROBES_BY_ID.get(id);
  if (!d) throw new Error(`missing ${id}`);
  return d;
};
const s = () => createSanitizer({ sandboxAccount: SANDBOX, sessionName: SESSION });

describe('probe definitions', () => {
  it.each([
    [
      'identity.role-inline-policy',
      'iam get-role-policy',
      ['--role-name={roleName}', '--policy-name={policyName}'],
      'iam:GetRolePolicy',
      ['ap-southeast-1'],
    ],
    [
      'identity.customer-policy',
      'iam get-policy',
      ['--policy-arn={customerPolicyArn}'],
      'iam:GetPolicy',
      ['ap-southeast-1'],
    ],
    [
      'identity.customer-policy-version',
      'iam get-policy-version',
      ['--policy-arn={customerPolicyArn}', '--version-id={policyVersionId}'],
      'iam:GetPolicyVersion',
      ['ap-southeast-1'],
    ],
    [
      'c.logs.resource-policies',
      'logs describe-resource-policies',
      [],
      'logs:DescribeResourcePolicies',
      ['ap-southeast-1'],
    ],
    [
      'a.cfn.hook-types-public',
      'cloudformation list-types',
      ['--visibility', 'PUBLIC', '--type', 'HOOK', '--filters', 'Category=ACTIVATED'],
      'cloudformation:ListTypes',
      ['ap-southeast-1'],
    ],
    [
      'a.cfn.hook-types-private',
      'cloudformation list-types',
      ['--visibility', 'PRIVATE', '--type', 'HOOK', '--filters', 'Category=ACTIVATED'],
      'cloudformation:ListTypes',
      ['ap-southeast-1'],
    ],
    [
      'c.quotas.lambda-concurrency-default',
      'service-quotas get-aws-default-service-quota',
      ['--service-code', 'lambda', '--quota-code', 'L-B99A9384'],
      'servicequotas:GetAWSDefaultServiceQuota',
      ['ap-southeast-1'],
    ],
    [
      'c.quotas.lambda-concurrency-requests',
      'service-quotas list-requested-service-quota-change-history-by-quota',
      ['--service-code', 'lambda', '--quota-code', 'L-B99A9384'],
      'servicequotas:ListRequestedServiceQuotaChangeHistoryByQuota',
      ['ap-southeast-1'],
    ],
  ])('%s', (id, op, args, iamAction, regions) => {
    const d = def(id);
    expect(`${d.service} ${d.operation}`).toBe(op);
    expect(d.args).toEqual(args);
    expect(d.iamAction).toBe(iamAction);
    expect(d.regions).toEqual(regions);
  });

  it('the inline-policy read is limited to IAM Identity Center roles in the generated policy', () => {
    expect(def('identity.role-inline-policy').iamResources).toEqual([
      'arn:aws:iam::*:role/aws-reserved/sso.amazonaws.com/*',
    ]);
    expect(def('identity.role-inline-policy').phase).toBe('identity');
    expect(def('identity.customer-policy-version').repeat).toBe('customerPolicyArn');
  });

  it('policy documents never pass a projection (names and version metadata only)', () => {
    const doc = { Statement: [{ Effect: 'Allow', Action: '*', Resource: '*' }] };
    expect(
      def('identity.role-inline-policy').project(
        { RoleName: ROLE, PolicyName: 'AwsSSOInlinePolicy', PolicyDocument: doc },
        s(),
      ),
    ).toEqual({
      RoleName: ROLE,
      PolicyName: 'AwsSSOInlinePolicy',
    });
    expect(
      P.policyVersion(
        {
          PolicyVersion: {
            Document: doc,
            VersionId: 'v3',
            IsDefaultVersion: true,
            CreateDate: '2026-01-01T00:00:00Z',
          },
        },
        s(),
      ),
    ).toEqual({
      PolicyVersion: {
        VersionId: 'v3',
        IsDefaultVersion: true,
        CreateDate: '2026-01-01T00:00:00Z',
      },
    });
  });

  it('log resource policies: count only; hooks: type names only; quota requests: status, value, dates', () => {
    expect(
      P.logResourcePolicyCount({
        resourcePolicies: [{ policyName: 'x', policyDocument: '{}' }],
      }),
    ).toEqual({
      resourcePolicyCount: 1,
    });
    expect(
      P.hookTypes(
        {
          TypeSummaries: [
            {
              TypeName: 'AWS::ControlTower::Hook',
              Description: SESSION,
              TypeArn: `arn:aws:cloudformation:ap-southeast-1:${SANDBOX}:type/hook/x`,
            },
            { TypeName: 'bad name with spaces' },
          ],
        },
        s(),
      ),
    ).toEqual({ hookTypeCount: 1, hookTypeNames: ['AWS::ControlTower::Hook'] });
    expect(
      P.quotaRequests(
        {
          RequestedQuotas: [
            {
              Id: 'id',
              CaseId: 'case',
              DesiredValue: 200,
              Status: 'APPROVED',
              Created: '2026-01-01T00:00:00Z',
              Requester: SESSION,
              QuotaArn: `arn:aws:servicequotas:ap-southeast-1:${SANDBOX}:lambda/L-B99A9384`,
            },
          ],
        },
        s(),
      ),
    ).toEqual({
      RequestedQuotas: [{ Status: 'APPROVED', DesiredValue: 200, Created: '2026-01-01T00:00:00Z' }],
    });
  });
});
