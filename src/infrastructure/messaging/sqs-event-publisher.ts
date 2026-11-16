import { SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { EventPublisher, OutboundEvent } from '../../application/ports/event-publisher';
import { EVENTS_QUEUE, queueUrl } from './queues';

/**
 * Publica eventos na fila de eventos de integração.
 * A URL da fila é resolvida uma vez por instância. Isso é um cache de desempenho, não de correção.
 */
export class SqsEventPublisher implements EventPublisher {
  private url: string | undefined;

  constructor(
    private readonly sqs: SQSClient,
    private readonly queueName: string = EVENTS_QUEUE,
  ) {}

  async publish(event: OutboundEvent): Promise<void> {
    this.url ??= await queueUrl(this.sqs, this.queueName);
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: this.url,
        MessageBody: event.body,
        MessageAttributes: {
          eventId: { DataType: 'String', StringValue: event.eventId },
          eventType: { DataType: 'String', StringValue: event.eventType },
        },
      }),
    );
  }
}
