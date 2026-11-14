import { computePayloadHash } from '../../domain/wagering/payload-hash';
import { FailureCode } from '../../domain/failure-code';
import { InsufficientBalanceError, InvalidInvariantError } from '../../domain/errors';
import { LedgerDirection } from '../../domain/ledger/ledger-direction';
import { Money, type MoneyProps } from '../../domain/money/money';
import { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';
import type { Wallet, WalletMovement } from '../../domain/wallet/wallet';
import { validateReversalReference } from '../../domain/wagering/reversal-rules';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/wagering/wager-transaction';
import type { Clock } from '../ports/clock';
import {
  IdempotencyConflictError,
  InternalOnlyKindError,
  RejectedBeforePersistenceError,
  UniqueViolationError,
  WalletNotFoundError,
} from './errors';
import type { OutboxEnvelope, WagerRepositories, WagerUnitOfWork } from './ports';
import { createEnvelope } from './envelope';

export interface ProcessWagerTransactionCommand {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  /** Obrigatório para REFUND e ROLLBACK: id externo da transação revertida. */
  referenceExternalTransactionId?: string | undefined;
  correlationId: string;
}

export interface ProcessWagerTransactionResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: MoneyProps;
  failureCode: FailureCode | undefined;
  idempotentReplay: boolean;
}

/**
 * Caso de uso único para HTTP e fila (Etapa 8 reutiliza esta classe).
 *
 * Ordem das operações dentro da transação (a ordem é parte da correção):
 *   1. trava a wallet (SELECT ... FOR UPDATE);
 *   2. procura a Idempotency-Key: replay ou conflito;
 *   3. valida jogador e moeda contra a wallet;
 *   4. resolve a referência (REFUND/ROLLBACK) e aplica a regra;
 *   5. persiste transação, lançamento, saldo e outbox juntos.
 *
 * Travar antes de consultar a idempotência faz requisições idênticas se serializarem:
 * a segunda só lê a transação depois que a primeira comitou.
 */
export class ProcessWagerTransaction {
  constructor(
    private readonly uow: WagerUnitOfWork,
    private readonly clock: Clock,
    private readonly nextId: () => string,
  ) {}

  async execute(command: ProcessWagerTransactionCommand): Promise<ProcessWagerTransactionResult> {
    if (command.kind === WagerTransactionKind.Opening) throw new InternalOnlyKindError();
    const money = Money.fromInput(command.money);
    const payloadHash = computePayloadHash({
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      playerId: command.playerId,
      walletId: command.walletId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind,
      money: money.toJSON(),
      referenceExternalTransactionId: command.referenceExternalTransactionId ?? null,
    });

    try {
      return await this.attempt(command, money, payloadHash);
    } catch (error) {
      // Corrida rara entre chaves diferentes com o mesmo external id (ou dupla reversão concorrente):
      // a segunda tentativa enxerga a linha já comitada e cai em replay, conflito ou rejeição.
      if (error instanceof UniqueViolationError) {
        return this.attempt(command, money, payloadHash);
      }
      throw error;
    }
  }

  private attempt(
    command: ProcessWagerTransactionCommand,
    money: Money,
    payloadHash: string,
  ): Promise<ProcessWagerTransactionResult> {
    return this.uow.run((repos) => this.apply(repos, command, money, payloadHash));
  }

