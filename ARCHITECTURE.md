# ARCHITECTURE.md

Documento vivo. Cada decisão relevante é registrada aqui com motivo, alternativas e trade-offs.
Estado atual: **Etapa 2 (schema e migrations)**.

## 1. Stack

| Item | Escolha | Status |
|---|---|---|
| Runtime / package manager / test runner | Bun 1.x | Adotado |
| Linguagem | TypeScript estrito (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) | Adotado |
| Framework | NestJS 11 | Adotado |
| ORM | MikroORM 6 (PostgreSQL) | Adotado — ver seção 2 |
| Banco | PostgreSQL 16 | Adotado |
| Mensageria | AWS SQS via LocalStack 3.8 | Adotado (uso a partir da Etapa 7) |
| Orquestração local | Docker Compose | Adotado |

## 2. Escolha do ORM: MikroORM

**Decisão:** MikroORM (preferencial no enunciado).

**Motivo:**
- Unit of Work e Identity Map explícitos: controle fino sobre quando o estado é gravado, útil para o commit atômico de wallet + ledger + inbox + outbox.
- `EntityManager.transactional()` para a fronteira transacional.
- Suporte a `LockMode.PESSIMISTIC_WRITE` (`SELECT ... FOR UPDATE`), usado na estratégia de concorrência (Etapa 3).

**Alternativas consideradas:** TypeORM (aceito pelo enunciado, menos explícito em Unit of Work). Prisma fora de escopo.

**Separação:** o domínio (`src/domain`) não importa o ORM. Entidades de persistência e mapeadores ficam em `src/infrastructure/persistence` (Etapa 2).

## 3. Autenticação

**Status:** pendente de decisão, a registrar até a Etapa 6.

Opções:
- Integrar IdP externo (Keycloak ou Zitadel) em Docker Compose.
- Não implementar, documentar o desenho e deixar `AuthGuard` no-op e `ProviderIdentityPort` como pontos de extensão.

Escopo: endpoints de health ficam abertos. Mensagens da fila são canal interno confiável, mas a identidade do provedor no payload continua sujeita às validações de domínio.

## 4. Configuração

- Variáveis de ambiente lidas em `src/config/env.ts` (ver `.env.example`).
- `mikro-orm.config.ts` na raiz é compartilhado pela aplicação e pela CLI de migrations.

## 5. Health checks

- `GET /health/live`: processo vivo, sem IO, sem autenticação. **Implementado.**
- `GET /health/ready`: Postgres e SQS alcançáveis. **Pendente (Etapa 6).**

## 6. Domínio (Etapa 1)

### 6.1 Money
- Representação interna: `decimal.js` (precisão 40, sem arredondamento silencioso).
- Entrada aceita: `^-?\d+(\.\d{1,2})?$`. Rejeita `NaN`, `Infinity`, notação científica, vazio, sinal `+`, mais de 2 casas.
- `Money.from` aceita negativos (uso interno); `Money.fromInput` rejeita negativos (contratos de entrada).
- Serialização: sempre 2 casas (`"25.00"`). `-0` é normalizado para `0`.
- `equals` com moedas diferentes retorna `false`; `isLessThan` e operações aritméticas lançam `CurrencyMismatchError`.

### 6.2 Transições de `WagerTransaction`

| De | Para |
|---|---|
| `PENDING` | `PROCESSED`, `PENDING_REFERENCE` (só REFUND/ROLLBACK), `REJECTED`, `FAILED` |
| `PENDING_REFERENCE` | `PROCESSED`, `REJECTED`, `FAILED` |
| `PROCESSED`, `REJECTED`, `FAILED` | nenhuma (terminais) |

Transição inválida lança `InvalidTransactionStateError`, que é erro de programação e não caminho de negócio.

### 6.3 Direção do lançamento (`ledgerDirectionFor`)

| Kind | Direção | Referência aceita |
|---|---|---|
| `OPENING`, `WIN` | CREDIT | — |
| `BET` | DEBIT | — |
| `LOSS` | sem lançamento | — |
| `REFUND` | CREDIT | somente `BET` |
| `ROLLBACK` | inverso da referência: `BET` → CREDIT; `WIN` ou `REFUND` → DEBIT | `BET`, `WIN`, `REFUND` |

