/** Evento serializado pronto para publicação. */
export interface OutboundEvent {
  eventId: string;
  eventType: string;
  /** JSON do envelope. Consumidores deduplicam por `eventId`. */
  body: string;
}

/** Resultado da publicação de um evento dentro de um lote. */
export interface PublishOutcome {
  eventId: string;
  ok: boolean;
  error?: string | undefined;
}

/**
 * Porta de publicação. Garantia: at-least-once. Uma mesma mensagem pode chegar mais de uma vez
 * (ex.: crash entre a publicação e a marcação na outbox). Por isso o `eventId` é estável.
 */
export interface EventPublisher {
  publish(event: OutboundEvent): Promise<void>;
  /**
   * Publica um lote e informa o resultado de cada evento. Opcional: sem ela, o worker publica um
   * a um. Um lote pode ter sucesso parcial; os que falharem voltam para retry individualmente.
   */
  publishBatch?(events: readonly OutboundEvent[]): Promise<PublishOutcome[]>;
}
