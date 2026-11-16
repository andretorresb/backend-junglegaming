import type { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';
import type { Wallet } from '../../domain/wallet/wallet';
import type { WagerTransaction } from '../../domain/wagering/wager-transaction';
import type { IntegrationEvent } from '../../domain/events/integration-event';
import type { InboxMessage } from '../../domain/inbox/inbox-message';

/**
 * Operações disponíveis dentro de uma única transação SQL.
 * Todas compartilham a mesma conexão; nenhuma consulta pode sair dessa transação.
 */
export interface WagerRepositories {
  /** SELECT ... FOR UPDATE na linha da wallet. Serializa operações da mesma wallet. */
  lockWallet(walletId: string): Promise<Wallet | undefined>;
  insertWallet(wallet: Wallet): Promise<void>;
  saveWallet(wallet: Wallet, previousVersion: number): Promise<void>;
  findTransactionByIdempotencyKey(key: string): Promise<WagerTransaction | undefined>;
  findTransactionByProviderExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;
  /** Reversão já processada que aponta para esta transação (REFUND ou ROLLBACK), se existir. */
  findProcessedReversalOf(referenceTransactionId: string): Promise<WagerTransaction | undefined>;
  insertTransaction(tx: WagerTransaction): Promise<void>;
  /**
   * Registra a mensagem recebida na inbox, na mesma transação do efeito.
   * Devolve `false` quando a mensagem já existe (duplicata). Não lança: a transação continua válida.
   */
  insertInbox(message: InboxMessage): Promise<boolean>;
  markInboxProcessed(message: InboxMessage): Promise<void>;
  /** Grava o estado atual de uma transação já existente (status, referência, agendamento). */
  updateTransaction(tx: WagerTransaction): Promise<void>;
  /**
   * Reivindica uma transação PENDING_REFERENCE vencida, com SELECT ... FOR UPDATE SKIP LOCKED.
   * Duas instâncias do worker nunca recebem a mesma linha. `excludedIds` são as que falharam
   * neste ciclo, para não bloquearem o restante do lote.
   */
  claimDuePendingReference(now: Date, excludedIds: readonly string[]): Promise<WagerTransaction | undefined>;
  insertLedgerEntry(entry: WalletLedgerEntry): Promise<void>;
  /** Grava o evento na outbox, na mesma transação da alteração que o originou. */
  enqueueOutbox(event: IntegrationEvent<unknown>): Promise<void>;
}

export interface WagerUnitOfWork {
  /** Executa `work` em uma transação. Erros de infraestrutura são traduzidos aqui. */
  run<T>(work: (repos: WagerRepositories) => Promise<T>): Promise<T>;
}
