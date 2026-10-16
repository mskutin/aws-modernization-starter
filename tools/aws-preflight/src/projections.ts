/**
 * Sanitizing projections: one field allowlist per probe. A projection returns only the fields it
 * names, each passed through a field kind (text, enum, id, ARN, domain, ...); everything else in
 * the AWS response is dropped (descriptions, policy documents, e-mails, IPs, spend, subscribers,
 * non-Name tag values, DNS entries, lock tokens, ...). Projections never throw on unexpected
 * shapes; a missing or malformed field is simply left out.
 */
import type { Projection } from './policy.ts';
import type { NameKind, Sanitizer } from './sanitize.ts';
import { isRecord, type Json } from './types.ts';

export type Field = (value: unknown, s: Sanitizer) => Json | undefined;
/** A field, or a field whose output is stored under another key (`as`). */
export type Shape = Readonly<
  Record<string, Field | { readonly as: string; readonly field: Field }>
>;

const ISO_TIME =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const ENUM = /^[A-Za-z0-9][A-Za-z0-9_.:/+ -]{0,63}$/;
const CIDR = /^(?:\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2}|[0-9a-fA-F:]{2,39}\/\d{1,3})$/;
const NUMERIC_STRING = /^-?\d{1,15}(?:\.\d{1,6})?$/;

export function pick(shape: Shape, v: unknown, s: Sanitizer): { [key: string]: Json } | undefined {
  if (!isRecord(v)) return undefined;
  const out: { [key: string]: Json } = {};
  for (const [key, spec] of Object.entries(shape)) {
    if (!Object.hasOwn(v, key)) continue;
    const field = typeof spec === 'function' ? spec : spec.field;
    const r = field(v[key], s);
    if (r !== undefined) out[typeof spec === 'function' ? key : spec.as] = r;
  }
  return out;
}

// ── Field kinds ──────────────────────────────────────────────────────────────────────────────
/** Free text (names): identifiers, accounts, e-mails and customer domains masked; truncated. */
export const text: Field = (v, s) => (typeof v === 'string' ? s.text(v) : undefined);
/** Resource ID (`vpc-...`, UUID, org IDs): masked by the text rules, type prefix kept. */
export const rid: Field = text;
/** Short enum-like token (status, type, class, version); masked like text, no domain masking. */
export const enumv: Field = (v, s) =>
  typeof v === 'string' && ENUM.test(v) ? s.text(v, { domains: false }) : undefined;
export const num: Field = (v, s) =>
  typeof v === 'number' && Number.isFinite(v)
    ? s.number(v)
    : typeof v === 'string' && NUMERIC_STRING.test(v)
      ? s.text(v, { domains: false })
      : undefined;
export const bool: Field = (v) => (typeof v === 'boolean' ? v : undefined);
export const time: Field = (v, s) =>
  typeof v === 'string' && ISO_TIME.test(v)
    ? v
    : typeof v === 'number' && Number.isFinite(v)
      ? s.number(v)
      : undefined;
export const account: Field = (v, s) => (typeof v === 'string' ? s.account(v) : undefined);
export const arn: Field = (v, s) => (typeof v === 'string' ? s.arn(v) : undefined);
export const domain: Field = (v, s) => (typeof v === 'string' ? s.domain(v) : undefined);
export const cidr: Field = (v) => (typeof v === 'string' && CIDR.test(v) ? v : undefined);
/** Workload name: kept when it is this project's, else `<kind-N>`. */
export const wname =
  (kind: NameKind): Field =>
  (v, s) =>
    typeof v === 'string' ? s.name(kind, v) : undefined;
/** Opaque identifier with no recognisable pattern (account alias, hosted zone ID). */
export const opaque =
  (kind: string): Field =>
  (v, s) =>
    typeof v === 'string' ? s.id(kind, v) : undefined;
/** AWS-managed public identifier kept verbatim when it matches `re` (dropped otherwise). */
export const awsPublic =
  (re: RegExp): Field =>
  (v) =>
    typeof v === 'string' && re.test(v) ? v : undefined;
