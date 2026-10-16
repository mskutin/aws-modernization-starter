import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import type * as kms from 'aws-cdk-lib/aws-kms';
import { Construct } from 'constructs';

/** How many images to keep: the rollback window for digest-pinned deploys. */
export const MAX_IMAGE_COUNT = 100;

export interface ImageRepositoryProps {
  readonly repositoryName: string;
  readonly encryptionKey: kms.IKey;
  /**
   * `destroy` (sandbox only): the repository is emptied (CloudFormation `EmptyOnDelete`, no
   * custom resource) and deleted with the stack.
   * @default 'retain'
   */
  readonly teardown?: 'retain' | 'destroy';
}

/**
 * ECR repository for the API image: immutable tags, scan on push, CMK
 * encryption, lifecycle rules, retained on stack deletion (emptied and deleted in the
 * sandbox). Lives in its own stack so CI can push the first image before the ECS service is
 * created.
 */
export class ImageRepository extends Construct {
  public readonly repository: ecr.Repository;

  constructor(scope: Construct, id: string, props: ImageRepositoryProps) {
    super(scope, id);
    this.repository = new ecr.Repository(this, 'Repository', {
      repositoryName: props.repositoryName,
      imageTagMutability: ecr.TagMutability.IMMUTABLE,
      imageScanOnPush: true,
      encryption: ecr.RepositoryEncryption.KMS,
      encryptionKey: props.encryptionKey,
      ...(props.teardown === 'destroy'
        ? { removalPolicy: RemovalPolicy.DESTROY, emptyOnDelete: true }
        : { removalPolicy: RemovalPolicy.RETAIN }),
    });
    this.repository.addLifecycleRule({
      description: 'Expire untagged images after 14 days',
      tagStatus: ecr.TagStatus.UNTAGGED,
      maxImageAge: Duration.days(14),
    });
    this.repository.addLifecycleRule({
      description: `Keep the ${MAX_IMAGE_COUNT} most recent images (rollback window)`,
      tagStatus: ecr.TagStatus.ANY,
      maxImageCount: MAX_IMAGE_COUNT,
    });
  }
}
