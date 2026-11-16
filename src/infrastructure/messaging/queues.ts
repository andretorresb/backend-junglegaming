import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  QueueDoesNotExist,
  type SQSClient,
} from '@aws-sdk/client-sqs';

/** Nomes padrão das filas (seção 10 e 11 do enunciado). A aplicação lê os nomes do ambiente. */
export const WAGER_QUEUE = 'wager-transactions.fifo';
export const WAGER_DLQ = 'wager-transactions-dlq.fifo';
export const EVENTS_QUEUE = 'wager-events';

/** Tentativas padrão antes da DLQ. Deve coincidir com SQS_MAX_RECEIVE_COUNT. */
export const MAX_RECEIVE_COUNT = 5;

export interface QueueSettings {
  /** Fila de entrada. Nome FIFO (termina em .fifo). */
  wager: string;
  /** Dead-letter queue da fila de entrada. Nome FIFO. */
  dlq: string;
  /** Fila de eventos de integração. Padrão (não FIFO). */
  events: string;
  /** Tentativas antes da DLQ, aplicadas como redrive policy no SQS. */
  maxReceiveCount: number;
}

export const DEFAULT_QUEUE_SETTINGS: QueueSettings = {
  wager: WAGER_QUEUE,
  dlq: WAGER_DLQ,
  events: EVENTS_QUEUE,
  maxReceiveCount: MAX_RECEIVE_COUNT,
};

/** Configuração de filas lida do ambiente: a mesma que o consumidor e o publisher usam. */
export function queueSettingsFromEnv(env: {
  consumer: { queueName: string; dlqName: string; maxReceiveCount: number };
  outbox: { queueName: string };
}): QueueSettings {
  return {
    wager: env.consumer.queueName,
    dlq: env.consumer.dlqName,
    events: env.outbox.queueName,
    maxReceiveCount: env.consumer.maxReceiveCount,
  };
}

/**
 * Cria as filas com os nomes recebidos. Idempotente: CreateQueue com os mesmos atributos é no-op.
 * Nomes FIFO sem o sufixo .fifo são recusados antes de chamar a AWS, com mensagem clara.
 */
export async function ensureQueues(
  sqs: SQSClient,
  settings: QueueSettings = DEFAULT_QUEUE_SETTINGS,
): Promise<{ wager: string; dlq: string; events: string }> {
  for (const name of [settings.wager, settings.dlq]) {
    if (!name.endsWith('.fifo')) {
      throw new Error(`fila FIFO "${name}" precisa terminar em .fifo`);
    }
  }
  const dlq = await createQueue(sqs, settings.dlq, { FifoQueue: 'true', ContentBasedDeduplication: 'false' });
  const dlqArn = await queueArn(sqs, dlq);
  const wager = await createQueue(sqs, settings.wager, {
    FifoQueue: 'true',
    ContentBasedDeduplication: 'false',
    RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: String(settings.maxReceiveCount) }),
  });
  const events = await createQueue(sqs, settings.events, {});
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