export const obj =
  (shape: Shape): Field =>
  (v, s) =>
    pick(shape, v, s);
export const list =
  (item: Field, max = 1000): Field =>
  (v, s) =>
    Array.isArray(v)
      ? v
          .slice(0, max)
          .map((x) => item(x, s))
          .filter((x): x is Json => x !== undefined)
      : undefined;
/** AWS tags (`[{Key, Value}]` or `[{key, value}]`): keys kept, only the `Name` value kept. */
export const tags: Field = (v, s) => {
  if (!Array.isArray(v)) return undefined;
  const keys: string[] = [];
  let name: string | undefined;
  for (const t of v) {
    if (!isRecord(t)) continue;
    const key = t['Key'] ?? t['key'];
    const value = t['Value'] ?? t['value'];
    if (typeof key !== 'string') continue;
    keys.push(s.text(key));
    if (key === 'Name' && typeof value === 'string') name = s.name('name', value);
  }
  return { keys: keys.sort(), ...(name !== undefined ? { name } : {}) };
};
/** Object of numbers (IAM SummaryMap, Lambda limits). */
export const numericMap: Field = (v, s) => {
  if (!isRecord(v)) return undefined;
  const out: { [key: string]: Json } = {};
  for (const [k, x] of Object.entries(v)) {
    const n = num(x, s);
    if (/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(k) && n !== undefined) out[k] = n;
  }
  return out;
};
/** Keys of an object only (e.g. budget cost-filter dimensions; the values are dropped). */
export const keysOnly: Field = (v, s) =>
  isRecord(v)
    ? Object.keys(v)
        .filter((k) => ENUM.test(k))
        .map((k) => s.text(k, { domains: false }))
        .sort()
    : undefined;

const root =
  (shape: Shape): Projection =>
  (data, s) =>
    pick(shape, data, s);

const toArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined ? [] : [v]);

/** Trust policy -> type summary: no principal values, no condition values. */
export const trustSummary: Field = (v, s) => {
  let doc: unknown = v;
  if (typeof v === 'string') {
    try {
      doc = JSON.parse(decodeURIComponent(v));
    } catch {
      return undefined;
    }
  }
  if (!isRecord(doc)) return undefined;
  const statements = toArray(doc['Statement']).filter(isRecord);
  const principalTypes: Record<string, number> = {};
  const actions = new Set<string>();
  const effects = new Set<string>();
  const conditionKeys = new Set<string>();
  let sameAccount = 0;
  let otherAccount = 0;
  for (const st of statements) {
    if (st['Effect'] === 'Allow' || st['Effect'] === 'Deny') effects.add(st['Effect']);
    for (const a of toArray(st['Action'])) {
      if (typeof a === 'string' && /^[a-z][a-z0-9-]*:[A-Za-z*]{1,64}$/.test(a)) {
        actions.add(s.text(a, { domains: false }));
      }
    }
    const p = st['Principal'];
    if (p === '*') principalTypes['*'] = (principalTypes['*'] ?? 0) + 1;
    if (isRecord(p)) {
      for (const [type, values] of Object.entries(p)) {
        if (!/^[A-Za-z]{1,32}$/.test(type)) continue;
        const arr = toArray(values);
        principalTypes[type] = (principalTypes[type] ?? 0) + arr.length;
        if (type !== 'AWS') continue;
        for (const x of arr) {
          const acct = typeof x === 'string' ? /(?<!\d)(\d{12})(?!\d)/.exec(x)?.[1] : undefined;
          if (acct && s.isSandboxAccount(acct)) sameAccount++;
          else if (acct) otherAccount++;
        }
      }
    }
    const cond = st['Condition'];
    if (isRecord(cond)) {
      for (const operator of Object.values(cond)) {
        if (!isRecord(operator)) continue;
        for (const key of Object.keys(operator)) {
          if (/^[A-Za-z0-9:/_-]{1,128}$/.test(key))
            conditionKeys.add(s.text(key, { domains: false }));
        }
      }
    }
  }
  return {
    statementCount: statements.length,
    effects: [...effects].sort(),
    actions: [...actions].sort(),
    principalTypes,
    awsPrincipals: { sameAccount, otherAccount },
    conditionKeys: [...conditionKeys].sort(),
  };
};

