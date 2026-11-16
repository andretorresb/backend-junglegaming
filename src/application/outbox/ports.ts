import type { OutboxMessage } from '../../domain/outbox/outbox-message';

export interface OutboxRepositories {
  /** Lote de mensagens vencidas, com FOR UPDATE SKIP LOCKED. Lotes concorrentes são disjuntos. */
  claimDueOutboxBatch(now: Date, limit: number, excludedIds: readonly string[]): Promise<OutboxMessage[]>;
  updateOutbox(message: OutboxMessage): Promise<void>;
  /** Momento de criação da mensagem pendente mais antiga. Usado para medir o lag. */
  oldestPendingOccurredAt(): Promise<Date | undefined>;
}

export interface OutboxUnitOfWork {
  run<T>(work: (repos: OutboxRepositories) => Promise<T>): Promise<T>;
}
