/** RDS, DynamoDB, S3, ECR, Secrets Manager and KMS sweeps. */
import { HOURS_PER_MONTH, SECRETS_HOURS_PER_MONTH } from '../model/prices.js';
import { matchName } from '../match.js';
import {
  addDays,
  arr,
  call,
  callRaw,
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

const hoursUntil = (now: Date, isoDate: string | undefined) => {
  if (!isoDate) return 0;
  return Math.max(0, (Date.parse(isoDate) - now.getTime()) / 3_600_000);
};
const round = (n: number) => Math.round(n * 1e6) / 1e6;

export async function sweepRds(env: SweepEnv): Promise<SweepOutcome> {
  const out = outcome('rds');
  const { book } = env;
  const instances = new Set<string>();
  for (const d of items(await call(env, out, 'rds', 'describe-db-instances'), 'DBInstances')) {
    const id = str(d['DBInstanceIdentifier']);
    if (!id) continue;
    const cls = str(d['DBInstanceClass']) ?? 'unknown';
    const multiAz = d['MultiAZ'] === true;
    const storage = num(d['AllocatedStorage']) ?? 20;
    const inst = book.rdsInstanceHour(cls, multiAz);
    const st = book.rdsStorageGbMonth(str(d['StorageType']) ?? 'gp3', multiAz);
    instances.add(id);
    record(
      env,
      out,
      {
        names: [id],
        tags: tagMap(d['TagList']),
        vpcId: str(obj(d['DBSubnetGroup'])['VpcId']),
        arn: str(d['DBInstanceArn']),
      },
      {
        service: 'rds',
        resourceType: 'AWS::RDS::DBInstance',
        id,
        name: id,
        state: str(d['DBInstanceStatus']),
        createdAt: iso(d['InstanceCreateTime']),
        disposition: 'exists',
        note: `${cls}${multiAz ? ' Multi-AZ' : ''}, ${storage} GiB${inst ? '' : ' (class not in the price snapshot)'}`,
        hourlyUsdIfLeft: (inst?.usd ?? 0) + (storage * (st?.usd ?? 0)) / HOURS_PER_MONTH,
      },
    );
  }
  for (const s of items(await call(env, out, 'rds', 'describe-db-snapshots'), 'DBSnapshots')) {
    const id = str(s['DBSnapshotIdentifier']);
    if (!id) continue;
    const type = str(s['SnapshotType']);
    const instance = str(s['DBInstanceIdentifier']);
    const gb = num(s['AllocatedStorage']) ?? 0;
    const finalSnapshot = type === 'manual' && /-snapshot-/i.test(id);
    const retained =
      finalSnapshot || (type === 'automated' && !(instance && instances.has(instance)));
    const monthly = gb * book.rdsBackupGbMonth.usd;
    record(
      env,
      out,
      {
        names: [id, instance],
        tags: tagMap(s['TagList']),
        vpcId: str(s['VpcId']),
        arn: str(s['DBSnapshotArn']),
      },
      {
        service: 'rds',
        resourceType: 'AWS::RDS::DBSnapshot',
        id,
        name: instance,
        state: `${type ?? 'unknown'} ${str(s['Status']) ?? ''}`.trim(),
        createdAt: iso(s['SnapshotCreateTime']),
        disposition: retained ? 'retained' : 'exists',
        note: finalSnapshot
          ? 'final snapshot left by DeletionPolicy Snapshot (not expected in the sandbox; billed until deleted)'
          : type === 'automated'
            ? 'automated snapshot'
            : 'manual snapshot (billed until deleted)',
        hourlyUsdIfLeft: monthly / HOURS_PER_MONTH,
        residualLikelyUsd: retained ? round(monthly) : undefined,
        residualWorstUsd: retained ? round(monthly) : undefined,
      },
    );
  }
  for (const b of items(
    await call(env, out, 'rds', 'describe-db-instance-automated-backups'),
    'DBInstanceAutomatedBackups',
  )) {
    const id = str(b['DbiResourceId']) ?? str(b['DBInstanceIdentifier']);
    const status = str(b['Status']);
    if (!id || status !== 'retained') continue; // active backups belong to a running instance
    const gb = num(b['AllocatedStorage']) ?? 0;
    const until = addDays(
      iso(obj(b['RestoreWindow'])['LatestTime']),
      num(b['BackupRetentionPeriod']) ?? 1,
    );
    const usd = round(
      ((gb * book.rdsBackupGbMonth.usd) / HOURS_PER_MONTH) * hoursUntil(env.now, until),
    );
    record(
      env,
      out,
      { names: [str(b['DBInstanceIdentifier'])], arn: str(b['DBInstanceAutomatedBackupsArn']) },
      {
        service: 'rds',
        resourceType: 'AWS::RDS::DBInstanceAutomatedBackup',
        id,
        name: str(b['DBInstanceIdentifier']),
        state: status,
        createdAt: iso(b['InstanceCreateTime']),
        disposition: 'retained',
        deletionDate: until,
        note: 'retained automated backup (not expected: the sandbox deletes automated backups); expires after its retention period',
        residualLikelyUsd: usd,
        residualWorstUsd: usd,
      },
    );
  }
  for (const g of items(
    await call(env, out, 'rds', 'describe-db-parameter-groups'),
    'DBParameterGroups',
  )) {
    const name = str(g['DBParameterGroupName']);
    if (!name || name.startsWith('default.')) continue;
    record(
      env,
      out,
      { names: [name, str(g['Description'])], arn: str(g['DBParameterGroupArn']) },
      {
        service: 'rds',
        resourceType: 'AWS::RDS::DBParameterGroup',
        id: name,
        name,
        disposition: 'exists',
      },
    );
  }
  for (const g of items(
    await call(env, out, 'rds', 'describe-db-subnet-groups'),
    'DBSubnetGroups',
  )) {
    const name = str(g['DBSubnetGroupName']);
    if (!name || name === 'default') continue;
    record(
      env,
      out,
      {
        names: [name, str(g['DBSubnetGroupDescription'])],
        vpcId: str(g['VpcId']),
        arn: str(g['DBSubnetGroupArn']),
      },
      {
        service: 'rds',
        resourceType: 'AWS::RDS::DBSubnetGroup',
        id: name,
        name,
        state: str(g['SubnetGroupStatus']),
        disposition: 'exists',
      },
    );
  }
  return out;
}

export async function sweepDynamoDb(env: SweepEnv): Promise<SweepOutcome> {
  const out = outcome('dynamodb');
  const names = arr(obj(await call(env, out, 'dynamodb', 'list-tables'))['TableNames'])
    .map(str)
    .filter((n): n is string => n !== undefined);
  // Tables are judged by their tags (tag index), the run's inventory and the stack tag, not by
  // name alone: map table name -> tagged table ARN.
  const taggedByName = new Map<string, string>();
  for (const arn of taggedArnsOf(env, 'dynamodb', 'table/')) {
    const rest = arn.split(':').slice(5).join(':').slice('table/'.length);
    if (!rest.includes('/')) taggedByName.set(rest, arn);
  }
  for (const name of names) {
    const j = env.judge({ names: [name], arn: taggedByName.get(name) }, { id: name });
    if (!j) continue;
    let state: string | undefined;
    let createdAt: string | undefined;
    let arn: string | undefined;
    if (!j.notOwned) {
      const t = obj(
        obj(
          await call(env, out, 'dynamodb', 'describe-table', ['--table-name', name], {
            notFoundIsEmpty: true,
          }),
        )['Table'],
      );
      state = str(t['TableStatus']);
      createdAt = iso(t['CreationDateTime']);
      arn = str(t['TableArn']);
    }
    record(
      env,
      out,
      { names: [name], arn: arn ?? taggedByName.get(name) },
      {
        service: 'dynamodb',
        resourceType: 'AWS::DynamoDB::Table',
        id: name,
        name,
        state,
        createdAt,
        disposition: 'exists',
      },
    );
  }
  for (const b of items(
    await call(env, out, 'dynamodb', 'list-backups', ['--backup-type', 'ALL']),
    'BackupSummaries',
  )) {
    const table = str(b['TableName']);
    const arn = str(b['BackupArn']);
    if (!table || !arn) continue;
    const type = str(b['BackupType']);
    const created = iso(b['BackupCreationDateTime']);
    const system = type === 'SYSTEM';
    record(
      env,
      out,
      { names: [table, str(b['BackupName'])], arn },
      {
        service: 'dynamodb',
        resourceType: 'AWS::DynamoDB::Backup',
        id: `${table}/${str(b['BackupName']) ?? arn.split('/').pop()}`,
        name: table,
        state: `${type ?? 'unknown'} ${str(b['BackupStatus']) ?? ''}`.trim(),
        createdAt: created,
        disposition: system ? 'pending-deletion' : 'exists',
        deletionDate: system ? (iso(b['BackupExpiryDateTime']) ?? addDays(created, 35)) : undefined,
        note: system
          ? `system backup of a deleted PITR table, kept 35 days "at no additional cost" (DynamoDB developer guide); unrestorable once the table key is pending deletion`
          : 'on-demand backup (billed until deleted; backup storage is not in the price snapshot)',
        residualLikelyUsd: system ? 0 : undefined,
        residualWorstUsd: system ? 0 : undefined,
      },
    );
  }
  return out;
}

export async function sweepS3(env: SweepEnv): Promise<SweepOutcome> {
  const out = outcome('s3api');
  for (const b of items(await call(env, out, 's3api', 'list-buckets'), 'Buckets')) {
    const name = str(b['Name']);
    if (!name) continue;
    record(
      env,
      out,
      { names: [name], arn: `arn:aws:s3:::${name}` },
      {
        service: 's3',
        resourceType: 'AWS::S3::Bucket',
        id: name,
        name,
        createdAt: iso(b['CreationDate']),
        state: str(b['BucketRegion']),
        disposition: 'exists',
        note: 'object count not read (no data-plane calls); empty and delete all versions to clean up',
      },
    );
  }
  return out;
}

export async function sweepEcr(env: SweepEnv): Promise<SweepOutcome> {
  const out = outcome('ecr');
  for (const r of items(await call(env, out, 'ecr', 'describe-repositories'), 'repositories')) {
    const name = str(r['repositoryName']);
    const arn = str(r['repositoryArn']);
    if (!name) continue;
    const j = env.judge({ names: [name], arn }, { id: name, createdAt: iso(r['createdAt']) });
    let note = 'repository';
    let hourly = 0;
    if (j && !j.notOwned) {
      const images = items(
        await call(env, out, 'ecr', 'describe-images', ['--repository-name', name], {
          notFoundIsEmpty: true,
        }),
        'imageDetails',
      );
      const gb = images.reduce((a, i) => a + (num(i['imageSizeInBytes']) ?? 0), 0) / 1e9;
      note = `${images.length} image(s), ${Math.round(gb * 1000) / 1000} GB`;
      hourly = (gb * env.book.extra.ecrStorageGbMonth.usd) / HOURS_PER_MONTH;
    }
    record(
      env,
      out,
      { names: [name], arn },
      {
        service: 'ecr',
        resourceType: 'AWS::ECR::Repository',
        id: name,
        name,
        createdAt: iso(r['createdAt']),
        disposition: 'exists',
        note,
        hourlyUsdIfLeft: hourly,
      },
    );
  }
  return out;
}

/** Tag-index ARNs of a service (and resource prefix), e.g. `kms` + `key/`. */
function taggedArnsOf(env: SweepEnv, service: string, resourcePrefix: string): string[] {
  return [...env.match.taggedArns.keys()].filter((arn) => {
    const parts = arn.split(':');
    return parts[2] === service && parts.slice(5).join(':').startsWith(resourcePrefix);
  });
}

export async function sweepSecrets(env: SweepEnv): Promise<SweepOutcome> {
  const out = outcome('secretsmanager');
  const hourly = env.book.secretMonth.usd / SECRETS_HOURS_PER_MONTH;
  const r = await callRaw(env, out, 'secretsmanager', 'list-secrets', [
    '--include-planned-deletion',
  ]);
  if (!r.ok) {
    if (r.error.kind !== 'access-denied') {
      out.errors.push({ operation: 'secretsmanager list-secrets', ...r.error });
      return out;
    }
    secretsUnverifiable(env, out, r.error.code);
    return out;
  }
  for (const s of items(r.data, 'SecretList')) {
    const name = str(s['Name']);
    const arn = str(s['ARN']);
    if (!name) continue;
    const deleted = iso(s['DeletedDate']);
    // The recovery window is not returned by ListSecrets: 30 days (the maximum) is assumed.
    const until = deleted ? addDays(deleted, 30) : undefined;
    record(
      env,
      out,
      { names: [name], tags: tagMap(s['Tags']), arn },
      {
        service: 'secretsmanager',
        resourceType: 'AWS::SecretsManager::Secret',
        id: name,
        name,
        createdAt: iso(s['CreatedDate']),
        state: deleted ? `scheduled for deletion ${deleted}` : 'active',
        disposition: deleted ? 'pending-deletion' : 'exists',
        deletionDate: until,
        note: deleted
          ? `${env.book.notes.secretPendingDeletion.repoQuote} (${env.book.notes.secretPendingDeletion.quotedIn}); deletion date assumes the 30-day maximum recovery window`
          : undefined,
        hourlyUsdIfLeft: deleted ? 0 : hourly,
        residualLikelyUsd: deleted ? 0 : undefined,
        residualWorstUsd: deleted ? round(hourly * hoursUntil(env.now, until)) : undefined,
      },
    );
  }
  return out;
}

/**
 * No Secrets Manager read with this role: the category is reported as unverifiable, with the
 * evidence that exists. A secret CloudFormation did not delete (DELETE_SKIPPED / DELETE_FAILED)
 * is a `remaining` finding (fail-safe); nothing here is ever reported as clean.
 */
function secretsUnverifiable(env: SweepEnv, out: SweepOutcome, code: string): void {
  out.status = 'unverifiable-with-this-role';
  out.denied.push('secretsmanager list-secrets');
  out.evidence.push(
    `secretsmanager list-secrets: ${code} — this role has no Secrets Manager read; whether experiment secrets remain cannot be proven`,
  );
  const tagged = taggedArnsOf(env, 'secretsmanager', 'secret:');
  out.accountedArns.push(...tagged);
  out.evidence.push(
    tagged.length
      ? `tag index lists ${tagged.length} secret(s) tagged for the run / experiment (still existing or scheduled for deletion; the state cannot be read): ${tagged.join(', ')}`
      : `tag index: no secret tagged starter:run-id=${env.runId} or starter:experiment=live-validation (the index can lag deletions)`,
  );
  const inv = env.inventory;
  if (inv) {
    out.evidence.push(
      inv.secrets.length
        ? `inventory recorded ${inv.secrets.length} secret(s): ${inv.secrets.map((x) => `${x.stack}/${x.logicalId} ${x.arn}`).join(', ')}`
        : 'inventory recorded no secret',
    );
  } else {
    out.evidence.push('no --inventory given: the run’s secrets are not known by id');
  }
  const cfnSecrets = (env.cfn?.resources ?? []).filter(
    (x) => x.type === 'AWS::SecretsManager::Secret',
  );
  if (env.cfn?.available) {
    out.evidence.push(
      cfnSecrets.length
        ? `CloudFormation final status: ${cfnSecrets.map((x) => `${x.stack}/${x.logicalId} ${x.status}`).join(', ')}`
        : 'CloudFormation: no AWS::SecretsManager::Secret among the inventoried stacks’ resources',
    );
  } else if (env.cfn) {
    out.evidence.push(env.cfn.note);
  }
  for (const x of cfnSecrets.filter((y) => y.status !== 'DELETE_COMPLETE')) {
    record(
      env,
      out,
      { names: [x.physicalId], arn: x.physicalId?.startsWith('arn:') ? x.physicalId : undefined },
      {
        service: 'secretsmanager',
        resourceType: 'AWS::SecretsManager::Secret',
        id: x.physicalId ?? `${x.stack}/${x.logicalId}`,
        name: `${x.stack}/${x.logicalId}`,
        state: `CloudFormation ${x.status}`,
        disposition: 'exists',
        note: `CloudFormation did not delete it (${x.status}); its existence cannot be read with this role — treated as remaining`,
        hourlyUsdIfLeft: env.book.secretMonth.usd / SECRETS_HOURS_PER_MONTH,
      },
    );
  }
}

export async function sweepKms(env: SweepEnv): Promise<SweepOutcome> {
  const out = outcome('kms');
  const keyHour = env.book.kmsKeyMonth.usd / HOURS_PER_MONTH;
  const aliasesByKey = new Map<string, string[]>();
  for (const a of items(await call(env, out, 'kms', 'list-aliases'), 'Aliases')) {
    const name = str(a['AliasName']);
    const target = str(a['TargetKeyId']);
    if (!name || name.startsWith('alias/aws/')) continue;
    if (target) aliasesByKey.set(target, [...(aliasesByKey.get(target) ?? []), name]);
    record(
      env,
      out,
      { names: [name], arn: str(a['AliasArn']) },
      {
        service: 'kms',
        resourceType: 'AWS::KMS::Alias',
        id: name,
        name,
        createdAt: iso(a['CreationDate']),
        disposition: 'exists',
      },
    );
  }

  // Exhaustive listing, or (when the role cannot list keys) the keys known some other way.
  const sources = new Map<string, Set<string>>();
  const add = (keyId: string | undefined, source: string) => {
    if (!keyId) return;
    sources.set(keyId, (sources.get(keyId) ?? new Set()).add(source));
  };
  const listed = await callRaw(env, out, 'kms', 'list-keys');
  if (listed.ok) {
    for (const k of items(listed.data, 'Keys')) add(str(k['KeyId']), 'list-keys');
  } else if (listed.error.kind === 'access-denied') {
    out.status = 'fallback';
    out.denied.push('kms list-keys');
    for (const arn of taggedArnsOf(env, 'kms', 'key/')) add(arn.split('/').pop(), 'tag index');
    for (const k of env.inventory?.kmsKeys ?? []) add(k.keyId, 'inventory');
    for (const [keyId, names] of aliasesByKey) {
      if (matchName(names)) add(keyId, 'alias');
    }
    for (const x of env.cfn?.resources ?? []) {
      if (x.type === 'AWS::KMS::Key') add(x.physicalId, 'deleted-stack resource');
    }
    const count = (src: string) => [...sources.values()].filter((v) => v.has(src)).length;
    out.evidence.push(
      `kms list-keys: ${listed.error.code} — the role cannot enumerate keys; ${sources.size} key(s) found through the tag index (${count('tag index')}), the inventory (${count('inventory')}${env.inventory ? '' : ', no --inventory given'}), experiment aliases (${count('alias')}) and deleted-stack resources (${count('deleted-stack resource')}), each read with describe-key. Keys that are untagged, unaliased and not inventoried cannot be found with this role.`,
    );
  } else {
    out.errors.push({ operation: 'kms list-keys', ...listed.error });
  }

  let tagsReadable = true;
  for (const [keyId, from] of sources) {
    const described = await callRaw(env, out, 'kms', 'describe-key', ['--key-id', keyId]);
    if (!described.ok) {
      if (described.error.kind === 'not-found') {
        if (out.status === 'fallback') out.evidence.push(`key ${keyId}: not found (deleted)`);
        continue;
      }
      out.errors.push({ operation: 'kms describe-key', ...described.error });
      continue;
    }
    const meta = obj(described.data['KeyMetadata']);
    if (str(meta['KeyManager']) !== 'CUSTOMER') continue; // AWS managed keys are never the experiment's
    let tags: Record<string, string> = {};
    if (tagsReadable) {
      const t = await callRaw(env, out, 'kms', 'list-resource-tags', ['--key-id', keyId]);
      if (t.ok) tags = tagMap(t.data['Tags'], 'TagKey', 'TagValue');
      else if (t.error.kind === 'access-denied') {
        // Not needed for a verdict: the tag index carries the same tags for tagged keys.
        tagsReadable = false;
        out.denied.push('kms list-resource-tags');
        out.evidence.push(
          `kms list-resource-tags: ${t.error.code} — key tags are taken from the tag index only`,
        );
      } else if (t.error.kind !== 'not-found') {
        out.errors.push({ operation: 'kms list-resource-tags', ...t.error });
      }
    }
    const state = str(meta['KeyState']);
    const pending = state === 'PendingDeletion' || state === 'PendingReplicaDeletion';
    const deletionDate = iso(meta['DeletionDate']);
    const note = env.book.notes.kmsKeyPendingDeletion;
    if (out.status === 'fallback') {
      out.evidence.push(
        `key ${keyId}: ${state ?? 'unknown'}${deletionDate ? ` until ${deletionDate}` : ''} (from ${[...from].join(', ')})`,
      );
    }
    record(
      env,
      out,
      {
        names: [...(aliasesByKey.get(keyId) ?? []), str(meta['Description'])],
        tags,
        arn: str(meta['Arn']),
      },
      {
        service: 'kms',
        resourceType: 'AWS::KMS::Key',
        id: keyId,
        name: str(meta['Description']),
        state,
        createdAt: iso(meta['CreationDate']),
        disposition: pending ? 'pending-deletion' : 'exists',
        deletionDate,
        note: pending
          ? `likely no charge: ${note.repoQuote} (${note.quotedIn}); not in the price snapshot, so the worst case prices it until ${deletionDate ?? 'its deletion date'}. Never cancel the deletion to keep backups restorable`
          : state === 'Disabled'
            ? 'disabled keys are still billed; schedule deletion'
            : 'enabled customer managed key (billed); schedule deletion',
        hourlyUsdIfLeft: pending ? 0 : keyHour,
        residualLikelyUsd: pending ? 0 : undefined,
        residualWorstUsd: pending ? round(keyHour * hoursUntil(env.now, deletionDate)) : undefined,
      },
    );
  }
  return out;
}