  private async apply(
    repos: WagerRepositories,
    command: ProcessWagerTransactionCommand,
    money: Money,
    payloadHash: string,
  ): Promise<ProcessWagerTransactionResult> {
    const wallet = await repos.lockWallet(command.walletId);
    if (!wallet) {
      throw new WalletNotFoundError(command.walletId);
    }

    const sameKey = await repos.findTransactionByIdempotencyKey(command.idempotencyKey);
    if (sameKey) {
      if (sameKey.matchesPayload(payloadHash)) {
        return replayResult(sameKey, wallet);
      }
      throw new IdempotencyConflictError('mesma Idempotency-Key com payload diferente');
    }

    const sameExternal = await repos.findTransactionByProviderExternalId(command.providerId, command.externalTransactionId);
    if (sameExternal) {
      throw new IdempotencyConflictError('transação do provedor já registrada com outra Idempotency-Key');
    }

    if (command.playerId !== wallet.playerId) {
      throw new RejectedBeforePersistenceError(FailureCode.PlayerMismatch, 'playerId não pertence à wallet');
    }
    if (money.currency !== wallet.currency) {
      throw new RejectedBeforePersistenceError(
        FailureCode.CurrencyMismatch,
        `moeda ${money.currency} diferente da wallet (${wallet.currency})`,
      );
    }

    // Reversões: resolve a referência e verifica se ela já foi revertida.
    const reference = isReversal(command.kind) && command.referenceExternalTransactionId
      ? await repos.findTransactionByProviderExternalId(command.providerId, command.referenceExternalTransactionId)
      : undefined;
    const alreadyReversed = reference ? (await repos.findProcessedReversalOf(reference.id)) !== undefined : false;

    const now = this.clock.now();
    const tx = WagerTransaction.create({
      id: this.nextId(),
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      idempotencyKey: command.idempotencyKey,
      payloadHash,
      walletId: wallet.id,
      playerId: command.playerId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind,
      money,
      referenceExternalTransactionId: command.referenceExternalTransactionId,
      referenceTransactionId: reference?.id,
      createdAt: now,
    });

    const movement = applyRule(tx, wallet, now, { reference, alreadyReversed });

    await repos.insertTransaction(tx);

    if (movement) {
      const entry = WalletLedgerEntry.create({
        id: this.nextId(),
        walletId: wallet.id,
        transactionId: tx.id,
        direction: movement.direction,
        money: movement.money,
        balanceBefore: movement.balanceBefore,
        balanceAfter: movement.balanceAfter,
        createdAt: now,
      });
      await repos.insertLedgerEntry(entry);
      await repos.saveWallet(wallet, movement.walletVersion - 1);
      await repos.enqueueOutbox(
        this.envelope(command, now, 'WalletBalanceChanged', wallet.id, {
          walletId: wallet.id,
          transactionId: tx.id,
          direction: movement.direction,
          money: movement.money.toJSON(),
          balanceBefore: movement.balanceBefore.toJSON(),
          balanceAfter: movement.balanceAfter.toJSON(),
          walletVersion: movement.walletVersion,
        }),
      );
    }

    const eventType = tx.status === WagerTransactionStatus.Rejected ? 'WagerTransactionRejected' : 'WagerTransactionProcessed';
    await repos.enqueueOutbox(
      this.envelope(command, now, eventType, tx.id, {
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

    return {
      transactionId: tx.id,
      status: tx.status,
      balance: wallet.balance.toJSON(),
      failureCode: tx.failureCode,
      idempotentReplay: false,
    };
  }

  private envelope(
    command: ProcessWagerTransactionCommand,
    occurredAt: Date,
    eventType: string,
    aggregateId: string,
    data: Record<string, unknown>,
  ): OutboxEnvelope {
    return createEnvelope({ nextId: this.nextId, correlationId: command.correlationId, occurredAt, eventType, aggregateId, data });
  }
}

interface ReversalContext {
  reference: WagerTransaction | undefined;
  alreadyReversed: boolean;
}

/**
 * Aplica a regra do kind à wallet e ao status da transação.
 * Retorna a movimentação, ou `undefined` quando não há efeito no saldo (LOSS ou rejeição).
 */
function applyRule(
  tx: WagerTransaction,
  wallet: Wallet,
  now: Date,
  reversal: ReversalContext,
): WalletMovement | undefined {
  switch (tx.kind) {
    case WagerTransactionKind.Bet:
      try {
        const movement = wallet.debit(tx.money, now);
        tx.markProcessed(undefined, now, wallet.balance);
        return movement;
      } catch (error) {
        if (!(error instanceof InsufficientBalanceError)) throw error;
        tx.reject(FailureCode.InsufficientBalance, wallet.balance);
        return undefined;
      }

    case WagerTransactionKind.Win: {
      const movement = wallet.credit(tx.money, now);
      tx.markProcessed(undefined, now, wallet.balance);
      return movement;
    }

    case WagerTransactionKind.Loss:
      tx.markProcessed(undefined, now, wallet.balance);
      return undefined;

    case WagerTransactionKind.Refund:
    case WagerTransactionKind.Rollback:
      return applyReversal(tx, wallet, now, reversal);

    default:
      throw new InvalidInvariantError(`kind ${tx.kind} não tem regra de aplicação`);
  }
}

function applyReversal(
  tx: WagerTransaction,
  wallet: Wallet,
  now: Date,
  { reference, alreadyReversed }: ReversalContext,
): WalletMovement | undefined {
  const rejection = validateReversalReference(tx, reference, alreadyReversed);
  if (rejection !== undefined || reference === undefined) {
    tx.reject(rejection ?? FailureCode.ReferenceNotFound, wallet.balance);
    return undefined;
  }

  const direction = tx.ledgerDirectionFor(reference);
  if (direction === LedgerDirection.Credit) {
    const movement = wallet.credit(tx.money, now);
    tx.markProcessed(reference.id, now, wallet.balance);
    return movement;
  }

  // Reversão que debitaria: se o saldo não cobre, é rejeitada com código próprio (regra 9).
  try {
    const movement = wallet.debit(tx.money, now);
    tx.markProcessed(reference.id, now, wallet.balance);
    return movement;
  } catch (error) {
    if (!(error instanceof InsufficientBalanceError)) throw error;
    tx.reject(FailureCode.NegativeBalanceOnReversal, wallet.balance);
    return undefined;
  }
}

function isReversal(kind: WagerTransactionKind): boolean {
  return kind === WagerTransactionKind.Refund || kind === WagerTransactionKind.Rollback;
}

function replayResult(stored: WagerTransaction, wallet: Wallet): ProcessWagerTransactionResult {
  return {
    transactionId: stored.id,
    status: stored.status,
    balance: (stored.observedBalance ?? wallet.balance).toJSON(),
    failureCode: stored.failureCode,
    idempotentReplay: true,
  };
}
