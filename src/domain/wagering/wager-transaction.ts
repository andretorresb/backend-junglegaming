import { FailureCode } from '../failure-code';
import {
  DomainError,
  InvalidInvariantError,
  InvalidMoneyError,
  InvalidReferenceTypeError,
  InvalidTransactionStateError,
  MissingReferenceError,
} from '../errors';
import { LedgerDirection } from '../ledger/ledger-direction';
import { Money, type MoneyProps } from '../money/money';

export enum WagerTransactionKind {
  /** Interno: crédito de abertura da wallet. Não pode ser submetido pela API nem pela fila. */
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

const TERMINAL_STATUSES: ReadonlySet<WagerTransactionStatus> = new Set([
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
]);

/**
 * Transições válidas (documentadas em ARCHITECTURE.md):
 *   PENDING           → PROCESSED | PENDING_REFERENCE | REJECTED | FAILED
 *   PENDING_REFERENCE → PROCESSED | REJECTED | FAILED
 *   PROCESSED | REJECTED | FAILED → (nenhuma: terminais)
 */

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string | undefined;
  createdAt: Date;
}

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string | undefined;
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId?: string | undefined;
  failureCode?: FailureCode | undefined;
  processedAt?: Date | undefined;
  observedBalance?: MoneyProps | undefined;
}

export class WagerTransaction {
  public readonly id: string;
  public readonly providerId: string;
  public readonly externalTransactionId: string;
  public readonly idempotencyKey: string;
  public readonly payloadHash: string;
  public readonly walletId: string;
  public readonly playerId: string;
  public readonly roundId: string;
  public readonly gameId: string;
  public readonly kind: WagerTransactionKind;
  public readonly money: Money;
  /** id no provedor — não o id interno. */
  public readonly referenceExternalTransactionId: string | undefined;
  public readonly createdAt: Date;

  private _status: WagerTransactionStatus;
  private _referenceTransactionId: string | undefined;
  private _failureCode: FailureCode | undefined;
  private _processedAt: Date | undefined;
  private _observedBalance: Money | undefined;

  private constructor(state: {
    id: string;
    providerId: string;
    externalTransactionId: string;
    idempotencyKey: string;
    payloadHash: string;
    walletId: string;
    playerId: string;
    roundId: string;
    gameId: string;
    kind: WagerTransactionKind;
    money: Money;
    referenceExternalTransactionId: string | undefined;
    createdAt: Date;
    status: WagerTransactionStatus;
    referenceTransactionId: string | undefined;
    failureCode: FailureCode | undefined;
    processedAt: Date | undefined;
    observedBalance: Money | undefined;
  }) {
    this.id = state.id;
    this.providerId = state.providerId;
    this.externalTransactionId = state.externalTransactionId;
    this.idempotencyKey = state.idempotencyKey;
    this.payloadHash = state.payloadHash;
    this.walletId = state.walletId;
    this.playerId = state.playerId;
    this.roundId = state.roundId;
    this.gameId = state.gameId;
    this.kind = state.kind;
    this.money = state.money;
    this.referenceExternalTransactionId = state.referenceExternalTransactionId;
    this.createdAt = state.createdAt;
    this._status = state.status;
    this._referenceTransactionId = state.referenceTransactionId;
    this._failureCode = state.failureCode;
    this._processedAt = state.processedAt;
    this._observedBalance = state.observedBalance;
  }

  /** Nasce em PENDING. Valida a exigência de referência por kind. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    for (const field of ['id', 'providerId', 'externalTransactionId', 'idempotencyKey', 'payloadHash', 'walletId', 'playerId', 'roundId', 'gameId'] as const) {
      assertText(props[field], field);
    }
    if (!props.money.isPositive()) {
      throw new InvalidMoneyError('valor da transação deve ser positivo');
    }

    const requiresReference = requiresReferenceFor(props.kind);
    const reference = props.referenceExternalTransactionId;
    if (requiresReference && (reference === undefined || reference.trim() === '')) {
      throw new MissingReferenceError(props.kind);
    }
    if (!requiresReference && reference !== undefined) {
      throw new InvalidMoneyError(`${props.kind} não aceita referenceExternalTransactionId`);
    }

    return new WagerTransaction({
      ...props,
      referenceExternalTransactionId: reference,
      referenceTransactionId: undefined,
      failureCode: undefined,
      processedAt: undefined,
      observedBalance: undefined,
      status: WagerTransactionStatus.Pending,
    });
  }

  /** Reconstrução a partir da persistência. Não revalida transições. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction({
      id: state.id,
      providerId: state.providerId,
      externalTransactionId: state.externalTransactionId,
      idempotencyKey: state.idempotencyKey,
      payloadHash: state.payloadHash,
      walletId: state.walletId,
      playerId: state.playerId,
      roundId: state.roundId,
      gameId: state.gameId,
      kind: state.kind,
      money: Money.from(state.money),
      referenceExternalTransactionId: state.referenceExternalTransactionId,
      createdAt: state.createdAt,
      status: state.status,
      referenceTransactionId: state.referenceTransactionId,
      failureCode: state.failureCode,
      processedAt: state.processedAt,
      observedBalance: state.observedBalance === undefined ? undefined : Money.from(state.observedBalance),
    });
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  /** Saldo da wallet no momento da decisão. Usado para replay idempotente. */
  get observedBalance(): Money | undefined {
    return this._observedBalance;
  }

