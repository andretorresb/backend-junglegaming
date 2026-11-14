import type { OutboxEnvelope } from './ports';

/**
 * Envelope de evento gravado na outbox. Forma provisória até a Etapa 7,
 * quando passa a ser gerado pelas classes IntegrationEvent.
 */
export function createEnvelope(params: {
  nextId: () => string;
  correlationId: string;
  occurredAt: Date;
  eventType: string;
  aggregateId: string;
  data: Record<string, unknown>;
}): OutboxEnvelope {
  const eventId = params.nextId();
  return {
    id: eventId,
    aggregateId: params.aggregateId,
    eventType: params.eventType,
    occurredAt: params.occurredAt,
    payload: {
      eventId,
      eventType: params.eventType,
      aggregateId: params.aggregateId,
      correlationId: params.correlationId,
      occurredAt: params.occurredAt.toISOString(),
      version: 1,
      data: params.data,
    },
  };
}
