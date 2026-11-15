import { FailureCode } from '../../domain/failure-code';
import { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';
import type { Wallet } from '../../domain/wallet/wallet';
import {
  WagerTransactionStatus,
  type WagerTransaction,
} from '../../domain/wagering/wager-transaction';
import {
  isReferenceWaitExhausted,
  nextAttemptDelayMs,
  type ReferenceRetryPolicy,
} from '../../domain/wagering/reference-retry-policy';
import { InvalidInvariantError } from '../../domain/errors';
import type { Clock } from '../ports/clock';
import { applyReversal, isWaitingForReference } from './apply-reversal';
import { createEnvelope } from './envelope';
import type { WagerRepositories, WagerUnitOfWork } from './ports';

export interface PendingReferenceWorkerOptions {
  retryPolicy: ReferenceRetryPolicy;
  random: () => number;
}

export interface PendingReferenceCycleStats {
  claimed: number;
  resolved: number;
  rejected: number;
  rescheduled: number;
  expired: number;
  failed: number;
}

export type WorkerLogEntry = Record<string, unknown>;

type Outcome = 'resolved' | 'rejected' | 'rescheduled' | 'expired';

/**
 * Reprocessa transações PENDING_REFERENCE (seção 7.1 do enunciado).
 *
 * Cada transação é tratada em uma transação SQL própria:
 *   1. reivindica a próxima transação vencida (FOR UPDATE SKIP LOCKED): duas instâncias
 *      nunca pegam a mesma linha;
 *   2. trava a wallet, como o caminho HTTP/fila;
 *   3. se a referência apareceu, aplica a mesma regra de reversão do caso de uso;
 *   4. se não apareceu, reagenda com backoff, ou expira por tentativas ou TTL.
 *
 * Uma falha em um item (ex.: timeout de lock) faz rollback só dele. O item é excluído do
 * restante do ciclo e volta a ser reivindicado no próximo.
 */
export class PendingReferenceWorker {
  constructor(
    private readonly uow: WagerUnitOfWork,
    private readonly clock: Clock,
    private readonly nextId: () => string,
    private readonly options: PendingReferenceWorkerOptions,
    private readonly log: (entry: WorkerLogEntry) => void = () => undefined,
  ) {}

  /** Processa até `batchSize` transações vencidas neste ciclo. */
  async runCycle(batchSize: number): Promise<PendingReferenceCycleStats> {
    const stats: PendingReferenceCycleStats = {
      claimed: 0,
      resolved: 0,
      rejected: 0,
      rescheduled: 0,
      expired: 0,
      failed: 0,
    };
    const excluded: string[] = [];

    for (let i = 0; i < batchSize; i++) {
      const claim: { id?: string } = {};
      try {
        const outcome = await this.uow.run((repos) =>
          this.processOne(repos, excluded, (id) => {
            claim.id = id;
          }),
        );
        if (outcome === undefined) break;
        stats.claimed += 1;
        stats[outcome] += 1;
      } catch (error) {
        stats.failed += 1;
        if (claim.id !== undefined) excluded.push(claim.id);
        this.log({
          level: 'error',
          event: 'pending_reference_failed',
          transactionId: claim.id ?? null,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return stats;
  }

  private async processOne(
    repos: WagerRepositories,
    excluded: readonly string[],
    onClaim: (id: string) => void,
  ): Promise<Outcome | undefined> {
    const now = this.clock.now();
    const pending = await repos.claimDuePendingReference(now, excluded);
    if (!pending) return undefined;
    onClaim(pending.id);

    if (pending.referenceExternalTransactionId === undefined) {
      throw new InvalidInvariantError(`transação pendente ${pending.id} sem referência`);
    }

    const wallet = await repos.lockWallet(pending.walletId);
    if (!wallet) {
      throw new InvalidInvariantError(`wallet ${pending.walletId} da transação pendente não existe`);
    }

    const reference = await repos.findTransactionByProviderExternalId(
      pending.providerId,
      pending.referenceExternalTransactionId,
    );

    if (reference === undefined || isWaitingForReference(reference)) {
      return this.waitOrExpire(repos, pending, wallet, now);
    }

    const alreadyReversed = (await repos.findProcessedReversalOf(reference.id)) !== undefined;
    const movement = applyReversal(pending, wallet, now, { reference, alreadyReversed });
    await repos.updateTransaction(pending);

    if (movement) {
      await repos.insertLedgerEntry(
        WalletLedgerEntry.create({
          id: this.nextId(),
          walletId: wallet.id,
          transactionId: pending.id,
          direction: movement.direction,
          money: movement.money,
          balanceBefore: movement.balanceBefore,
          balanceAfter: movement.balanceAfter,
          createdAt: now,
        }),
      );
      await repos.saveWallet(wallet, movement.walletVersion - 1);
      await repos.enqueueOutbox(
        this.envelope(pending, now, 'WalletBalanceChanged', wallet.id, {
          walletId: wallet.id,
          transactionId: pending.id,
          direction: movement.direction,
          money: movement.money.toJSON(),
          balanceBefore: movement.balanceBefore.toJSON(),
          balanceAfter: movement.balanceAfter.toJSON(),
          walletVersion: movement.walletVersion,
        }),
      );
    }

    await this.publishResult(repos, pending, wallet, now);
    const outcome: Outcome = pending.status === WagerTransactionStatus.Processed ? 'resolved' : 'rejected';
    this.logAttempt(pending, outcome);
    return outcome;
  }

  /** Referência ausente: conta a tentativa e reagenda, ou expira se o limite foi atingido. */
  private async waitOrExpire(
    repos: WagerRepositories,
    pending: WagerTransaction,
    wallet: Wallet,
    now: Date,
  ): Promise<Outcome> {
    pending.incrementReferenceAttempts();

    if (isReferenceWaitExhausted(pending.referenceAttempts, pending.createdAt, now, this.options.retryPolicy)) {
      pending.reject(FailureCode.ReferenceNotFound, wallet.balance);
      await repos.updateTransaction(pending);
      await this.publishResult(repos, pending, wallet, now);
      this.logAttempt(pending, 'expired');
      return 'expired';
    }

    const delay = nextAttemptDelayMs(pending.referenceAttempts, this.options.retryPolicy, this.options.random());
    pending.rescheduleReference(new Date(now.getTime() + delay));
    await repos.updateTransaction(pending);
    this.logAttempt(pending, 'rescheduled');
    return 'rescheduled';
  }

  private async publishResult(
    repos: WagerRepositories,
    tx: WagerTransaction,
    wallet: Wallet,
    now: Date,
  ): Promise<void> {
    const eventType =
      tx.status === WagerTransactionStatus.Rejected ? 'WagerTransactionRejected' : 'WagerTransactionProcessed';
    await repos.enqueueOutbox(
      this.envelope(tx, now, eventType, tx.id, {
        transactionId: tx.id,
        providerId: tx.providerId,
        externalTransactionId: tx.externalTransactionId,
        walletId: tx.walletId,
        kind: tx.kind,
        status: tx.status,
        failureCode: tx.failureCode ?? null,
        balance: wallet.balance.toJSON(),
      }),
    );
  }

  /** Registro estruturado por tentativa. Sem valores monetários nem payloads. */
  private logAttempt(tx: WagerTransaction, outcome: Outcome): void {
    this.log({
      level: 'info',
      event: 'pending_reference_attempt',
      transactionId: tx.id,
      walletId: tx.walletId,
      attempts: tx.referenceAttempts,
      outcome,
      failureCode: tx.failureCode ?? null,
    });
  }

  private envelope(
    tx: WagerTransaction,
    occurredAt: Date,
    eventType: string,
    aggregateId: string,
    data: Record<string, unknown>,
  ) {
    return createEnvelope({
      nextId: this.nextId,
      correlationId: `pending:${tx.id}`,
      occurredAt,
      eventType,
      aggregateId,
      data,
    });
  }
}
