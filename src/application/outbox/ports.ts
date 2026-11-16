import type { OutboxMessage } from '../../domain/outbox/outbox-message';

export interface OutboxRepositories {
  /**
   * Reivindica a próxima mensagem vencida e não publicada, com FOR UPDATE SKIP LOCKED.
   * `excludedIds` são as que falharam neste ciclo.
   */
  claimDueOutbox(now: Date, excludedIds: readonly string[]): Promise<OutboxMessage | undefined>;
  updateOutbox(message: OutboxMessage): Promise<void>;
  /** Momento de criação da mensagem pendente mais antiga. Usado para medir o lag. */
  oldestPendingOccurredAt(): Promise<Date | undefined>;
}

export interface OutboxUnitOfWork {
  run<T>(work: (repos: OutboxRepositories) => Promise<T>): Promise<T>;
}
