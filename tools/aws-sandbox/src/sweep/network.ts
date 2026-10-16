/** EC2/VPC and ELBv2 sweeps. VPCs run first: their ids make dependent resources experiment-owned. */
import {
  call,
  chunks,
  items,
  iso,
  obj,
  outcome,
  record,
  str,
  tagMap,
  arr,
  type SweepEnv,
  type SweepOutcome,
} from './common.js';

export async function sweepNetwork(env: SweepEnv): Promise<SweepOutcome> {
  const out = outcome('ec2');
  const { book } = env;
  const region = env.region;
  const ec2Arn = (owner: string | undefined, kind: string, id: string) =>
    owner ? `arn:aws:ec2:${region}:${owner}:${kind}/${id}` : undefined;

  const vpcs = await call(env, out, 'ec2', 'describe-vpcs');
  for (const v of items(vpcs, 'Vpcs')) {
    const id = str(v['VpcId']);
    if (!id || v['IsDefault'] === true) continue;
    const tags = tagMap(v['Tags']);
    const j = record(
      env,
      out,
      { names: [tags['Name']], tags, arn: ec2Arn(str(v['OwnerId']), 'vpc', id) },
      {
        service: 'ec2',
        resourceType: 'AWS::EC2::VPC',
        id,
        name: tags['Name'],
        state: str(v['State']),
        disposition: 'exists',
      },
    );
    if (j && !j.notOwned) env.match.experimentVpcIds.add(id);
  }

  const subnets = await call(env, out, 'ec2', 'describe-subnets');
  for (const s of items(subnets, 'Subnets')) {
    const id = str(s['SubnetId']);
    if (!id) continue;
    const tags = tagMap(s['Tags']);
    record(
      env,
      out,
      { names: [tags['Name']], tags, vpcId: str(s['VpcId']), arn: str(s['SubnetArn']) },
      {
        service: 'ec2',
        resourceType: 'AWS::EC2::Subnet',
        id,
        name: tags['Name'],
        state: str(s['State']),
        disposition: 'exists',
      },
    );
  }

  const igws = await call(env, out, 'ec2', 'describe-internet-gateways');
  for (const g of items(igws, 'InternetGateways')) {
    const id = str(g['InternetGatewayId']);
    if (!id) continue;
    const tags = tagMap(g['Tags']);
    const vpcId = str(obj(arr(g['Attachments'])[0])['VpcId']);
    record(
      env,
      out,
      {
        names: [tags['Name']],
        tags,
        vpcId,
        arn: ec2Arn(str(g['OwnerId']), 'internet-gateway', id),
      },
      {
        service: 'ec2',
        resourceType: 'AWS::EC2::InternetGateway',
        id,
        name: tags['Name'],
        disposition: 'exists',
      },
    );
  }

  /** EIP allocation -> VPC of the experiment NAT gateway that uses it. */
  const natAllocations = new Map<string, string>();
  const nats = await call(env, out, 'ec2', 'describe-nat-gateways');
  for (const n of items(nats, 'NatGateways')) {
    const id = str(n['NatGatewayId']);
    if (!id) continue;
    const tags = tagMap(n['Tags']);
    const state = str(n['State']);
    const gone = state === 'deleted' || state === 'failed';
    const j = record(
      env,
      out,
      { names: [tags['Name']], tags, vpcId: str(n['VpcId']) },
      {
        service: 'ec2',
        resourceType: 'AWS::EC2::NatGateway',
        id,
        name: tags['Name'],
        state,
        createdAt: iso(n['CreateTime']),
        disposition: gone ? 'gone' : 'exists',
        note:
          state === 'deleting' ? 'deletion in progress (billed until deleted); re-run' : undefined,
        hourlyUsdIfLeft: gone ? 0 : book.natHour.usd,
      },
    );
    const natVpc = str(n['VpcId']);
    if (j && !j.notOwned && natVpc) {
      for (const a of items(n, 'NatGatewayAddresses')) {
        const alloc = str(a['AllocationId']);
        if (alloc) natAllocations.set(alloc, natVpc);
      }
    }
  }

  const addresses = await call(env, out, 'ec2', 'describe-addresses');
  for (const a of items(addresses, 'Addresses')) {
    const id = str(a['AllocationId']);
    if (!id) continue;
    const tags = tagMap(a['Tags']);
    record(
      env,
      out,
      // An EIP has no VPC; one used by an experiment NAT gateway counts as in that VPC.
      { names: [tags['Name']], tags, vpcId: natAllocations.get(id) },
      {
        service: 'ec2',
        resourceType: 'AWS::EC2::EIP',
        id,
        name: tags['Name'],
        state: str(a['AssociationId']) ? 'associated' : 'unassociated',
        disposition: 'exists',
        note: natAllocations.has(id) ? 'allocation of an experiment NAT gateway' : undefined,
        hourlyUsdIfLeft: book.publicIpv4Hour.usd,
      },
    );
  }

  const enis = await call(env, out, 'ec2', 'describe-network-interfaces');
  for (const e of items(enis, 'NetworkInterfaces')) {
    const id = str(e['NetworkInterfaceId']);
    if (!id) continue;
    const tags = tagMap(e['TagSet']);
    record(
      env,
      out,
      { names: [tags['Name'], str(e['Description'])], tags, vpcId: str(e['VpcId']) },
      {
        service: 'ec2',
        resourceType: 'AWS::EC2::NetworkInterface',
        id,
        name: str(e['InterfaceType']),
        state: str(e['Status']),
        disposition: 'exists',
        note: 'blocks subnet / security group / VPC deletion until released',
      },
    );
  }

  const sgs = await call(env, out, 'ec2', 'describe-security-groups');
  for (const g of items(sgs, 'SecurityGroups')) {
    const id = str(g['GroupId']);
    if (!id) continue;
    const tags = tagMap(g['Tags']);
    record(
      env,
      out,
      {
        names: [str(g['GroupName']), tags['Name']],
        tags,
        vpcId: str(g['VpcId']),
        arn: str(g['SecurityGroupArn']),
      },
      {
        service: 'ec2',
        resourceType: 'AWS::EC2::SecurityGroup',
        id,
        name: str(g['GroupName']),
        disposition: 'exists',
      },
    );
  }

  const endpoints = await call(env, out, 'ec2', 'describe-vpc-endpoints');
  for (const p of items(endpoints, 'VpcEndpoints')) {
    const id = str(p['VpcEndpointId']);
    if (!id) continue;
    const tags = tagMap(p['Tags']);
    const state = str(p['State']);
    const gone = state === 'deleted' || state === 'Deleted';
    const azs = arr(p['SubnetIds']).length;
    record(
      env,
      out,
      { names: [tags['Name']], tags, vpcId: str(p['VpcId']) },
      {
        service: 'ec2',
        resourceType: 'AWS::EC2::VPCEndpoint',
        id,
        name: str(p['ServiceName']),
        state,
        createdAt: iso(p['CreationTimestamp']),
        disposition: gone ? 'gone' : 'exists',
        hourlyUsdIfLeft:
          str(p['VpcEndpointType']) === 'Interface' ? azs * book.interfaceEndpointHourPerAz.usd : 0,
      },
    );
  }
  return out;
}