// ── Shared shapes ────────────────────────────────────────────────────────────────────────────
const AZ_ID = /^[a-z]{2,10}\d{0,2}-az\d{1,2}$/;
const QUOTA_CODE = /^L-[0-9A-F]{8}$/;

const roleShape = obj({
  Path: text,
  RoleName: text,
  RoleId: rid,
  Arn: arn,
  CreateDate: time,
  MaxSessionDuration: num,
  PermissionsBoundary: obj({ PermissionsBoundaryType: enumv, PermissionsBoundaryArn: arn }),
  // The trust policy document is never copied: only a principal-type summary.
  AssumeRolePolicyDocument: { as: 'trustPolicySummary', field: trustSummary },
  Tags: tags,
  RoleLastUsed: obj({ LastUsedDate: time, Region: enumv }),
});

const managedPolicyShape = obj({
  PolicyName: text,
  PolicyId: rid,
  Arn: arn,
  Path: text,
  DefaultVersionId: enumv,
  AttachmentCount: num,
  PermissionsBoundaryUsageCount: num,
  IsAttachable: bool,
  CreateDate: time,
  UpdateDate: time,
  Tags: tags,
});

const quotaShape = obj({
  ServiceCode: enumv,
  QuotaCode: awsPublic(QUOTA_CODE),
  QuotaName: text,
  Value: num,
  Unit: enumv,
  Adjustable: bool,
  GlobalQuota: bool,
  QuotaAppliedAtLevel: enumv,
  Period: obj({ PeriodValue: num, PeriodUnit: enumv }),
});

const repositoryFilters = list(obj({ filter: text, filterType: enumv }));
const bpaStates = obj({ InternetGatewayBlockMode: enumv });

// ── Organization policy summaries (no policy documents) ──────────────────────────────────────
/** Tag policy -> tag keys, enforced resource types, and whether allowed values exist. */
function tagPolicySummary(content: unknown, s: Sanitizer): Json | undefined {
  if (!isRecord(content) || !isRecord(content['tags'])) return undefined;
  const out: Json[] = [];
  for (const [name, rule] of Object.entries(content['tags'])) {
    if (!isRecord(rule)) continue;
    const assign = (x: unknown) => (isRecord(x) ? x['@@assign'] : undefined);
    const tagKey = assign(rule['tag_key']);
    const values = assign(rule['tag_value']);
    const enforced = toArray(assign(rule['enforced_for'])).filter(
      (x): x is string => typeof x === 'string' && ENUM.test(x),
    );
    out.push({
      tag: s.text(typeof tagKey === 'string' ? tagKey : name),
      hasAllowedValues: Array.isArray(values) && values.length > 0,
      enforcedFor: enforced.map((x) => s.text(x, { domains: false })).sort(),
    });
  }
  return out;
}

/** Declarative EC2 policy -> attribute path = enum value pairs (no free text, no account IDs). */
function declarativePolicySummary(content: unknown): Json | undefined {
  if (!isRecord(content)) return undefined;
  const out: { [key: string]: Json } = {};
  const walk = (v: unknown, path: string[]): void => {
    if (Object.keys(out).length >= 100 || path.length > 8) return;
    if (!isRecord(v)) return;
    for (const [k, child] of Object.entries(v)) {
      // Attribute names only (never all-digit keys such as account IDs) and no free text.
      if (!/^[a-z_@][a-z0-9_@]{0,63}$/i.test(k) || /exception_message/i.test(k)) continue;
      if (k === '@@assign') {
        if (typeof child === 'string' && /^[a-z][a-z0-9_-]{0,39}$/.test(child)) {
          out[path.join('.')] = child;
        }
      } else {
        walk(child, [...path, k]);
      }
    }
  };
  walk(content, []);
  return out;
}

