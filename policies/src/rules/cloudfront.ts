import type { Finding, PolicyRule } from '../types.js';
import { asArray, finding, get, isPresent, isRecord, props, resourcesOfType } from './util.js';

const CF_TYPE = 'AWS::CloudFront::Distribution';
const RHP_TYPE = 'AWS::CloudFront::ResponseHeadersPolicy';

export const MODERN_VIEWER_TLS_POLICIES = ['TLSv1.2_2021', 'TLSv1.2_2025', 'TLSv1.3_2025'] as const;
const HTTPS_VIEWER_POLICIES = ['redirect-to-https', 'https-only'];

/** AWS-managed response headers policies that include the security headers set. */
export const MANAGED_SECURITY_HEADER_POLICY_IDS = [
  '67f7725c-6f97-4210-82d7-5512b31e9d03', // Managed-SecurityHeadersPolicy
  'e61eb60c-9c35-4d20-a928-2b84e02af89c', // Managed-CORS-and-SecurityHeadersPolicy
  'eaab4381-ed33-4a86-88ca-d9558dc6cd63', // Managed-CORS-with-preflight-and-SecurityHeadersPolicy
] as const;

export const MIN_HSTS_MAX_AGE_SECONDS = 31_536_000;

const distConfig = (r: Parameters<PolicyRule['evaluate']>[0]['resource']) =>
  get(props(r), 'DistributionConfig');

const origins = (r: Parameters<PolicyRule['evaluate']>[0]['resource']) =>
  asArray(get(distConfig(r), 'Origins'));