export async function sweepLoadBalancing(env: SweepEnv): Promise<SweepOutcome> {
  const out = outcome('elbv2');
  const { book } = env;
  const lbs = items(await call(env, out, 'elbv2', 'describe-load-balancers'), 'LoadBalancers');
  const tgs = items(await call(env, out, 'elbv2', 'describe-target-groups'), 'TargetGroups');
  const arns = [
    ...lbs.map((l) => str(l['LoadBalancerArn'])),
    ...tgs.map((t) => str(t['TargetGroupArn'])),
  ].filter((a): a is string => a !== undefined);
  const tags = new Map<string, Record<string, string>>();
  for (const batch of chunks(arns, 20)) {
    const r = await call(env, out, 'elbv2', 'describe-tags', ['--resource-arns', ...batch]);
    for (const d of items(r, 'TagDescriptions')) {
      const arn = str(d['ResourceArn']);
      if (arn) tags.set(arn, tagMap(d['Tags']));
    }
  }
  for (const l of lbs) {
    const arn = str(l['LoadBalancerArn']);
    if (!arn) continue;
    const name = str(l['LoadBalancerName']);
    const internetFacing = str(l['Scheme']) === 'internet-facing';
    const azs = arr(l['AvailabilityZones']).length || 2;
    record(
      env,
      out,
      { names: [name], tags: tags.get(arn), vpcId: str(l['VpcId']), arn },
      {
        service: 'elbv2',
        resourceType: 'AWS::ElasticLoadBalancingV2::LoadBalancer',
        id: name ?? arn,
        name,
        state: str(obj(l['State'])['Code']),
        createdAt: iso(l['CreatedTime']),
        disposition: 'exists',
        note: internetFacing ? `internet-facing, ${azs} AZ(s)` : 'internal',
        hourlyUsdIfLeft:
          book.albHour.usd +
          book.albLcuHour.usd +
          (internetFacing ? azs * book.publicIpv4Hour.usd : 0),
      },
    );
  }
  for (const t of tgs) {
    const arn = str(t['TargetGroupArn']);
    if (!arn) continue;
    const name = str(t['TargetGroupName']);
    record(
      env,
      out,
      { names: [name], tags: tags.get(arn), vpcId: str(t['VpcId']), arn },
      {
        service: 'elbv2',
        resourceType: 'AWS::ElasticLoadBalancingV2::TargetGroup',
        id: name ?? arn,
        name,
        disposition: 'exists',
      },
    );
  }
  return out;
}
