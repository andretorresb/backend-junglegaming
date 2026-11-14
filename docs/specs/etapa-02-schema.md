# Spec — Etapa 2: Schema e migrations

## Objetivo
Garantias de unicidade, imutabilidade e não-negatividade aplicadas no PostgreSQL, com migrations versionadas e reversíveis.

## Pré-requisitos
Etapas 0 e 1 concluídas.

## Escopo
### Entidades de persistência (`src/infrastructure/persistence/`)
- Mapeamento MikroORM separado do domínio. Mapeadores `toDomain` / `toPersistence` (rehydrate, nunca `create`).
- Colunas de dinheiro: `amount NUMERIC(19,2)` + `currency CHAR(3)`. Reidratação exata para `Money`.

### Tabelas
- `wallets`
  - `id UUID PK`, `player_id UUID NOT NULL`, `currency CHAR(3) NOT NULL`, `balance NUMERIC(19,2) NOT NULL`, `version INT NOT NULL`, `created_at`, `updated_at`.
  - `UNIQUE (player_id, currency)`.
  - `CHECK (balance >= 0)`, `CHECK (version >= 1)`, `CHECK (currency ~ '^[A-Z]{3}$')`.
- `wager_transactions`
  - `id UUID PK`, `provider_id`, `external_transaction_id`, `idempotency_key`, `payload_hash CHAR(64)`, `wallet_id FK`, `player_id`, `round_id`, `game_id`, `kind`, `amount`, `currency`, `reference_external_transaction_id NULL`, `reference_transaction_id NULL FK`, `status`, `failure_code NULL`, `created_at`, `processed_at NULL`.
  - `UNIQUE (provider_id, external_transaction_id)`, `UNIQUE (idempotency_key)`.
  - `CHECK (kind IN (...))`, `CHECK (status IN (...))`.
  - `CHECK (kind NOT IN ('REFUND','ROLLBACK') OR reference_external_transaction_id IS NOT NULL)`.
  - Índices: `(wallet_id)`, `(provider_id, reference_external_transaction_id)`, parcial `(status, created_at) WHERE status = 'PENDING_REFERENCE'`.
- `wallet_ledger_entries`
  - `id UUID PK`, `wallet_id FK`, `transaction_id FK`, `direction`, `amount NUMERIC(19,2) CHECK (amount > 0)`, `currency`, `balance_before`, `balance_after`, `created_at`.
  - `UNIQUE (wallet_id, transaction_id)`.
  - `CHECK (direction IN ('DEBIT','CREDIT'))`, `CHECK (balance_after >= 0)`.
  - Índice `(wallet_id, created_at, id)` para paginação por cursor.
  - **Trigger** `BEFORE UPDATE OR DELETE` que lança exceção (`RAISE EXCEPTION 'ledger is immutable'`).
  - Trigger de `TRUNCATE`? Opcional — documentar se não for feito.
- `inbox_messages`: `PRIMARY KEY (consumer_name, message_id)`, `payload_hash`, `received_at`, `processed_at NULL`.
- `outbox_messages`: `id UUID PK`, `aggregate_id`, `event_type`, `payload JSONB`, `occurred_at`, `attempts INT DEFAULT 0`, `next_attempt_at NULL`, `published_at NULL`. Índice parcial `(next_attempt_at) WHERE published_at IS NULL`.
- `idempotency` é a própria `wager_transactions` (constraint de `idempotency_key`) — não criar tabela extra.

### Migrations
- Ferramenta: a do MikroORM (`migration:create`, `migration:up`, `migration:down`).
- Cada migration com `up` **e** `down` testados.
- Triggers e funções criadas via SQL bruto na migration.

## Testes de integração (`test/integration/schema/`)
Usam Postgres real (Docker Compose ou Testcontainers — escolher e documentar).
- Migrations sobem do zero.
- Inserir wallet duplicada (mesmo player + currency) → erro de unique.
- `balance` negativo → erro de check.
- `UPDATE` em ledger → erro. `DELETE` em ledger → erro.
- Dois lançamentos para mesma `(wallet_id, transaction_id)` → erro.
- `REFUND` sem referência → erro de check.
- `down` de todas as migrations reverte sem erro; `up` novamente funciona.

## Critérios de aceite
1. `bun run migration:up` aplica do zero em banco vazio.
2. `bun run migration:down` reverte tudo.
3. Todos os testes de constraint passam.
4. Nenhum tipo `float`/`double` nas colunas monetárias.
