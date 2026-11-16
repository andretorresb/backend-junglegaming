import { IsolationLevel, type EntityManager } from '@mikro-orm/core';
import { Money, type MoneyProps } from '../../domain/money/money';
import { LedgerDirection } from '../../domain/ledger/ledger-direction';
import { WalletLedgerEntryRecord, WalletRecord } from './entities/records';
import { walletFromRecord, ledgerEntryFromRecord } from './mappers';
import type { Logger, Metrics } from '../../application/ports/observability';
import type { LedgerCursor } from '../../interfaces/http/wallets/cursor';

export interface WalletView {
  id: string;
  playerId: string;
  currency: string;
  balance: MoneyProps;
  version: number;
  updatedAt: Date;
}

export interface LedgerItemView {
  id: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  createdAt: Date;
}

export interface LedgerPage {
  items: LedgerItemView[];
  nextCursor: LedgerCursor | null;
}

export interface ReconciliationResult {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

export const RECONCILIATION_DIVERGENCE_METRIC = 'reconciliation_divergence_total';

/** Consultas de wallet e ledger. Leituras não alteram estado; a reconciliação não corrige nada. */
export class WalletQueries {
  constructor(
    private readonly em: EntityManager,
    private readonly metrics: Metrics,
    private readonly logger: Logger,
  ) {}

  async findWallet(walletId: string): Promise<WalletView | undefined> {
    const record = await this.em.fork().findOne(WalletRecord, { id: walletId });
    if (!record) return undefined;
    const wallet = walletFromRecord(record);
    return {
      id: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.currency,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
      updatedAt: wallet.updatedAt,
    };
  }

  /**
   * Página do ledger ordenada por (created_at, id). O cursor aponta para o último item entregue,
   * então a paginação não repete nem pula linhas que já existiam quando a leitura começou.
   */
  async listLedger(walletId: string, after: LedgerCursor | undefined, limit: number): Promise<LedgerPage | undefined> {
    const em = this.em.fork();
    if (!(await em.findOne(WalletRecord, { id: walletId }, { fields: ['id'] }))) return undefined;

    const where = after
      ? {
          walletId,
          $or: [
            { createdAt: { $gt: after.createdAt } },
            { createdAt: after.createdAt, id: { $gt: after.id } },
          ],
        }
      : { walletId };

    const records = await em.find(WalletLedgerEntryRecord, where, {
      orderBy: { createdAt: 'asc', id: 'asc' },
      limit: limit + 1,
    });

    const hasMore = records.length > limit;
    const pageRecords = hasMore ? records.slice(0, limit) : records;
    const items = pageRecords.map((record) => {
      const entry = ledgerEntryFromRecord(record);
      return {
        id: entry.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        createdAt: entry.createdAt,
      };
    });

    const last = pageRecords[pageRecords.length - 1];
    return {
      items,
      nextCursor: hasMore && last ? { createdAt: last.createdAt, id: last.id } : null,
    };
  }

  /**
   * Compara o saldo armazenado com a soma do ledger, no mesmo snapshot (REPEATABLE READ).
   * Divergência é logada, contada em métrica e sinalizada na resposta. Nada é corrigido.
   */
  async reconcile(walletId: string): Promise<ReconciliationResult | undefined> {
    return this.em.fork().transactional(
      async (tem) => {
        const record = await tem.findOne(WalletRecord, { id: walletId });
        if (!record) return undefined;

        const sums = await tem.getConnection().execute<{ calculated: string; entries: number }[]>(
          `SELECT COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END), 0)::text AS calculated,
                  count(*)::int AS entries
             FROM wallet_ledger_entries
            WHERE wallet_id = ?`,
          [walletId],
          'all',
          tem.getTransactionContext(),
        );
        const row = sums[0] ?? { calculated: '0', entries: 0 };

        const stored = Money.from({ amount: record.balance, currency: record.currency });
        const calculated = Money.from({ amount: row.calculated, currency: record.currency });
        const difference = stored.subtract(calculated);
        const consistent = difference.isZero();

        if (!consistent) {
          this.metrics.increment(RECONCILIATION_DIVERGENCE_METRIC);
          this.logger.error('reconciliation_divergence', {
            walletId,
            storedBalance: stored.toJSON(),
            calculatedBalance: calculated.toJSON(),
          });
        }

        return {
          walletId,
          storedBalance: stored.toJSON(),
          calculatedBalance: calculated.toJSON(),
          difference: difference.toJSON(),
          consistent,
          checkedEntries: Number(row.entries),
        };
      },
      { isolationLevel: IsolationLevel.REPEATABLE_READ },
    );
  }
}
