/**
 * Códigos de falha estáveis e legíveis por máquina.
 * Cada código é documentado em docs/failure-codes.md.
 * Os valores são estáveis: não renomear sem versionar o contrato com os provedores.
 */
export enum FailureCode {
  InvalidPayload = 'INVALID_PAYLOAD',
  InsufficientBalance = 'INSUFFICIENT_BALANCE',
  NegativeBalanceOnReversal = 'NEGATIVE_BALANCE_ON_REVERSAL',
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  PlayerMismatch = 'PLAYER_MISMATCH',
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  ReferenceAlreadyReversed = 'REFERENCE_ALREADY_REVERSED',
  ReferenceTypeNotAllowed = 'REFERENCE_TYPE_NOT_ALLOWED',
  ReferenceContextMismatch = 'REFERENCE_CONTEXT_MISMATCH',
  AmountMismatchOnReversal = 'AMOUNT_MISMATCH_ON_REVERSAL',
  DuplicateWallet = 'DUPLICATE_WALLET',
  IdempotencyConflict = 'IDEMPOTENCY_CONFLICT',
  InternalOnlyKind = 'INTERNAL_ONLY_KIND',
}
