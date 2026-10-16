import {
  ENVIRONMENTS,
  type CfnResourceJson,
  type CfnTemplateJson,
  type Environment,
  type Finding,
} from '../types.js';

export type Json = Record<string, unknown>;

export const isRecord = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export const props = (r: CfnResourceJson): Json => (isRecord(r.Properties) ? r.Properties : {});

/** Safe nested lookup: `get(obj, 'A', 0, 'B')`. */
export function get(obj: unknown, ...path: (string | number)[]): unknown {
  let cur: unknown = obj;
  for (const key of path) {
    if (typeof key === 'number') {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[key];
    } else {
      if (!isRecord(cur)) return undefined;
      cur = cur[key];
    }
  }
  return cur;
}

/** CloudFormation allows scalars where lists are expected (e.g. IAM `Action`). */
export const asArray = (v: unknown): unknown[] =>
  Array.isArray(v) ? v : v === undefined || v === null ? [] : [v];

export const isPresent = (v: unknown): boolean =>
  v !== undefined && v !== null && !(typeof v === 'string' && v.trim() === '');

export const finding = (path: string, message: string): Finding => ({ path, message });

/** Tag list (`[{Key, Value}]`) → map. Non-literal values are kept as `undefined`. */
export function tagMap(tags: unknown): Map<string, string | undefined> {
  const out = new Map<string, string | undefined>();
  for (const t of asArray(tags)) {
    if (!isRecord(t) || typeof t['Key'] !== 'string') continue;
    const value = t['Value'];
    out.set(t['Key'], typeof value === 'string' ? value : undefined);
  }
  return out;
}

/** Tags of a resource; DynamoDB global tables carry tags per replica. */
export function resourceTags(r: CfnResourceJson): Map<string, string | undefined> {
  const p = props(r);
  if (r.Type === 'AWS::DynamoDB::GlobalTable') {
    const merged = new Map<string, string | undefined>();
    for (const replica of asArray(p['Replicas'])) {
      for (const [k, v] of tagMap(get(replica, 'Tags'))) merged.set(k, v);
    }
    return merged;
  }
  return tagMap(p['Tags']);
}

export const isEnvironment = (v: unknown): v is Environment =>
  typeof v === 'string' && (ENVIRONMENTS as readonly string[]).includes(v);

/** Effective environment: the resource's `Environment` tag wins over the fallback. */
export function environmentOf(
  r: CfnResourceJson,
  fallback: Environment | undefined,
): Environment | undefined {
  const tag = resourceTags(r).get('Environment');
  return isEnvironment(tag) ? tag : fallback;
}

export const resourcesOfType = (
  template: CfnTemplateJson,
  ...types: string[]
): [string, CfnResourceJson][] =>
  Object.entries(template.Resources ?? {}).filter(([, r]) => types.includes(r.Type));

/** Logical IDs referenced by `Ref` / `Fn::GetAtt` anywhere inside `value`. */
export function referencedLogicalIds(value: unknown): Set<string> {
  const out = new Set<string>();
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) {
      v.forEach(walk);
      return;
    }
    if (!isRecord(v)) return;
    const ref = v['Ref'];
    if (typeof ref === 'string' && !ref.startsWith('AWS::')) out.add(ref);
    const getAtt = v['Fn::GetAtt'];
    if (Array.isArray(getAtt) && typeof getAtt[0] === 'string') out.add(getAtt[0]);
    if (typeof getAtt === 'string') out.add(getAtt.split('.')[0] ?? getAtt);
    Object.values(v).forEach(walk);
  };
  walk(value);
  return out;
}

/** Flattens literal string fragments of an intrinsic (useful for `Fn::Join` ARNs). */
export function literalText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(literalText).join('');
  if (isRecord(value)) {
    const join = value['Fn::Join'];
    if (Array.isArray(join) && Array.isArray(join[1])) {
      return join[1].map(literalText).join(typeof join[0] === 'string' ? join[0] : '');
    }
    const sub = value['Fn::Sub'];
    if (typeof sub === 'string') return sub;
    if (Array.isArray(sub) && typeof sub[0] === 'string') return sub[0];
    return '';
  }
  return '';
}

export const STATEFUL_TYPES = [
  'AWS::RDS::DBInstance',
  'AWS::RDS::DBCluster',
  'AWS::DynamoDB::Table',
  'AWS::DynamoDB::GlobalTable',
  'AWS::KMS::Key',
  'AWS::S3::Bucket',
] as const;

/** Aurora member instances inherit encryption/backup/deletion settings from their cluster. */
export const isClusterMemberInstance = (r: CfnResourceJson): boolean =>
  r.Type === 'AWS::RDS::DBInstance' && isPresent(props(r)['DBClusterIdentifier']);
