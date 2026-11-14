# Spec — Etapa 1: Domínio puro

## Objetivo
Modelo de domínio com invariantes encapsuladas, sem dependência de NestJS, ORM ou IO.

## Escopo
Diretório: `src/domain/` (sem imports de `@nestjs/*`, `@mikro-orm/*`, `pg`, `@aws-sdk/*`).

### `Money` (`src/domain/money/money.ts`)
- Biblioteca decimal (`decimal.js`). Nunca `number` para valor monetário.
- `static from({ amount, currency })`: `amount` string, escala exata de 2 casas, `currency` ISO-4217 (3 letras maiúsculas).
- `static zero(currency)`.
- `add`, `subtract`, `negate` → nova instância.
- `isZero`, `isPositive`, `isNegative`, `isLessThan`, `equals`.
- `toJSON()` → `{ amount: "25.00", currency: "BRL" }`; `toString()`.
- Erro de domínio `CurrencyMismatchError` em operações entre moedas diferentes.
- Rejeitar com `InvalidMoneyError`: `NaN`, `Infinity`, notação científica, string vazia, mais de 2 casas decimais, formato inválido, valores negativos quando a origem é contrato de entrada (`Money.fromInput`, separado de `from`).
- Arredondamento: não existe arredondamento silencioso — entrada com mais de 2 casas é erro.

### `Wallet` (`src/domain/wallet/wallet.ts`)
- Construtor `private`; `open`, `rehydrate`, `debit`, `credit`.
- `version` inicia em 1 em `open`; incrementa **somente** quando o saldo muda.
- Saldo nunca negativo: `debit` que resultaria em negativo → erro `InsufficientBalanceError`.
- Moeda da operação deve ser igual à da wallet → `CurrencyMismatchError`.
- `debit`/`credit` retornam um resultado com `{ wallet, balanceBefore, balanceAfter, direction, money }` para a camada de aplicação gerar o lançamento.

### `WagerTransaction` (`src/domain/wagering/wager-transaction.ts`)
- Enums: `WagerTransactionKind` (`OPENING, BET, WIN, LOSS, REFUND, ROLLBACK`), `WagerTransactionStatus` (`PENDING, PENDING_REFERENCE, PROCESSED, REJECTED, FAILED`).
- `create(props)`: nasce `PENDING`; valida `requiresReference()` (REFUND e ROLLBACK exigem `referenceExternalTransactionId`).
- Transições:
  - `markProcessed(referenceTransactionId | undefined, at)`
  - `markPendingReference()`
  - `reject(code)`
  - `fail(code)`
  - Estados terminais (`PROCESSED`, `REJECTED`, `FAILED`) → `InvalidTransactionStateError`.
- Consultas: `isTerminal()`, `affectsBalance()` (false para LOSS), `requiresReference()`, `matchesPayload(hash)`, `ledgerDirectionFor(reference?)`.
- Regra: `REFUND` só referencia `BET`; `ROLLBACK` referencia `BET`, `WIN` ou `REFUND`. Validação de tipo da referência fica em `ledgerDirectionFor`/validador de referência — documentar onde.

### `WalletLedgerEntry` (`src/domain/wallet/wallet-ledger-entry.ts`)
- Imutável: campos `readonly`, sem métodos de transição.
- `create` valida `balanceBefore ± money === balanceAfter` → `LedgerArithmeticError`.
- `isBalanced()`.
- `LedgerDirection`: `DEBIT`, `CREDIT`.

### `FailureCode` (`src/domain/failure-code.ts`)
- Enum string estável. Mínimo: `INVALID_PAYLOAD`, `INSUFFICIENT_BALANCE`, `NEGATIVE_BALANCE_ON_REVERSAL`, `CURRENCY_MISMATCH`, `REFERENCE_NOT_FOUND`, `REFERENCE_NOT_PROCESSED`, `REFERENCE_ALREADY_REVERSED`, `REFERENCE_TYPE_NOT_ALLOWED`, `REFERENCE_CONTEXT_MISMATCH`, `AMOUNT_MISMATCH_ON_REVERSAL`, `DUPLICATE_WALLET`, `IDEMPOTENCY_CONFLICT`, `INTERNAL_ONLY_KIND`.
- Cada código documentado com uma linha em `docs/failure-codes.md`.

### Hash de payload (`src/domain/wagering/payload-hash.ts`)
- Campos de negócio: `providerId, externalTransactionId, playerId, walletId, roundId, gameId, kind, money, referenceExternalTransactionId`.
- JSON canônico (chaves ordenadas recursivamente, sem espaços), SHA-256 em hex.
- Documentar o algoritmo em `ARCHITECTURE.md`.

## Testes (`bun test`, unitários)
- `Money`: escala, entradas inválidas (lista acima), operações, moeda diferente, imutabilidade.
- `Wallet`: `open` com version 1; `debit` sem saldo; `debit` exato até zero; `credit` incrementa version; operação sem mudança de saldo não incrementa (ex.: debit de zero deve ser rejeitado, não “sem efeito”).
- `WagerTransaction`: create por kind; `REFUND` sem referência → erro; transições proibidas em terminais; `affectsBalance` de LOSS.
- `WalletLedgerEntry`: aritmética válida e inválida.
- `payloadHash`: mesma entrada em ordens diferentes de chave → mesmo hash; valor diferente → hash diferente.

## Critérios de aceite
1. `bun test` verde, sem dependências externas (sem Docker).
2. Nenhum arquivo em `src/domain/` importa framework ou ORM (verificar com grep).
3. Nenhum `number` usado para valor monetário (verificar com grep em `src/domain`).
4. Construtores de entidades são `private`; criação só por factories.
