import { EntityManager, LockMode } from '@mikro-orm/core';
import type { OutboxRepositories, OutboxUnitOfWork } from '../../application/outbox/ports';
import type { OutboxMessage } from '../../domain/outbox/outbox-message';
import { OutboxMessageRecord } from './entities/records';
import { outboxFromRecord, outboxToRecord } from './mappers';
import { translateInfrastructureError } from './wagering.persistence';

export class MikroOrmOutboxRepositories implements OutboxRepositories {
  constructor(private readonly em: EntityManager) {}

  async claimDueOutbox(now: Date, excludedIds: readonly string[]): Promise<OutboxMessage | undefined> {
    const record = await this.em.findOne(
      OutboxMessageRecord,
      {
        publishedAt: null,
        $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }],
        ...(excludedIds.length > 0 ? { id: { $nin: [...excludedIds] } } : {}),
      },
      {
        orderBy: { occurredAt: 'asc', id: 'asc' },
        lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE,
      },
    );
    return record ? outboxFromRecord(record) : undefined;
  }

  async updateOutbox(message: OutboxMessage): Promise<void> {
    const r = outboxToRecord(message);
    await this.em.nativeUpdate(
      OutboxMessageRecord,
      { id: message.id },
      { attempts: r.attempts, nextAttemptAt: r.nextAttemptAt, publishedAt: r.publishedAt },
    );
  }

  async oldestPendingOccurredAt(): Promise<Date | undefined> {
    const record = await this.em.findOne(OutboxMessageRecord, { publishedAt: null }, { orderBy: { occurredAt: 'asc', id: 'asc' } });
    return record?.occurredAt;
  }
}

export class MikroOrmOutboxUnitOfWork implements OutboxUnitOfWork {
  constructor(private readonly em: EntityManager) {}

  async run<T>(work: (repos: OutboxRepositories) => Promise<T>): Promise<T> {
    try {
      return await this.em.fork().transactional((tem) => work(new MikroOrmOutboxRepositories(tem)));
    } catch (error) {
      throw translateInfrastructureError(error);
    }
  }
}
