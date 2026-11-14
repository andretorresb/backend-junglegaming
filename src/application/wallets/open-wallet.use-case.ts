import { computePayloadHash } from '../../domain/wagering/payload-hash';
import { Money, type MoneyProps } from '../../domain/money/money';
import { Wallet } from '../../domain/wallet/wallet';
import { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';
import { LedgerDirection } from '../../domain/ledger/ledger-direction';
import { WagerTransaction, WagerTransactionKind } from '../../domain/wagering/wager-transaction';
import type { Clock } from '../ports/clock';
import { createEnvelope } from '../wagering/envelope';
import { DuplicateWalletError, UniqueViolationError } from '../wagering/errors';
import type { WagerUnitOfWork } from '../wagering/ports';

const WALLET_PLAYER_CURRENCY_CONSTRAINT = 'wallets_player_currency_uq';

export interface OpenWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
  correlationId: string;
}

export interface OpenWalletResult {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

/**
 * Cria a wallet. Com saldo inicial positivo, grava também a transação interna OPENING
 * e o lançamento CREDIT correspondente, na mesma transação SQL (seção 9 do enunciado).
 *
 * Sem idempotency key: a unicidade (playerId, currency) no banco é a proteção contra duplicidade.
 */
export class OpenWallet {
  constructor(
    private readonly uow: WagerUnitOfWork,
    private readonly clock: Clock,
    private readonly nextId: () => string,
  ) {}

  async execute(command: OpenWalletCommand): Promise<OpenWalletResult> {
    const initial = Money.fromInput(command.initialBalance);
    const at = this.clock.now();
    const walletId = this.nextId();

    try {
      return await this.uow.run(async (repos) => {
        const wallet = Wallet.open({ id: walletId, playerId: command.playerId, initialBalance: initial, at });
        await repos.insertWallet(wallet);

        if (initial.isPositive()) {
          const opening = WagerTransaction.create({
            id: this.nextId(),
            providerId: 'internal',
            externalTransactionId: `opening:${walletId}`,
            idempotencyKey: `internal:opening:${walletId}`,
            payloadHash: computePayloadHash({
              providerId: 'internal',
              externalTransactionId: `opening:${walletId}`,
              playerId: command.playerId,
              walletId,
              roundId: 'opening',
              gameId: 'opening',
              kind: WagerTransactionKind.Opening,
              money: initial.toJSON(),
              referenceExternalTransactionId: null,
            }),
            walletId,
            playerId: command.playerId,
            roundId: 'opening',
            gameId: 'opening',
            kind: WagerTransactionKind.Opening,
            money: initial,
            createdAt: at,
          });
          opening.markProcessed(undefined, at, wallet.balance);
          await repos.insertTransaction(opening);

          const entry = WalletLedgerEntry.create({
            id: this.nextId(),
            walletId,
            transactionId: opening.id,
            direction: LedgerDirection.Credit,
            money: initial,
            balanceBefore: Money.zero(initial.currency),
            balanceAfter: wallet.balance,
            createdAt: at,
          });
          await repos.insertLedgerEntry(entry);

          await repos.enqueueOutbox(
            createEnvelope({
              nextId: this.nextId,
              correlationId: command.correlationId,
              occurredAt: at,
              eventType: 'WalletBalanceChanged',
              aggregateId: walletId,
              data: {
                walletId,
                transactionId: opening.id,
                direction: LedgerDirection.Credit,
                money: initial.toJSON(),
                balanceBefore: Money.zero(initial.currency).toJSON(),
                balanceAfter: wallet.balance.toJSON(),
                walletVersion: wallet.version,
              },
            }),
          );
        }

        return {
          id: wallet.id,
          playerId: wallet.playerId,
          balance: wallet.balance.toJSON(),
          version: wallet.version,
        };
      });
    } catch (error) {
      if (error instanceof UniqueViolationError && error.constraint === WALLET_PLAYER_CURRENCY_CONSTRAINT) {
        throw new DuplicateWalletError(command.playerId, initial.currency);
      }
      throw error;
    }
  }
}