export const cloudFrontRules: PolicyRule[] = [
  {
    id: 'BASE-CF-001',
    title: 'S3 origins use Origin Access Control',
    description:
      'Every CloudFront S3 origin sets OriginAccessControlId and does not use a legacy Origin Access Identity.',
    rationale:
      'OAC signs origin requests with SigV4 and supports SSE-KMS buckets; OAI is legacy. Together with BASE-S3-001 the bucket stays private.',
    severity: 'high',
    engines: ['cdk-nag', 'guard'],
    resourceTypes: [CF_TYPE],
    remediation: 'Use `origins.S3BucketOrigin.withOriginAccessControl(bucket)`.',
    evaluate: ({ resource }) =>
      origins(resource).flatMap((origin, i): Finding[] => {
        if (!isRecord(origin) || !isRecord(origin['S3OriginConfig'])) return [];
        const out: Finding[] = [];
        if (!isPresent(origin['OriginAccessControlId'])) {
          out.push(
            finding(
              `Properties/DistributionConfig/Origins/${i}/OriginAccessControlId`,
              'S3 origin has no OriginAccessControlId.',
            ),
          );
        }
        if (isPresent(get(origin, 'S3OriginConfig', 'OriginAccessIdentity'))) {
          out.push(
            finding(
              `Properties/DistributionConfig/Origins/${i}/S3OriginConfig/OriginAccessIdentity`,
              'S3 origin uses a legacy Origin Access Identity.',
            ),
          );
        }
        return out;
      }),
  },
  {
    id: 'BASE-CF-002',
    title: 'Viewer TLS uses a modern security policy',
    description:
      'Distributions with a custom certificate use MinimumProtocolVersion TLSv1.2_2021 or newer. In staging/prod a custom certificate is mandatory, because the default *.cloudfront.net certificate allows TLSv1.',
    rationale:
      'Older TLS versions and cipher suites are deprecated. The CloudFront default certificate cannot enforce a minimum TLS version.',
    severity: 'high',
    engines: ['cdk-nag', 'guard'],
    resourceTypes: [CF_TYPE],
    remediation:
      'Attach an ACM certificate (us-east-1) and set `minimumProtocolVersion: SecurityPolicyProtocol.TLS_V1_2_2021` (or newer).',
    notes: 'dev may use the default certificate (finding suppressed by design, not by exception).',
    evaluate: ({ resource, environment }) => {
      const vc = get(distConfig(resource), 'ViewerCertificate');
      const custom =
        isPresent(get(vc, 'AcmCertificateArn')) || isPresent(get(vc, 'IamCertificateId'));
      if (custom) {
        const min = get(vc, 'MinimumProtocolVersion');
        return typeof min === 'string' &&
          (MODERN_VIEWER_TLS_POLICIES as readonly string[]).includes(min)
          ? []
          : [
              finding(
                'Properties/DistributionConfig/ViewerCertificate/MinimumProtocolVersion',
                `MinimumProtocolVersion must be one of ${MODERN_VIEWER_TLS_POLICIES.join(', ')}.`,
              ),
            ];
      }
      if (environment === 'staging' || environment === 'prod') {
        return [
          finding(
            'Properties/DistributionConfig/ViewerCertificate',
            'staging/prod distributions must use a custom ACM certificate; the default CloudFront certificate permits TLSv1.',
          ),
        ];
      }
      return [];
    },
  },
  {
    id: 'BASE-CF-003',
    title: 'Viewers are forced onto HTTPS',
    description:
      'The default and every additional cache behavior use ViewerProtocolPolicy redirect-to-https or https-only.',
    rationale: 'Prevents session data and tokens from crossing the internet in clear text.',
    severity: 'high',
    engines: ['cdk-nag', 'guard'],
    resourceTypes: [CF_TYPE],
    remediation: 'Set `viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS`.',
    evaluate: ({ resource }) => {
      const cfg = distConfig(resource);
      const out: Finding[] = [];
      const check = (behavior: unknown, path: string) => {
        const v = get(behavior, 'ViewerProtocolPolicy');
        if (typeof v !== 'string' || !HTTPS_VIEWER_POLICIES.includes(v)) {
          out.push(
            finding(`${path}/ViewerProtocolPolicy`, `ViewerProtocolPolicy is ${String(v)}.`),
          );
        }
      };
      check(get(cfg, 'DefaultCacheBehavior'), 'Properties/DistributionConfig/DefaultCacheBehavior');
      asArray(get(cfg, 'CacheBehaviors')).forEach((b, i) =>
        check(b, `Properties/DistributionConfig/CacheBehaviors/${i}`),
      );
      return out;
    },
  },
  {
    id: 'BASE-CF-004',
    title: 'Custom origins are reached over TLS 1.2',
    description:
      'Every custom origin (e.g. the ALB) uses OriginProtocolPolicy https-only and, if set, OriginSSLProtocols only TLSv1.2. VPC origins are exempt (private AWS network path).',
    rationale:
      'Traffic between CloudFront and an internet-facing origin otherwise crosses the internet unencrypted.',
    severity: 'high',
    engines: ['cdk-nag', 'guard'],
    resourceTypes: [CF_TYPE],
    remediation:
      'Give the ALB an HTTPS listener and use `protocolPolicy: OriginProtocolPolicy.HTTPS_ONLY`, or use a CloudFront VPC origin to an internal ALB.',
    evaluate: ({ resource }) =>
      origins(resource).flatMap((origin, i): Finding[] => {
        const custom = get(origin, 'CustomOriginConfig');
        if (!isRecord(custom)) return [];
        const out: Finding[] = [];
        const base = `Properties/DistributionConfig/Origins/${i}/CustomOriginConfig`;
        if (custom['OriginProtocolPolicy'] !== 'https-only') {
          out.push(
            finding(
              `${base}/OriginProtocolPolicy`,
              `OriginProtocolPolicy is ${String(custom['OriginProtocolPolicy'])}; must be https-only.`,
            ),
          );
        }
        const ssl = custom['OriginSSLProtocols'];
        if (ssl !== undefined && asArray(ssl).some((p) => p !== 'TLSv1.2')) {
          out.push(finding(`${base}/OriginSSLProtocols`, 'OriginSSLProtocols must be [TLSv1.2].'));
        }
        return out;
      }),
  },
  {
    id: 'BASE-CF-005',
    title: 'Distributions have access logging',
    description:
      'Each distribution enables standard logging (DistributionConfig.Logging.Bucket) or the template defines a CloudWatch Logs DeliverySource of type ACCESS_LOGS (standard logging v2).',
    rationale: 'Access logs are needed for incident response and abuse investigation.',
    severity: 'medium',
    engines: ['cdk-nag', 'guard'],
    resourceTypes: [CF_TYPE],
    remediation:
      'Set `enableLogging: true` with a log bucket, or configure standard logging v2 (AWS::Logs::DeliverySource/Delivery/DeliveryDestination).',
    notes:
      'Approximation: any ACCESS_LOGS DeliverySource in the same template satisfies the rule for all distributions in it (kept identical in both engines).',
    evaluate: ({ resource, template }) => {
      if (isPresent(get(distConfig(resource), 'Logging', 'Bucket'))) return [];
      const v2 = resourcesOfType(template, 'AWS::Logs::DeliverySource').some(
        ([, r]) => get(props(r), 'LogType') === 'ACCESS_LOGS',
      );
      return v2
        ? []
        : [
            finding(
              'Properties/DistributionConfig/Logging',
              'No standard logging bucket and no ACCESS_LOGS delivery source.',
            ),
          ];
    },
  },
  {
    id: 'BASE-CF-006',
    title: 'Security response headers are applied',
    description:
      'The default cache behavior references a response headers policy: either an AWS-managed policy that includes security headers, or a custom AWS::CloudFront::ResponseHeadersPolicy. Every custom policy sets HSTS (max-age ≥ 1 year), X-Content-Type-Options, X-Frame-Options and Referrer-Policy.',
    rationale:
      'Security headers mitigate clickjacking, MIME sniffing and protocol downgrade attacks against the SPA.',
    severity: 'medium',
    engines: ['cdk-nag', 'guard'],
    resourceTypes: [CF_TYPE, RHP_TYPE],
    remediation:
      'Use `ResponseHeadersPolicy.SECURITY_HEADERS` or a custom policy with `securityHeadersBehavior` (add a Content-Security-Policy suited to the SPA).',
    evaluate: ({ resource }) => {
      if (resource.Type === CF_TYPE) {
        const id = get(distConfig(resource), 'DefaultCacheBehavior', 'ResponseHeadersPolicyId');
        const path = 'Properties/DistributionConfig/DefaultCacheBehavior/ResponseHeadersPolicyId';
        if (!isPresent(id)) {
          return [finding(path, 'Default cache behavior has no response headers policy.')];
        }
        if (
          typeof id === 'string' &&
          !(MANAGED_SECURITY_HEADER_POLICY_IDS as readonly string[]).includes(id)
        ) {
          return [
            finding(path, `Managed policy ${id} is not one of the security-headers policies.`),
          ];
        }
        return [];
      }
      const sec = get(props(resource), 'ResponseHeadersPolicyConfig', 'SecurityHeadersConfig');
      const base = 'Properties/ResponseHeadersPolicyConfig/SecurityHeadersConfig';
      const out: Finding[] = [];
      const maxAge = get(sec, 'StrictTransportSecurity', 'AccessControlMaxAgeSec');
      if (typeof maxAge !== 'number' || maxAge < MIN_HSTS_MAX_AGE_SECONDS) {
        out.push(
          finding(
            `${base}/StrictTransportSecurity`,
            `HSTS must be set with AccessControlMaxAgeSec >= ${MIN_HSTS_MAX_AGE_SECONDS}.`,
          ),
        );
      }
      for (const header of ['ContentTypeOptions', 'FrameOptions', 'ReferrerPolicy']) {
        if (!isRecord(get(sec, header))) {
          out.push(finding(`${base}/${header}`, `${header} is not configured.`));
        }
      }
      return out;
    },
  },
];
