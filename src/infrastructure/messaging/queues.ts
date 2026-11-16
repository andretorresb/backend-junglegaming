import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  QueueDoesNotExist,
  type SQSClient,
} from '@aws-sdk/client-sqs';

/** Filas do enunciado (seção 10) e a de eventos de integração (seção 11). */
export const WAGER_QUEUE = 'wager-transactions.fifo';
export const WAGER_DLQ = 'wager-transactions-dlq.fifo';
export const EVENTS_QUEUE = 'wager-events';

/** Tentativas antes de a mensagem ir para a DLQ (seção 10: limite antes da DLQ). */
export const MAX_RECEIVE_COUNT = 5;

/**
 * Cria as filas se não existirem. Idempotente: CreateQueue com os mesmos atributos é no-op.
 * Usado pelo script de inicialização do LocalStack e pelos testes.
 */
export async function ensureQueues(sqs: SQSClient): Promise<{ wager: string; dlq: string; events: string }> {
  const dlq = await createQueue(sqs, WAGER_DLQ, { FifoQueue: 'true', ContentBasedDeduplication: 'false' });
  const dlqArn = await queueArn(sqs, dlq);
  const wager = await createQueue(sqs, WAGER_QUEUE, {
    FifoQueue: 'true',
    ContentBasedDeduplication: 'false',
    RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: String(MAX_RECEIVE_COUNT) }),
  });
  const events = await createQueue(sqs, EVENTS_QUEUE, {});
  return { wager, dlq, events };
}

export async function queueUrl(sqs: SQSClient, name: string): Promise<string> {
  const response = await sqs.send(new GetQueueUrlCommand({ QueueName: name }));
  if (!response.QueueUrl) throw new Error(`fila ${name} sem URL`);
  return response.QueueUrl;
}

async function createQueue(sqs: SQSClient, name: string, attributes: Record<string, string>): Promise<string> {
  const response = await sqs.send(new CreateQueueCommand({ QueueName: name, Attributes: attributes }));
  if (!response.QueueUrl) throw new Error(`falha ao criar fila ${name}`);
  return response.QueueUrl;
}

async function queueArn(sqs: SQSClient, url: string): Promise<string> {
  const response = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ['QueueArn'] }));
  const arn = response.Attributes?.['QueueArn'];
  if (!arn) throw new QueueDoesNotExist({ message: `sem ARN para ${url}`, $metadata: {} });
  return arn;
}
