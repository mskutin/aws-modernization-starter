/**
 * CloudFormation outputs of the sandbox stage, read by the lifecycle scripts from
 * `cdk deploy --outputs-file`. Added ONLY to the sandbox stage, so the governed templates
 * stay unchanged; outputs the stacks already define for every environment (ClusterName,
 * StateMachineArn, ReconcilerFunctionName, BootstrapTaskDefinitionArn, MigrationTaskDefinitionArn,
 * ServiceName, TaskDefinitionFamily, DistributionDomainName, DistributionId, WebBucketName,
 * AlarmTopicArn) and the TestIssuer outputs (IssuerUrl, IssuerBucketName, IssuerDistributionId)
 * are not repeated here.
 */
import { CfnOutput, Fn, type Stack } from 'aws-cdk-lib';
import type { WorkloadStage } from './workload-stage.js';

/** Contract output names per stack id (CfnOutput logical ids = output keys). */
export const SANDBOX_OUTPUTS = {
  TestIssuer: ['IssuerUrl', 'IssuerBucketName', 'IssuerDistributionId'],
  Foundation: ['VpcId', 'DataKeyArn', 'LogsKeyArn'],
  Platform: ['ClusterName', 'ApiRepositoryName', 'ApiRepositoryUri'],
  Data: ['DbEndpoint', 'DbMasterSecretArn', 'JobTableName'],
  Workflow: [
    'StateMachineArn',
    'ValidatorFunctionName',
    'ProcessorFunctionName',
    'ReconcilerFunctionName',
  ],
  Migrations: [
    'BootstrapTaskDefinitionArn',
    'MigrationTaskDefinitionArn',
    'TaskSubnetIds',
    'TaskSecurityGroupId',
  ],
  Api: ['ServiceName', 'TaskDefinitionFamily', 'AlbDnsName', 'ApiLogGroupName'],
  Frontend: ['DistributionDomainName', 'DistributionId', 'WebBucketName'],
  Observability: ['AlarmTopicArn'],
} as const;

const output = (stack: Stack, id: string, value: string, description?: string): void => {
  new CfnOutput(stack, id, { value, ...(description ? { description } : {}) });
};

export function addSandboxOutputs(stage: WorkloadStage): void {
  const foundation = stage.foundationStack;
  if (!foundation) throw new Error('addSandboxOutputs: the sandbox stage has no foundation stack');
  const f = foundation.foundation;
  output(foundation, 'VpcId', f.vpc.vpcId);
  output(foundation, 'DataKeyArn', f.dataKey.keyArn);
  output(foundation, 'LogsKeyArn', f.logsKey.keyArn);

  const images = stage.platform.images;
  if (!images) throw new Error('addSandboxOutputs: the sandbox creates its ECR repository');
  output(stage.platform, 'ApiRepositoryName', images.repository.repositoryName);
  output(stage.platform, 'ApiRepositoryUri', images.repository.repositoryUri);

  const db = stage.data.database;
  output(stage.data, 'DbEndpoint', db.instance.dbInstanceEndpointAddress);
  output(stage.data, 'DbMasterSecretArn', db.secret.secretArn);
  output(stage.data, 'JobTableName', stage.data.jobTable.table.tableName);

  const wf = stage.workflow.workflow;
  output(stage.workflow, 'ValidatorFunctionName', wf.validator.fn.functionName);
  output(stage.workflow, 'ProcessorFunctionName', wf.processor.fn.functionName);

  const m = stage.migrations;
  output(
    m,
    'TaskSubnetIds',
    Fn.join(',', foundation.foundation.vpc.selectSubnets(f.appSubnets).subnetIds),
    'App subnets for ecs run-task (bootstrap, migration, in-VPC probes)',
  );
  output(
    m,
    'TaskSecurityGroupId',
    m.migration.securityGroup.securityGroupId,
    'Migration task security group (PostgreSQL + HTTPS egress); the bootstrap task uses BootstrapSecurityGroupId',
  );

  output(stage.api, 'AlbDnsName', stage.api.api.loadBalancer.loadBalancerDnsName);
  output(stage.api, 'ApiLogGroupName', stage.api.api.logGroup.logGroupName);
}
