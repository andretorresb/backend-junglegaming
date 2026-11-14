import { FailureCode } from './failure-code';

/**
 * Erro base do domínio.
 * `failureCode` é preenchido quando o erro corresponde a uma rejeição de negócio
 * que o provedor precisa conhecer. Erros de programação não carregam código.
 */
export class DomainError extends Error {
  public readonly failureCode: FailureCode | undefined;

  constructor(message: string, failureCode?: FailureCode | undefined) {
    super(message);
    this.name = new.target.name;
    this.failureCode = failureCode;
  }
}

export class InvalidMoneyError extends DomainError {
  constructor(message: string) {
    super(message, FailureCode.InvalidPayload);
  }
}

export class CurrencyMismatchError extends DomainError {
  constructor(expected: string, actual: string) {
    super(`moeda divergente: esperada ${expected}, recebida ${actual}`, FailureCode.CurrencyMismatch);
  }
}

export class InsufficientBalanceError extends DomainError {
  constructor() {
    super('saldo insuficiente', FailureCode.InsufficientBalance);
  }
}

export class MissingReferenceError extends DomainError {
  constructor(kind: string) {
    super(`${kind} exige referenceExternalTransactionId`, FailureCode.InvalidPayload);
  }
}

export class InvalidReferenceTypeError extends DomainError {
  constructor(kind: string, referenceKind: string) {
    super(`${kind} não pode referenciar ${referenceKind}`, FailureCode.ReferenceTypeNotAllowed);
  }
}

/** Transição de estado inválida: erro de programação, não caminho de negócio. */
export class InvalidTransactionStateError extends DomainError {
  constructor(message: string) {
    super(message);
  }
}

/** Violação da aritmética do ledger: erro de programação ou de persistência corrompida. */
export class LedgerArithmeticError extends DomainError {
  constructor(message: string) {
    super(message);
  }
}

export class InvalidInvariantError extends DomainError {
  constructor(message: string) {
    super(message);
  }
}
