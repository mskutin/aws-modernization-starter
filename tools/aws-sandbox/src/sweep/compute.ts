/** ECS, Lambda, Step Functions, EventBridge rules and schedules. */
import { taskHour } from '../model/estimate.js';
import {
  arr,
  call,
  chunks,
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

const lastSegment = (arn: string) => arn.split('/').pop() ?? arn;

export async function sweepEcs(env: SweepEnv): Promise<SweepOutcome> {
  const out = outcome('ecs');
  const rate = taskHour(env.book, 0.25, 0.5, 'arm64');
  const clusterArns = arr(obj(await call(env, out, 'ecs', 'list-clusters'))['clusterArns'])
    .map(str)
    .filter((a): a is string => a !== undefined);
  const owned: { arn: string; name: string }[] = [];
  for (const batch of chunks(clusterArns, 100)) {
    const r = await call(env, out, 'ecs', 'describe-clusters', [
      '--clusters',
      ...batch,
      '--include',
      'TAGS',
    ]);
    for (const c of items(r, 'clusters')) {
      const arn = str(c['clusterArn']);
      const name = str(c['clusterName']);
      if (!arn || !name) continue;
      const status = str(c['status']);
      const j = record(
        env,
        out,
        { names: [name], tags: tagMap(c['tags'], 'key', 'value'), arn },
        {
          service: 'ecs',
          resourceType: 'AWS::ECS::Cluster',
          id: name,
          name,
          state: status,
          disposition: status === 'INACTIVE' ? 'gone' : 'exists',
          note: `${num(c['activeServicesCount']) ?? 0} active service(s), ${num(c['runningTasksCount']) ?? 0} running task(s)`,
        },
      );
      if (j && !j.notOwned && status !== 'INACTIVE') owned.push({ arn, name });
    }
  }
  for (const cluster of owned) {
    const serviceArns = arr(
      obj(await call(env, out, 'ecs', 'list-services', ['--cluster', cluster.arn]))['serviceArns'],
    )
      .map(str)
      .filter((a): a is string => a !== undefined);
    for (const batch of chunks(serviceArns, 10)) {
      const r = await call(env, out, 'ecs', 'describe-services', [
        '--cluster',
        cluster.arn,
        '--services',
        ...batch,
        '--include',
        'TAGS',
      ]);
      for (const s of items(r, 'services')) {
        const arn = str(s['serviceArn']);
        const name = str(s['serviceName']);
        if (!arn || !name) continue;
        const status = str(s['status']);
        const running = num(s['runningCount']) ?? 0;
        record(
          env,
          out,
          // A service in an experiment cluster is the experiment's.
          { names: [name, cluster.name], tags: tagMap(s['tags'], 'key', 'value'), arn },
          {
            service: 'ecs',
            resourceType: 'AWS::ECS::Service',
            id: `${cluster.name}/${name}`,
            name,
            state: status,
            createdAt: iso(s['createdAt']),
            disposition: status === 'INACTIVE' ? 'gone' : 'exists',
            note: `desired ${num(s['desiredCount']) ?? 0}, running ${running}`,
            hourlyUsdIfLeft: running * rate,
          },
        );
      }
    }
    const taskArns = arr(
      obj(await call(env, out, 'ecs', 'list-tasks', ['--cluster', cluster.arn]))['taskArns'],
    )
      .map(str)
      .filter((a): a is string => a !== undefined);
    for (const arn of taskArns) {
      record(
        env,
        out,
        { names: [cluster.name], arn },
        {
          service: 'ecs',
          resourceType: 'AWS::ECS::Task',
          id: `${cluster.name}/${lastSegment(arn)}`,
          disposition: 'exists',
          state: 'RUNNING',
          note: 'running task (service or one-off); priced at 0.25 vCPU / 0.5 GB arm64 [ASSUMPTION]',
          hourlyUsdIfLeft: rate,
        },
      );
    }
  }
  const families = arr(
    obj(await call(env, out, 'ecs', 'list-task-definition-families', ['--status', 'ACTIVE']))[
      'families'
    ],
  )
    .map(str)
    .filter((f): f is string => f !== undefined);
  for (const family of families) {
    const j = env.judge({ names: [family] }, { id: family });
    if (!j || j.notOwned) {
      if (j)
        record(
          env,
          out,
          { names: [family] },
          {
            service: 'ecs',
            resourceType: 'AWS::ECS::TaskDefinition',
            id: family,
            name: family,
            disposition: 'exists',
          },
        );
      continue;
    }
    const r = await call(env, out, 'ecs', 'list-task-definitions', [
      '--family-prefix',
      family,
      '--status',
      'ACTIVE',
    ]);
    const revisions = arr(obj(r)['taskDefinitionArns'])
      .map(str)
      .filter(
        (a): a is string => a !== undefined && lastSegment(a).replace(/:\d+$/, '') === family,
      );
    record(
      env,
      out,
      { names: [family] },
      {
        service: 'ecs',
        resourceType: 'AWS::ECS::TaskDefinition',
        id: family,
        name: family,
        state: 'ACTIVE',
        disposition: revisions.length > 0 ? 'exists' : 'gone',
        note: `${revisions.length} ACTIVE revision(s) (no charge; deregister to clean up)`,
      },
    );
  }
  return out;
}

export async function sweepLambda(env: SweepEnv): Promise<SweepOutcome> {
  const out = outcome('lambda');
  // The response includes function configurations (environment variables): only the name,
  // ARN and last-modified time are read; the rest is dropped here.
  for (const f of items(await call(env, out, 'lambda', 'list-functions'), 'Functions')) {
    const name = str(f['FunctionName']);
    const arn = str(f['FunctionArn']);
    if (!name) continue;
    record(
      env,
      out,
      { names: [name], arn },
      {
        service: 'lambda',
        resourceType: 'AWS::Lambda::Function',
        id: name,
        name,
        disposition: 'exists',
        note: `last modified ${iso(f['LastModified']) ?? 'unknown'}`,
      },
    );
  }
  for (const l of items(await call(env, out, 'lambda', 'list-layers'), 'Layers')) {
    const name = str(l['LayerName']);
    if (!name) continue;
    record(
      env,
      out,
      { names: [name], arn: str(l['LayerArn']) },
      {
        service: 'lambda',
        resourceType: 'AWS::Lambda::LayerVersion',
        id: name,
        name,
        createdAt: iso(obj(l['LatestMatchingVersion'])['CreatedDate']),
        disposition: 'exists',
      },
    );
  }
  return out;
}

export async function sweepStepFunctions(env: SweepEnv): Promise<SweepOutcome> {
  const out = outcome('stepfunctions');
  for (const m of items(
    await call(env, out, 'stepfunctions', 'list-state-machines'),
    'stateMachines',
  )) {
    const name = str(m['name']);
    const arn = str(m['stateMachineArn']);
    if (!name || !arn) continue;
    const j = env.judge({ names: [name], arn }, { id: name, createdAt: iso(m['creationDate']) });
    let note: string | undefined;
    if (j && !j.notOwned) {
      const versions = arr(
        obj(
          await call(env, out, 'stepfunctions', 'list-state-machine-versions', [
            '--state-machine-arn',
            arn,
          ]),
        )['stateMachineVersions'],
      ).length;
      const aliases = arr(
        obj(
          await call(env, out, 'stepfunctions', 'list-state-machine-aliases', [
            '--state-machine-arn',
            arn,
          ]),
        )['stateMachineAliases'],
      ).length;
      note = `${str(m['type']) ?? 'STANDARD'}; ${versions} version(s), ${aliases} alias(es) (deleted with the state machine)`;
    }
    record(
      env,
      out,
      { names: [name], arn },
      {
        service: 'stepfunctions',
        resourceType: 'AWS::StepFunctions::StateMachine',
        id: name,
        name,
        createdAt: iso(m['creationDate']),
        disposition: 'exists',
        note,
      },
    );
  }
  return out;
}

export async function sweepEvents(env: SweepEnv): Promise<SweepOutcome> {
  const out = outcome('events');
  for (const r of items(await call(env, out, 'events', 'list-rules'), 'Rules')) {
    const name = str(r['Name']);
    if (!name) continue;
    record(
      env,
      out,
      { names: [name], arn: str(r['Arn']) },
      {
        service: 'events',
        resourceType: 'AWS::Events::Rule',
        id: name,
        name,
        state: str(r['State']),
        disposition: 'exists',
      },
    );
  }
  return out;
}

/** Why EventBridge Scheduler is not swept (the role cannot list schedules either). */
export const SCHEDULER_JUSTIFICATION =
  'the experiment schedules the stale-job reconciler with an EventBridge rule (AWS::Events::Rule, swept with events list-rules); neither the Sandbox stage nor the mini-stack defines AWS::Scheduler::Schedule. A tagged schedule would still be listed by the tag index, and an unswept tagged type makes the run incomplete.';

export function schedulerNotUsed(): SweepOutcome {
  const out = outcome('scheduler');
  out.status = 'not-used-by-experiment';
  out.justification = SCHEDULER_JUSTIFICATION;
  return out;
}
