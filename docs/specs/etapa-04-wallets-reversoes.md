# Spec — Etapa 4: Criação de wallet e reversões (REFUND / ROLLBACK)

## Objetivo
Completar as regras de negócio da seção 7: criação de wallet com saldo inicial e reversões seguras.

## Pré-requisitos
Etapa 3.

## Escopo

### `POST /wallets` (`src/application/wallets/open-wallet.use-case.ts`)
- Body: `{ playerId, initialBalance: { amount, currency } }` (validação DTO; `amount` ≥ 0).
- Cria a wallet (`Wallet.open`).
- Se `initialBalance > 0`: cria `WagerTransaction` interna `OPENING` (`PROCESSED`), lançamento `CREDIT` e evento `WalletBalanceChanged` — **na mesma transação SQL**.
- Se `initialBalance == 0`: cria wallet sem transação nem ledger.
- Duplicidade `playerId + currency` → `409` com `DUPLICATE_WALLET` (tratar violação de unique; não confiar só no check prévio).
- Resposta `201`: `{ id, playerId, balance, version }`.
- `OPENING` não é submetível pela API (já garantido na Etapa 3 — testar de novo aqui).
- Idempotência de criação: decidir e documentar. Recomendação: não exigir header nesta etapa; a unicidade `(player_id, currency)` já protege contra duplicidade. Registrar a decisão.

### REFUND (regras 1–6 e 9 da seção 7)
- `referenceExternalTransactionId` obrigatório.
- Referência resolvida por `(providerId, referenceExternalTransactionId)`.
- Validar contexto: mesmo `providerId`, `playerId`, `walletId`, moeda e `roundId` → senão `REFERENCE_CONTEXT_MISMATCH`.
- Tipo permitido: somente `BET` → senão `REFERENCE_TYPE_NOT_ALLOWED`.
- Referência não `PROCESSED` → `REFERENCE_NOT_PROCESSED` (rejeição; o caso de ausência é tratado na Etapa 5).
- Já revertida por REFUND → `REFERENCE_ALREADY_REVERSED`.
- Valor diferente da referência → `AMOUNT_MISMATCH_ON_REVERSAL`.
- Efeito: `credit` na wallet, 1 ledger `CREDIT`.

### ROLLBACK
- Referência: `BET`, `WIN` ou `REFUND` (tipo permitido).
- Mesmas validações de contexto, status e valor.
- "Já revertida pelo mesmo tipo": um ROLLBACK não pode reverter a mesma referência duas vezes. Regra: unicidade de `(reference_transaction_id, kind)` para `kind IN (REFUND, ROLLBACK)` — **adicionar índice único parcial** (migration nova nesta etapa) e checar no código.
- Efeito: inverso da referência:
  - referência `BET` (débito) → ROLLBACK **credita**;
  - referência `WIN` (crédito) → ROLLBACK **debita**; se saldo insuficiente → `NEGATIVE_BALANCE_ON_REVERSAL` (rejeição, auditável, `REJECTED`);
  - referência `REFUND` (crédito) → ROLLBACK **debita**, mesma regra de saldo.
- `ledgerDirectionFor(reference)` no domínio implementa a inversão.

### Regra de saldo negativo em reversão
- Reversão que faria saldo negativo → `REJECTED` com `NEGATIVE_BALANCE_ON_REVERSAL` (distinto de `INSUFFICIENT_BALANCE`).
- Registrar em `docs/failure-codes.md` a diferença operacional.

### Interpretações a documentar (`ARCHITECTURE.md`)
- Reversão de WIN após saldo gasto → `NEGATIVE_BALANCE_ON_REVERSAL`, sem permitir negativo.
- Reversão de REFUND (crédito) segue a mesma regra.

## Testes (`test/integration/reversals/` e `test/unit/domain/`)
Unitários (domínio):
- `ledgerDirectionFor` para cada combinação válida (BET/WIN/REFUND × REFUND/ROLLBACK).
- Tipo de referência inválido (REFUND→WIN, ROLLBACK→LOSS) → erro.

Integração (matriz):
- REFUND de BET processada → crédito, 1 ledger, status `PROCESSED`.
- REFUND de BET já reembolsada → `REFERENCE_ALREADY_REVERSED`.
- REFUND com valor diferente → `AMOUNT_MISMATCH_ON_REVERSAL`.
- REFUND de WIN → `REFERENCE_TYPE_NOT_ALLOWED`.
- REFUND com roundId diferente → `REFERENCE_CONTEXT_MISMATCH`.
- REFUND de BET `REJECTED` → `REFERENCE_NOT_PROCESSED`.
- ROLLBACK de BET → crédito.
- ROLLBACK de WIN com saldo suficiente → débito.
- ROLLBACK de WIN após saldo gasto → `REJECTED` `NEGATIVE_BALANCE_ON_REVERSAL`, sem ledger, saldo inalterado.
- ROLLBACK de REFUND → débito (ou rejeição se saldo insuficiente).
- Dois ROLLBACKs (external IDs diferentes) da mesma BET → segundo rejeitado `REFERENCE_ALREADY_REVERSED`; constraint de banco também impede.
- Criar wallet com saldo 0 → sem `OPENING`/ledger; saldo > 0 → `OPENING` + ledger na mesma transação (forçar falha após insert para provar atomicidade).
- Wallet duplicada → `409` `DUPLICATE_WALLET`.

Concorrência:
- REFUND e ROLLBACK simultâneos da mesma BET → exatamente um `PROCESSED`.

Invariante `assertLedgerInvariant` em todos os testes de integração desta etapa.

## Critérios de aceite
1. Matriz de testes acima verde.
2. Índice único parcial de reversão existe e é testado.
3. `ledgerDirectionFor` é a única fonte da regra de inversão.
4. `docs/failure-codes.md` atualizado.
