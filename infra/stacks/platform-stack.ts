import { CfnOutput } from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import type { Construct } from 'constructs';
import { ImageRepository } from '../constructs/image-repository.js';
import { WorkloadStack, type WorkloadStackProps } from './workload-stack.js';

export type PlatformStackProps = Omit<WorkloadStackProps, 'suffix' | 'description'>;

/** Where consumer stacks get the API image repository from. */
export interface ImageSource {
  repositoryFor(consumer: Construct): ecr.IRepository;
}

/**
 * Container platform shared by the API service and the one-off migration
 * task: the ECS cluster (Fargate + Fargate Spot capacity providers, Container
 * Insights) and, when `api.ecr.mode = "create"`, the image repository.
 * Deployed first so CI can push the image (by digest) and run migrations
 * before the API service references them.
 */
export class PlatformStack extends WorkloadStack implements ImageSource {
  public readonly cluster: ecs.Cluster;
  public readonly images?: ImageRepository;

  constructor(scope: Construct, id: string, props: PlatformStackProps) {
    super(scope, id, {
      ...props,
      suffix: 'platform',
      description: 'AWS modernization starter: container platform (ECS cluster, image registry)',
    });
    const { config, foundation } = this;

    this.cluster = new ecs.Cluster(this, 'Cluster', {
      clusterName: `${config.resourcePrefix}-cluster`,
      vpc: foundation.vpc,
      containerInsightsV2: ecs.ContainerInsights.ENHANCED,
      enableFargateCapacityProviders: true,
    });
    new CfnOutput(this, 'ClusterName', { value: this.cluster.clusterName });

    if (config.api.ecr.mode === 'create') {
      this.images = new ImageRepository(this, 'ApiImages', {
        repositoryName: `${config.resourcePrefix}/api`,
        encryptionKey: foundation.dataKey,
        teardown: config.teardown,
      });
      new CfnOutput(this, 'EcrRepositoryUri', { value: this.images.repository.repositoryUri });
      new CfnOutput(this, 'EcrRepositoryName', { value: this.images.repository.repositoryName });
    }
  }

  /**
   * The API image repository as seen from `consumer`: the repository created
   * here, or the configured existing repository imported into that stack.
   */
  public repositoryFor(consumer: Construct): ecr.IRepository {
    if (this.images) return this.images.repository;
    const { ecr: source } = this.config.api;
    if (source.mode !== 'import') throw new Error('unreachable: no repository configured');
    return ecr.Repository.fromRepositoryArn(consumer, 'ApiImageRepository', source.repositoryArn);
  }
}