A validação de tipo da referência fica nesse método (fonte única). A validação de contexto (provider, player, wallet, moeda, rodada), de status e de valor fica na Etapa 4.

### 6.4 Hash de payload (`payloadHash`)
1. Monta o subconjunto: `providerId, externalTransactionId, playerId, walletId, roundId, gameId, kind, money (MoneyProps), referenceExternalTransactionId` (ausente = `null`).
2. Serializa como JSON canônico: chaves de objeto ordenadas recursivamente (ordem de código UTF-16), arrays preservam a ordem, sem espaços.
3. SHA-256 do texto UTF-8, em hexadecimal minúsculo (64 caracteres).

`Idempotency-Key` e metadados de transporte não entram no hash.

### 6.5 Wallet
- `version` começa em 1 e incrementa somente quando o saldo muda (`debit`/`credit` com valor positivo).
- `debit` sem saldo lança `InsufficientBalanceError` antes de qualquer alteração.
- Na Etapa 4, a reversão que faria saldo negativo será traduzida para `NEGATIVE_BALANCE_ON_REVERSAL` pela camada de aplicação.

## 7. Persistência (Etapa 2)

### 7.1 Schema
Tabelas: `wallets`, `wager_transactions`, `wallet_ledger_entries`, `inbox_messages`, `outbox_messages`. Migrations em `src/infrastructure/persistence/migrations`, cada uma com `up` e `down`.

Garantias no banco:
- `wallets`: `UNIQUE (player_id, currency)`; `CHECK (balance >= 0)`; `CHECK (version >= 1)`.
- `wager_transactions`: `UNIQUE (provider_id, external_transaction_id)`; `UNIQUE (idempotency_key)`; `CHECK` de `kind`, `status` e amount > 0; REFUND/ROLLBACK exigem referência e BET/WIN/LOSS não aceitam; FK composta `(wallet_id, currency)` garante moeda igual à da wallet.
- `wallet_ledger_entries`: trigger `BEFORE UPDATE OR DELETE` bloqueia alteração (imutabilidade); `UNIQUE (wallet_id, transaction_id)` (no máximo um lançamento por transação e wallet); `CHECK` de direção, amount > 0 e saldos não negativos; FK composta de moeda.
- `inbox_messages`: PK `(consumer_name, message_id)`.
- `outbox_messages`: índice parcial para eventos pendentes; `attempts >= 0`; `payload` deve ser objeto JSON.

### 7.2 Tipos
- Dinheiro: `numeric(19,2)`. Nenhuma coluna monetária usa float ou double.
- Identificadores internos e `player_id`/`wallet_id`: `uuid`. Identificadores do provedor e `round_id`/`game_id`: `text`.
- `payload_hash`: `char(64)` (SHA-256 hexadecimal).

### 7.3 Limitações conhecidas
- O banco não garante que toda alteração de saldo tenha lançamento correspondente (exigiria trigger de consistência entre tabelas). Essa invariante é garantida pela camada de domínio (`Wallet` e `WalletLedgerEntry`) e verificada pelo helper `assertLedgerInvariant` nos testes (Etapas 3 a 10).
- `TRUNCATE` não é bloqueado pela trigger (que é de linha). Ele é usado apenas nos testes.
- `numeric(19,2)` arredonda entradas com mais casas; a validação de escala é feita antes pelo `Money`.

### 7.4 Execução de migrations
- `bun run migration:up`, `migration:down`, `migration:reset`, `migration:status`, `migration:create <nome>`.
- Usa `scripts/migrate.ts` (API programática do MikroORM). A CLI `mikro-orm` v6 não aplica migrations com config TypeScript sob Bun: termina com código 0 e não faz nada.

## 8. Pendências desta documentação

Serão preenchidas nas etapas seguintes conforme o plano em `ETAPAS.md` e as specs em `docs/specs/`:
- Estratégia de lock e idempotência (Etapa 3).
- Política de referências pendentes (Etapa 5).
- Mapeamento HTTP (Etapa 6).
- Outbox, inbox e semântica at-least-once (Etapas 7 e 8).
- Trade-offs e limitações (Etapa 11).