function effectivePolicy(
  summary: (content: unknown, s: Sanitizer) => Json | undefined,
): Projection {
  return (data, s): Json | undefined => {
    if (!isRecord(data)) return undefined;
    const ep = data['EffectivePolicy'];
    if (!isRecord(ep)) return {};
    let content: unknown;
    try {
      content =
        typeof ep['PolicyContent'] === 'string' ? JSON.parse(ep['PolicyContent']) : undefined;
    } catch {
      content = undefined;
    }
    const base =
      pick({ LastUpdatedTimestamp: time, TargetId: account, PolicyType: enumv }, ep, s) ?? {};
    const sum = summary(content, s);
    return { EffectivePolicy: { ...base, ...(sum !== undefined ? { summary: sum } : {}) } };
  };
}

// ── Per-probe projections ────────────────────────────────────────────────────────────────────
export const P = {
  callerIdentity: root({ Account: account }),
  role: root({ Role: roleShape }),
  attachedPolicies: root({ AttachedPolicies: list(obj({ PolicyName: text, PolicyArn: arn })) }),
  inlinePolicies: root({ PolicyNames: list(text) }),
  /** get-role-policy: the name only; the document is classified in gate.ts and stays raw. */
  rolePolicy: root({ RoleName: text, PolicyName: text }),
  /** get-policy-version: version metadata only; the document is classified in gate.ts. */
  policyVersion: root({
    PolicyVersion: obj({ VersionId: enumv, IsDefaultVersion: bool, CreateDate: time }),
  }),
  organization: root({
    Organization: obj({
      Id: rid,
      Arn: arn,
      FeatureSet: enumv,
      MasterAccountArn: arn,
      MasterAccountId: account,
      AvailablePolicyTypes: list(obj({ Type: enumv, Status: enumv })),
    }),
  }),
  orgParents: root({ Parents: list(obj({ Id: rid, Type: enumv })) }),
  orgPolicies: root({
    Policies: list(obj({ Id: rid, Arn: arn, Name: text, Type: enumv, AwsManaged: bool })),
  }),
  effectiveTagPolicy: effectivePolicy(tagPolicySummary),
  effectiveDeclarativePolicy: effectivePolicy((c) => declarativePolicySummary(c)),
  accountSummary: root({ SummaryMap: numericMap }),
  accountAliases: root({ AccountAliases: list(opaque('account-alias')) }),
  localPolicies: root({ Policies: list(managedPolicyShape) }),
  policy: root({ Policy: managedPolicyShape }),
  stacks: root({
    Stacks: list(
      obj({
        StackId: arn,
        StackName: wname('stack'),
        CreationTime: time,
        LastUpdatedTime: time,
        StackStatus: enumv,
        Parameters: list(obj({ ParameterKey: enumv, ParameterValue: text })),
        Outputs: list(obj({ OutputKey: enumv, OutputValue: text, ExportName: text })),
        Capabilities: list(enumv),
        RoleARN: arn,
        EnableTerminationProtection: bool,
        DisableRollback: bool,
        DriftInformation: obj({ StackDriftStatus: enumv }),
        Tags: tags,
      }),
    ),
  }),
  stackSummaries: root({
    StackSummaries: list(
      obj({
        StackId: arn,
        StackName: wname('stack'),
        CreationTime: time,
        LastUpdatedTime: time,
        DeletionTime: time,
        StackStatus: enumv,
        ParentId: arn,
        RootId: arn,
        DriftInformation: obj({ StackDriftStatus: enumv, LastCheckTimestamp: time }),
      }),
    ),
  }),
  /** CDK bootstrap version parameter: the value is kept only for a plain String version number. */
  bootstrapVersion: (data: unknown, s: Sanitizer): Json | undefined => {
    if (!isRecord(data)) return undefined;
    const p = data['Parameter'];
    if (!isRecord(p)) return {};
    const base =
      pick(
        { Name: text, Type: enumv, Version: num, LastModifiedDate: time, DataType: enumv },
        p,
        s,
      ) ?? {};
    const value = p['Value'];
    const keep = p['Type'] === 'String' && typeof value === 'string' && /^\d{1,4}$/.test(value);
    return { Parameter: { ...base, ...(keep ? { Value: value } : {}) } };
  },
  availabilityZones: root({
    AvailabilityZones: list(
      obj({
        ZoneName: enumv,
        ZoneId: awsPublic(AZ_ID),
        State: enumv,
        OptInStatus: enumv,
        ZoneType: enumv,
        RegionName: enumv,
        GroupName: enumv,
        NetworkBorderGroup: enumv,
      }),
    ),
  }),
  ec2AccountAttributes: root({
    AccountAttributes: list(
      obj({ AttributeName: enumv, AttributeValues: list(obj({ AttributeValue: text })) }),
    ),
  }),
  vpcs: root({
    Vpcs: list(
      obj({
        VpcId: rid,
        State: enumv,
        CidrBlock: cidr,
        CidrBlockAssociationSet: list(
          obj({ CidrBlock: cidr, CidrBlockState: obj({ State: enumv }) }),
        ),
        Ipv6CidrBlockAssociationSet: list(
          obj({
            Ipv6CidrBlock: cidr,
            Ipv6CidrBlockState: obj({ State: enumv }),
            NetworkBorderGroup: enumv,
          }),
        ),
        DhcpOptionsId: rid,
        InstanceTenancy: enumv,
        IsDefault: bool,
        OwnerId: account,
        BlockPublicAccessStates: bpaStates,
        Tags: tags,
      }),
    ),
  }),
  subnets: root({
    Subnets: list(
      obj({
        SubnetId: rid,
        VpcId: rid,
        SubnetArn: arn,
        AvailabilityZone: enumv,
        AvailabilityZoneId: awsPublic(AZ_ID),
        CidrBlock: cidr,
        Ipv6CidrBlockAssociationSet: list(obj({ Ipv6CidrBlock: cidr })),
        AvailableIpAddressCount: num,
        DefaultForAz: bool,
        MapPublicIpOnLaunch: bool,
        AssignIpv6AddressOnCreation: bool,
        Ipv6Native: bool,
        EnableDns64: bool,
        State: enumv,
        OwnerId: account,
        BlockPublicAccessStates: bpaStates,
        PrivateDnsNameOptionsOnLaunch: obj({ HostnameType: enumv }),
        Tags: tags,
      }),
    ),
  }),
  routeTables: root({
    RouteTables: list(
      obj({
        RouteTableId: rid,
        VpcId: rid,
        OwnerId: account,
        Associations: list(
          obj({
            Main: bool,
            RouteTableAssociationId: rid,
            RouteTableId: rid,
            SubnetId: rid,
            GatewayId: rid,
            AssociationState: obj({ State: enumv }),
          }),
        ),
        Routes: list(
          obj({
            DestinationCidrBlock: cidr,
            DestinationIpv6CidrBlock: cidr,
            DestinationPrefixListId: rid,
            GatewayId: rid,
            NatGatewayId: rid,
            TransitGatewayId: rid,
            VpcPeeringConnectionId: rid,
            NetworkInterfaceId: rid,
            InstanceId: rid,
            EgressOnlyInternetGatewayId: rid,
            CarrierGatewayId: rid,
            LocalGatewayId: rid,
            CoreNetworkArn: arn,
            Origin: enumv,
            State: enumv,
          }),
        ),
        PropagatingVgws: list(obj({ GatewayId: rid })),
        Tags: tags,
      }),
    ),
  }),
  internetGateways: root({
    InternetGateways: list(
      obj({
        InternetGatewayId: rid,
        OwnerId: account,
        Attachments: list(obj({ VpcId: rid, State: enumv })),
        Tags: tags,
      }),
    ),
  }),
  natGateways: root({
    NatGateways: list(
      obj({
        NatGatewayId: rid,
        SubnetId: rid,
        VpcId: rid,
        State: enumv,
        ConnectivityType: enumv,
        AvailabilityMode: enumv,
        CreateTime: time,
        FailureCode: enumv,
        // Public and private IPs are dropped; allocation IDs are masked.
        NatGatewayAddresses: list(obj({ AllocationId: rid, IsPrimary: bool, Status: enumv })),
        Tags: tags,
      }),
    ),
  }),
  vpcEndpoints: root({
    VpcEndpoints: list(
      obj({
        VpcEndpointId: rid,
        VpcEndpointType: enumv,
        VpcId: rid,
        // Reversed AWS service names are kept (endpoint-service IDs inside them are masked).
        ServiceName: (v, s) =>
          typeof v === 'string'
            ? /^(?:com|aws)\.amazonaws\.[a-z0-9.-]{1,120}$/.test(v)
              ? s.text(v)
              : '<non-aws-service>'
            : undefined,
        ServiceRegion: enumv,
        State: enumv,
        RouteTableIds: list(rid),
        SubnetIds: list(rid),
        Groups: list(obj({ GroupId: rid })),
        PrivateDnsEnabled: bool,
        RequesterManaged: bool,
        IpAddressType: enumv,
        DnsOptions: obj({ DnsRecordIpType: enumv, PrivateDnsOnlyForInboundResolverEndpoint: bool }),
        CreationTimestamp: time,
        OwnerId: account,
        Tags: tags,
      }),
    ),
  }),
  cloudFrontPrefixList: root({
    PrefixLists: list(
      obj({
        PrefixListId: awsPublic(/^pl-[0-9a-f]{8,17}$/),
        PrefixListName: awsPublic(/^com\.amazonaws\.[a-z0-9.-]{1,120}$/),
        PrefixListArn: awsPublic(/^arn:aws:ec2:[a-z0-9-]+:aws:prefix-list\/pl-[0-9a-f]{8,17}$/),
        AddressFamily: enumv,
        State: enumv,
        MaxEntries: num,
        Version: num,
        OwnerId: awsPublic(/^AWS$/),
      }),
    ),
  }),
  vpcBpaOptions: root({
    VpcBlockPublicAccessOptions: obj({
      AwsAccountId: account,
      AwsRegion: enumv,
      State: enumv,
      InternetGatewayBlockMode: enumv,
      LastUpdateTimestamp: time,
      ManagedBy: enumv,
      ExclusionsAllowed: enumv,
    }),
  }),
  vpcBpaExclusions: root({
    VpcBlockPublicAccessExclusions: list(
      obj({
        ExclusionId: rid,
        InternetGatewayExclusionMode: enumv,
        ResourceArn: arn,
        State: enumv,
        CreationTimestamp: time,
        LastUpdateTimestamp: time,
        DeletionTimestamp: time,
        Tags: tags,
      }),
    ),
  }),
  elbLimits: root({ Limits: list(obj({ Name: enumv, Max: num })) }),
  hostedZones: root({
    HostedZones: list(
      obj({
        Id: opaque('hostedzone'),
        Name: domain,
        Config: obj({ PrivateZone: bool }),
        ResourceRecordSetCount: num,
        LinkedService: obj({ ServicePrincipal: enumv }),
      }),
    ),
  }),
  certificates: root({
    CertificateSummaryList: list(
      obj({
        CertificateArn: arn,
        DomainName: domain,
        SubjectAlternativeNameSummaries: list(domain),
        HasAdditionalSubjectAlternativeNames: bool,
        Status: enumv,
        Type: enumv,
        KeyAlgorithm: enumv,
        KeyUsages: list(enumv),
        ExtendedKeyUsages: list(enumv),
        InUse: bool,
        Exported: bool,
        RenewalEligibility: enumv,
        ManagedBy: enumv,
        ExportOption: enumv,
        NotBefore: time,
        NotAfter: time,
        CreatedAt: time,
        IssuedAt: time,
        ImportedAt: time,
        RevokedAt: time,
      }),
    ),
  }),
  /** Web ACL names are always masked; a Firewall Manager-managed ACL keeps that fact. */
  webAcls: (data, s) => {
    if (!isRecord(data)) return undefined;
    const acls = Array.isArray(data['WebACLs']) ? data['WebACLs'] : [];
    return {
      WebACLs: acls.filter(isRecord).map((acl) => {
        const name = typeof acl['Name'] === 'string' ? acl['Name'] : '';
        return {
          ...pick({ Id: rid, ARN: arn }, acl, s),
          Name: s.name('web-acl', name),
          fmsManaged: /^FMManagedWebACL/.test(name),
        };
      }),
    };
  },
  lambdaSettings: root({ AccountLimit: numericMap, AccountUsage: numericMap }),
  quotas: root({ Quotas: list(quotaShape) }),
  quota: root({ Quota: quotaShape }),
  engineVersions: root({
    DBEngineVersions: list(
      obj({
        Engine: enumv,
        EngineVersion: enumv,
        DBParameterGroupFamily: enumv,
        Status: enumv,
        DBEngineVersionDescription: text,
        SupportsCertificateRotationWithoutRestart: bool,
        SupportedCACertificateIdentifiers: list(enumv),
        SupportsLogExportsToCloudwatchLogs: bool,
        ExportableLogTypes: list(enumv),
        SupportsReadReplica: bool,
        SupportedFeatureNames: list(enumv),
        SupportsGlobalDatabases: bool,
        SupportsIntegrations: bool,
        ValidUpgradeTarget: list(
          obj({ EngineVersion: enumv, IsMajorVersionUpgrade: bool, AutoUpgrade: bool }),
        ),
      }),
    ),
  }),
  engineCatalog: root({
    DBEngineVersions: list(
      obj({ Engine: enumv, EngineVersion: enumv, DBParameterGroupFamily: enumv, Status: enumv }),
    ),
  }),
  orderableInstances: root({
    OrderableDBInstanceOptions: list(
      obj({
        Engine: enumv,
        EngineVersion: enumv,
        DBInstanceClass: enumv,
        LicenseModel: enumv,
        AvailabilityZoneGroup: enumv,
        AvailabilityZones: list(obj({ Name: enumv })),
        MultiAZCapable: bool,
        ReadReplicaCapable: bool,
        Vpc: bool,
        SupportsStorageEncryption: bool,
        StorageType: enumv,
        SupportsIops: bool,
        SupportsStorageThroughput: bool,
        SupportsEnhancedMonitoring: bool,
        SupportsIAMDatabaseAuthentication: bool,
        SupportsPerformanceInsights: bool,
        SupportsStorageAutoscaling: bool,
        SupportsDedicatedLogVolume: bool,
        SupportsClusters: bool,
        MinStorageSize: num,
        MaxStorageSize: num,
        SupportedNetworkTypes: list(enumv),
      }),
    ),
  }),
  rdsCertificates: root({
    Certificates: list(
      obj({
        CertificateIdentifier: enumv,
        CertificateType: enumv,
        ValidFrom: time,
        ValidTill: time,
        CustomerOverride: bool,
        CustomerOverrideValidTill: time,
      }),
    ),
    DefaultCertificateForNewLaunches: enumv,
  }),
  rdsAccountAttributes: root({
    AccountQuotas: list(obj({ AccountQuotaName: enumv, Used: num, Max: num })),
  }),
  ecsSettings: root({ settings: list(obj({ name: enumv, value: enumv, type: enumv })) }),
  ecrRegistry: root({
    registryId: account,
    replicationConfiguration: obj({
      rules: list(
        obj({
          destinations: list(obj({ region: enumv, registryId: account })),
          repositoryFilters,
        }),
      ),
    }),
  }),
  ecrScanning: root({
    registryId: account,
    scanningConfiguration: obj({
      scanType: enumv,
      rules: list(obj({ scanFrequency: enumv, repositoryFilters })),
    }),
  }),
  dynamoLimits: root({
    AccountMaxReadCapacityUnits: num,
    AccountMaxWriteCapacityUnits: num,
    TableMaxReadCapacityUnits: num,
    TableMaxWriteCapacityUnits: num,
  }),
  cfnLimits: root({ AccountLimits: list(obj({ Name: enumv, Value: num })) }),
  kmsAliases: root({
    Aliases: list(
      obj({
        AliasName: wname('kms-alias'),
        AliasArn: arn,
        TargetKeyId: rid,
        CreationDate: time,
        LastUpdatedDate: time,
      }),
    ),
  }),
  kmsKey: root({
    KeyMetadata: obj({
      AWSAccountId: account,
      KeyId: rid,
      Arn: arn,
      CreationDate: time,
      Enabled: bool,
      KeyUsage: enumv,
      KeyState: enumv,
      Origin: enumv,
      KeyManager: enumv,
      KeySpec: enumv,
      CustomerMasterKeySpec: enumv,
      EncryptionAlgorithms: list(enumv),
      SigningAlgorithms: list(enumv),
      MultiRegion: bool,
      DeletionDate: time,
      ValidTo: time,
      ExpirationModel: enumv,
      PendingDeletionWindowInDays: num,
    }),
  }),
  logsAccountPolicies: root({
    accountPolicies: list(
      obj({
        policyName: wname('log-policy'),
        policyType: enumv,
        scope: enumv,
        lastUpdatedTime: time,
        accountId: account,
      }),
    ),
  }),
  budgets: root({
    Budgets: list(
      obj({
        BudgetName: wname('budget'),
        BudgetType: enumv,
        TimeUnit: enumv,
        BudgetLimit: obj({ Amount: num, Unit: enumv }),
        TimePeriod: obj({ Start: time, End: time }),
        CostFilters: keysOnly,
        Metrics: list(enumv),
        LastUpdatedTime: time,
        HealthStatus: obj({ Status: enumv }),
        AutoAdjustData: obj({ AutoAdjustType: enumv }),
        BillingViewArn: arn,
        // CalculatedSpend (actual and forecasted spend) is intentionally not projected.
      }),
    ),
  }),
  /** CloudFormation hooks: type names only (ORG-06). */
  hookTypes: (data, s) => {
    if (!isRecord(data)) return undefined;
    const types = Array.isArray(data['TypeSummaries']) ? data['TypeSummaries'] : [];
    const names = types
      .filter(isRecord)
      .map((t) => t['TypeName'])
      .filter((n): n is string => typeof n === 'string' && /^[A-Za-z0-9:]{1,204}$/.test(n))
      .map((n) => s.text(n, { domains: false }));
    return { hookTypeCount: names.length, hookTypeNames: names.sort() };
  },
  /** CloudWatch Logs resource policies: the count only. */
  logResourcePolicyCount: (data) =>
    isRecord(data) && Array.isArray(data['resourcePolicies'])
      ? { resourcePolicyCount: data['resourcePolicies'].length }
      : undefined,
  /** Requested quota increases: status, desired value and dates only (no case IDs, requesters). */
  quotaRequests: root({
    RequestedQuotas: list(
      obj({ Status: enumv, DesiredValue: num, Created: time, LastUpdated: time }),
    ),
  }),
  budgetNotifications: root({
    Notifications: list(
      obj({
        NotificationType: enumv,
        ComparisonOperator: enumv,
        Threshold: num,
        ThresholdType: enumv,
        NotificationState: enumv,
      }),
    ),
  }),
} satisfies Record<string, Projection>;