  // ---- transições ----------------------------------------------------------

  /**
   * `referenceTransactionId` é o id INTERNO da transação referenciada.
   * Obrigatório para REFUND/ROLLBACK; proibido para os demais kinds.
   */
  markProcessed(referenceTransactionId: string | undefined, at: Date, observedBalance?: Money): void {
    this.assertTransitionFrom([WagerTransactionStatus.Pending, WagerTransactionStatus.PendingReference], 'PROCESSED');
    const requiresReference = this.requiresReference();
    if (requiresReference && (referenceTransactionId === undefined || referenceTransactionId === '')) {
      throw new InvalidTransactionStateError(`${this.kind} processado exige referenceTransactionId`);
    }
    if (!requiresReference && referenceTransactionId !== undefined) {
      throw new InvalidTransactionStateError(`${this.kind} não referencia outra transação`);
    }
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
    this._observedBalance = observedBalance;
  }

  markPendingReference(): void {
    this.assertTransitionFrom([WagerTransactionStatus.Pending], 'PENDING_REFERENCE');
    if (!this.requiresReference()) {
      throw new InvalidTransactionStateError(`${this.kind} não pode aguardar referência`);
    }
    this._status = WagerTransactionStatus.PendingReference;
  }

  /** Rejeição por regra de negócio: resultado persistido, não exceção. */
  reject(code: FailureCode, observedBalance?: Money): void {
    this.assertTransitionFrom([WagerTransactionStatus.Pending, WagerTransactionStatus.PendingReference], 'REJECTED');
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._observedBalance = observedBalance;
  }

  /** Erro permanente de infraestrutura: terminal e auditável. */
  fail(code: FailureCode): void {
    this.assertTransitionFrom([WagerTransactionStatus.Pending, WagerTransactionStatus.PendingReference], 'FAILED');
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
  }

  // ---- consultas de domínio ----------------------------------------------

  isTerminal(): boolean {
    return TERMINAL_STATUSES.has(this._status);
  }

  /** LOSS registra o resultado sem mover saldo. */
  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return requiresReferenceFor(this.kind);
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /**
   * Direção do lançamento no ledger para este kind.
   *
   * Validação de tipo da referência acontece AQUI (fonte única da regra):
   *   - REFUND referencia apenas BET;
   *   - ROLLBACK referencia BET, WIN ou REFUND, e inverte a direção da referência.
   * Validação de contexto (provider, player, wallet, moeda, rodada), status e valor
   * da referência é responsabilidade da Etapa 4, na camada de aplicação.
   */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Refund: {
        const ref = requireReference(this.kind, reference);
        if (ref.kind !== WagerTransactionKind.Bet) {
          throw new InvalidReferenceTypeError(this.kind, ref.kind);
        }
        return LedgerDirection.Credit;
      }
      case WagerTransactionKind.Rollback: {
        const ref = requireReference(this.kind, reference);
        switch (ref.kind) {
          case WagerTransactionKind.Bet:
            return LedgerDirection.Credit; // desfaz um débito
          case WagerTransactionKind.Win:
          case WagerTransactionKind.Refund:
            return LedgerDirection.Debit; // desfaz um crédito
          default:
            throw new InvalidReferenceTypeError(this.kind, ref.kind);
        }
      }
      case WagerTransactionKind.Loss:
        throw new DomainError('LOSS não gera lançamento no ledger');
    }
  }

  private assertTransitionFrom(allowed: WagerTransactionStatus[], target: string): void {
    if (!allowed.includes(this._status)) {
      throw new InvalidTransactionStateError(
        `transição inválida: ${this._status} → ${target} (transação ${this.id})`,
      );
    }
  }
}

function requiresReferenceFor(kind: WagerTransactionKind): boolean {
  return kind === WagerTransactionKind.Refund || kind === WagerTransactionKind.Rollback;
}

function requireReference(kind: WagerTransactionKind, reference: WagerTransaction | undefined): WagerTransaction {
  if (reference === undefined) {
    throw new InvalidInvariantError(`${kind} exige a transação referenciada para determinar o lançamento`);
  }
  return reference;
}

function assertText(value: string, field: string): void {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidInvariantError(`${field} é obrigatório`);
  }
}
