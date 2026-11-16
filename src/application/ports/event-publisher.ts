/** Evento serializado pronto para publicação. */
export interface OutboundEvent {
  eventId: string;
  eventType: string;
  /** JSON do envelope. Consumidores deduplicam por `eventId`. */
  body: string;
}

/**
 * Porta de publicação. Garantia: at-least-once. Uma mesma mensagem pode chegar mais de uma vez
 * (ex.: crash entre a publicação e a marcação na outbox). Por isso o `eventId` é estável.
 */
export interface EventPublisher {
  publish(event: OutboundEvent): Promise<void>;
}
