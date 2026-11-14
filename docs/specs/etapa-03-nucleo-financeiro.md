# Spec — Etapa 3: Núcleo financeiro (BET, WIN, LOSS e idempotência)

## Objetivo
Processar BET, WIN e LOSS de forma correta sob concorrência, com idempotência persistente. Este é o caminho que mais pesa na avaliação.

## Pré-requisitos
Etapas 1 e 2.

## Escopo

### Use case `ProcessWagerTransaction` (`src/application/wagering/process-wager-transaction.use-case.ts`)
Entrada: comando com `idempotencyKey`, `payloadHash`, campos de negócio e `source: 'HTTP' | 'SQS'` (usado depois).
Saída: `{ transactionId, status, balance, failureCode?, idempotentReplay }`.

Fluxo, **em uma única transação SQL** (`em.transactional`):
1. Buscar `wager_transactions` por `idempotency_key`.
   - Existe e hash igual → retornar resultado original, `idempotentReplay: true`, com o saldo **registrado naquele momento** (guardar `balance_after_processing` na transação ou ler do ledger da própria transação).
   - Existe e hash diferente → `IDEMPOTENCY_CONFLICT` (erro de conflito, não replay).
2. Validar `kind !== OPENING` (interno) → `INTERNAL_ONLY_KIND`.
3. Buscar a wallet com **lock pessimista** `SELECT ... FOR UPDATE` (`LockMode.PESSIMISTIC_WRITE`).
   - Wallet inexistente → erro de aplicação `WALLET_NOT_FOUND` (404 na API).
   - Validar `playerId`, `currency` contra a wallet → `CURRENCY_MISMATCH` / rejeição.
4. Criar `WagerTransaction` em `PENDING`, persistir.
5. Aplicar regra:
   - BET: `wallet.debit`. Saldo insuficiente → `REJECTED` com `INSUFFICIENT_BALANCE`, **sem** ledger.
   - WIN: `wallet.credit`.
   - LOSS: sem efeito no saldo; `PROCESSED`, sem ledger.
6. Se houve mudança de saldo: gravar `wallet_ledger_entries` (1 linha) e atualizar wallet (`balance`, `version`, `updated_at`).
7. Marcar status final (`PROCESSED` ou `REJECTED`).
8. Gravar eventos na outbox (`WagerTransactionProcessed` ou `WagerTransactionRejected`; `WalletBalanceChanged` só se saldo mudou). **Gravação apenas — publicação é Etapa 7.**
9. Commit. Retornar.

Importante: rejeição por regra de negócio **é resultado persistido** (commit), não exceção que desfaz a transação.

### Concorrência
- Estratégia: `SELECT ... FOR UPDATE` na linha da wallet (pessimista). Justificar no `ARCHITECTURE.md` por que não optimistic (retry em hot wallet).
- Sem lock global; locks só por `walletId`.
- Se o comando envolver mais de uma wallet no futuro, ordenar por `id` — documentar como regra mesmo que hoje não se aplique.
- Erro de lock timeout (`lock_timeout` configurado) → erro transitório (`503`/retry), não `REJECTED`.

### Idempotência
- Chave `Idempotency-Key` = fonte da verdade. Constraint `UNIQUE (idempotency_key)` é a garantia final — tratar violação de unique por corrida (duas requisições simultâneas com a mesma key): capturar e reler, então aplicar a regra de replay/conflito.
- Sem cache em memória como garantia.

### Endpoints (`src/interfaces/http/wagering/`)
- `POST /wagering/transactions`
  - Header `Idempotency-Key` obrigatório. Ausente → `400`.
  - Default recomendado: `{providerId}:{externalTransactionId}`; se o header divergir do default, aceitar o header como fonte da verdade e registrar.
  - Body validado (DTO com `class-validator`): conforme exemplo do enunciado.
  - Resposta: `200` com `{ transactionId, status, balance, idempotentReplay }`. Rejeição de negócio: ver mapeamento da Etapa 6 — nesta etapa, retornar `422` com `failureCode`.
- `GET /wagering/transactions/:transactionId`
- `GET /providers/:providerId/wagering/transactions/:externalTransactionId`
- Controller fino: validar, montar comando, chamar use case, mapear resposta.

### Código de domínio usado
- `WagerTransaction`, `Wallet`, `WalletLedgerEntry`, `payloadHash` (Etapa 1).

## Testes (`test/integration/wagering/` e `test/concurrency/`)
Postgres real.

Unitários (use case com repositório real de teste em banco, ou fake de porta apenas se documentado):
- BET com saldo suficiente → `PROCESSED`, saldo debitado, 1 ledger.
- BET sem saldo → `REJECTED` `INSUFFICIENT_BALANCE`, 0 ledger, saldo inalterado.
- WIN → crédito, 1 ledger.
- LOSS → `PROCESSED`, 0 ledger, saldo inalterado, evento `WagerTransactionProcessed` gravado, `WalletBalanceChanged` **não** gravado.
- Replay idêntico → `idempotentReplay: true`, mesmo `transactionId`, mesmo saldo original.
- Mesma key, payload diferente → `IDEMPOTENCY_CONFLICT`.
- `OPENING` via API → rejeitado.
- Moeda diferente da wallet → rejeição.

Concorrência:
1. A mesma aposta 50× em paralelo (`Promise.all`) → 1 débito, 1 ledger, 49 replays (ou conflitos, nunca novo débito).
2. Wallet 100.00; duas BETs de 80.00 em paralelo com keys diferentes → 1 `PROCESSED`, 1 `REJECTED` `INSUFFICIENT_BALANCE`, saldo final 20.00, 1 ledger de débito.
3. Após o cenário 2, invariante `wallet.balance == soma do ledger` (helper `assertLedgerInvariant`).

## Critérios de aceite
1. Todos os testes de unitário e concorrência passam.
2. Helper `assertLedgerInvariant` existe e é chamado no final dos testes de concorrência.
3. Nenhuma mensagem de outbox é publicada no SQS nesta etapa.
4. `ARCHITECTURE.md` atualizado com a estratégia de lock e idempotência.
