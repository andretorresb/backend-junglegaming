import { SendMessageBatchCommand, SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { EventPublisher, OutboundEvent, PublishOutcome } from '../../application/ports/event-publisher';
import { EVENTS_QUEUE, queueUrl } from './queues';

/** Limite do SQS por chamada de SendMessageBatch. */
export const SQS_BATCH_LIMIT = 10;

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
    await this.sqs.send(
      new SendMessageCommand({ QueueUrl: await this.resolveUrl(), MessageBody: event.body, MessageAttributes: attributes(event) }),
    );
  }

  /** Um SendMessageBatch por grupo de até 10 eventos. Falha da chamada inteira marca o grupo todo como falho. */
  async publishBatch(events: readonly OutboundEvent[]): Promise<PublishOutcome[]> {
    const url = await this.resolveUrl();
    const outcomes: PublishOutcome[] = [];
    for (let start = 0; start < events.length; start += SQS_BATCH_LIMIT) {
      const chunk = events.slice(start, start + SQS_BATCH_LIMIT);
      try {
        const response = await this.sqs.send(
          new SendMessageBatchCommand({
            QueueUrl: url,
            Entries: chunk.map((event, i) => ({ Id: `e${i}`, MessageBody: event.body, MessageAttributes: attributes(event) })),
          }),
        );
        const failed = new Map((response.Failed ?? []).map((f) => [f.Id, f.Message ?? f.Code ?? 'falha']));
        chunk.forEach((event, i) => {
          const error = failed.get(`e${i}`);
          outcomes.push(error === undefined ? { eventId: event.eventId, ok: true } : { eventId: event.eventId, ok: false, error });
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        for (const event of chunk) outcomes.push({ eventId: event.eventId, ok: false, error: reason });
      }
    }
    return outcomes;
  }

  private async resolveUrl(): Promise<string> {
    this.url ??= await queueUrl(this.sqs, this.queueName);
    return this.url;
  }
}

function attributes(event: OutboundEvent) {
  return {
    eventId: { DataType: 'String', StringValue: event.eventId },
    eventType: { DataType: 'String', StringValue: event.eventType },
  };
}
