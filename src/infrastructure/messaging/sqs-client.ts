import { SQSClient } from '@aws-sdk/client-sqs';
import type { AppEnv } from '../../config/env';

/** Cliente SQS apontando para o LocalStack em desenvolvimento e testes. */
export function createSqsClient(env: AppEnv): SQSClient {
  return new SQSClient({
    endpoint: env.aws.endpoint,
    region: env.aws.region,
    credentials: { accessKeyId: env.aws.accessKeyId, secretAccessKey: env.aws.secretAccessKey },
  });
}
