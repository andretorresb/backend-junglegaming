import { FailureCode } from '../../domain/failure-code';

/** Erros da camada de aplicação. Cada um tem um mapeamento HTTP explícito na interface. */
export class ApplicationError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly failureCode?: FailureCode | undefined,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class WalletNotFoundError extends ApplicationError {
  constructor(walletId: string) {
    super(`wallet ${walletId} não encontrada`, 'WALLET_NOT_FOUND');
  }
}

/** Mesma chave com payload diferente, ou mesma transação do provedor com outra chave. */
export class IdempotencyConflictError extends ApplicationError {
  constructor(detail: string) {
    super(`conflito de idempotência: ${detail}`, 'IDEMPOTENCY_CONFLICT', FailureCode.IdempotencyConflict);
  }
}

/** `OPENING` é interno: não pode ser submetido pela API nem pela fila. */
export class InternalOnlyKindError extends ApplicationError {
  constructor() {
    super('kind OPENING é interno e não pode ser submetido', 'INTERNAL_ONLY_KIND', FailureCode.InternalOnlyKind);
  }
}

/** Kinds ainda não implementados nesta etapa (REFUND e ROLLBACK chegam na Etapa 4). */
export class KindNotSupportedYetError extends ApplicationError {
  constructor(kind: string) {
    super(`kind ${kind} ainda não é suportado`, 'KIND_NOT_SUPPORTED_YET');
  }
}

/**
 * Rejeição de validação de contexto (moeda ou jogador divergentes).
 * A transação NÃO é persistida: a FK (wallet_id, currency) do banco impediria, e a
 * rejeição é determinística para o mesmo payload.
 */
export class RejectedBeforePersistenceError extends ApplicationError {
  constructor(failureCode: FailureCode, message: string) {
    super(message, 'REJECTED', failureCode);
  }
}

/** Falha transitória de infraestrutura (timeout de lock, deadlock, conexão). Pode ser repetida. */
export class TransientInfrastructureError extends ApplicationError {
  constructor(message: string) {
    super(message, 'TRANSIENT_UNAVAILABLE');
  }
}

/**
 * Violação de unicidade no banco (SQLSTATE 23505) traduzida pela unidade de trabalho.
 * Causada por uma requisição concorrente com a mesma chave; o caso de uso tenta de novo uma vez.
 */
export class UniqueViolationError extends ApplicationError {
  constructor(constraint: string) {
    super(`violação de unicidade: ${constraint}`, 'UNIQUE_VIOLATION');
  }
}
