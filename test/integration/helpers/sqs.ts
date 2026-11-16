import { ReceiveMessageCommand, DeleteMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { queueUrl } from '../../../src/infrastructure/messaging/queues';

export interface ReceivedMessage {
  body: string;
  eventId: string | undefined;
  eventType: string | undefined;
}

/**
 * Lê e apaga todas as mensagens disponíveis na fila. Encerra depois de duas leituras vazias.
 * Usado para verificar exatamente o que foi publicado.
 */
export async function drainQueue(sqs: SQSClient, queueName: string): Promise<ReceivedMessage[]> {
  const url = await queueUrl(sqs, queueName);
  const out: ReceivedMessage[] = [];
  let emptyReads = 0;
  while (emptyReads < 2) {
    const res = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: url,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 0,
        VisibilityTimeout: 30,
        MessageAttributeNames: ['All'],
      }),
    );
    const messages = res.Messages ?? [];
    if (messages.length === 0) {
      emptyReads += 1;
      continue;
    }
    emptyReads = 0;
    for (const m of messages) {
      out.push({
        body: m.Body ?? '',
        eventId: m.MessageAttributes?.['eventId']?.StringValue,
        eventType: m.MessageAttributes?.['eventType']?.StringValue,
      });
      if (m.ReceiptHandle) await sqs.send(new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: m.ReceiptHandle }));
    }
  }
  return out;
}
