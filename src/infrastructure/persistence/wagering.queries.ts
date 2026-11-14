import type { EntityManager } from '@mikro-orm/core';
import { wagerTransactionFromRecord } from './mappers';
import { WagerTransactionRecord } from './entities/records';
import type { FailureCode } from '../../domain/failure-code';
import type { MoneyProps } from '../../domain/money/money';

export interface WagerTransactionView {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  referenceExternalTransactionId: string | undefined;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  status: string;
  money: MoneyProps;
  failureCode: FailureCode | undefined;
  processedAt: Date | undefined;
  createdAt: Date;
}

/** Leituras de transações. Somente leitura: nunca altera estado. */
export class WagerTransactionQueries {
  constructor(private readonly em: EntityManager) {}

  async findById(transactionId: string): Promise<WagerTransactionView | undefined> {
    const record = await this.em.fork().findOne(WagerTransactionRecord, { id: transactionId });
    return record ? toView(record) : undefined;
  }

  async findByProviderExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransactionView | undefined> {
    const record = await this.em.fork().findOne(WagerTransactionRecord, { providerId, externalTransactionId });
    return record ? toView(record) : undefined;
  }
}

function toView(record: WagerTransactionRecord): WagerTransactionView {
  const tx = wagerTransactionFromRecord(record);
  return {
    transactionId: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    referenceExternalTransactionId: tx.referenceExternalTransactionId,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    status: tx.status,
    money: tx.money.toJSON(),
    failureCode: tx.failureCode,
    processedAt: tx.processedAt,
    createdAt: tx.createdAt,
  };
}
