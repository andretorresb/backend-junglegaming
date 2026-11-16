# Distributed Wagering Processor

Serviço financeiro distribuído que processa transações de apostas de múltiplos provedores de jogos.
Desafio técnico da Jungle Gaming.

- **Arquitetura, decisões, trade-offs e limitações:** [`ARCHITECTURE.md`](./ARCHITECTURE.md)
- **Contrato HTTP:** [`docs/http-contract.md`](./docs/http-contract.md)
- **Códigos de falha:** [`docs/failure-codes.md`](./docs/failure-codes.md)
- **Operação e diagnóstico:** [`docs/runbook.md`](./docs/runbook.md)
- **Plano e specs por etapa:** [`ETAPAS.md`](./ETAPAS.md), [`docs/specs/`](./docs/specs/)

## Stack

Bun 1.x · TypeScript estrito · NestJS 11 · MikroORM 6 · PostgreSQL 16 · AWS SQS via LocalStack 3.8 · Docker Compose.

## Pré-requisitos

- [Bun](https://bun.sh) 1.x
- Docker com Docker Compose (Docker Desktop, OrbStack ou Colima)

No macOS com Docker Desktop, o CLI `docker` pode não estar no `PATH` do terminal. Nesse caso adicione:

```bash
export PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH"
```

## Passo a passo (clone limpo)

```bash
# 1. dependências
bun install

# 2. variáveis de ambiente (os padrões já funcionam com o docker-compose)
cp .env.example .env

# 3. infraestrutura: PostgreSQL e LocalStack
docker compose up -d
docker compose ps          # aguarde "healthy" no postgres

# 4. filas SQS: os nomes vêm do ambiente (padrões: wager-transactions.fifo, DLQ e wager-events)
bun run localstack:init

# 5. schema do banco de desenvolvimento
bun run migration:up

# 6. aplicação
bun run dev                # http://localhost:3000
```

Verificação:

```bash
curl -s http://localhost:3000/health/live
# {"status":"ok"}

curl -s http://localhost:3000/health/ready
# {"status":"ok","ok":true,"checks":{"postgres":"up","sqs":"up","draining":"up"}}
```

### Testes

```bash
bun run test:unit          # domínio, política de retry, observabilidade (sem infraestrutura)
bun run test:integration   # PostgreSQL e LocalStack reais; cria o banco junglegaming_test sozinho
bun run test:concurrency   # paralelismo real e processos da aplicação (exige o mesmo ambiente)
bun run test               # tudo
```

Os testes de integração usam o banco `junglegaming_test`, criado automaticamente. O banco de
desenvolvimento não é alterado. Os testes desligam os agendadores automáticos por `test/setup.ts`
(preload definido em `bunfig.toml`).

## Comandos

| Comando | Descrição |
|---|---|
| `bun run dev` | Aplicação com recarga automática |
| `bun run start` | Aplicação sem recarga |
| `bun run typecheck` | Checagem de tipos (`tsc --noEmit`) |
| `bun run test:unit` | Testes unitários |
| `bun run test:integration` | Testes de integração (PostgreSQL e LocalStack reais) |
| `bun run test:concurrency` | Testes de concorrência e de processos |
| `bun run test` | Todos os testes |
| `bun run localstack:init` | Cria as filas no LocalStack |
| `bun run migration:up` | Aplica migrations pendentes |
| `bun run migration:down` | Reverte a última migration |
| `bun run migration:reset` | Reverte todas as migrations |
| `bun run migration:status` | Lista migrations executadas e pendentes |
| `bun run migration:create <nome>` | Cria uma migration vazia |

## Variáveis de ambiente

Todas são opcionais. Os padrões estão em `src/config/env.ts` e em `.env.example`.

| Variável | Padrão | Função |
|---|---|---|
| `PORT` | `3000` | Porta HTTP |
| `SERVICE_NAME` | `wagering-processor` | Campo `service` dos logs |
| `DB_HOST`, `DB_PORT` | `localhost`, `5433` | PostgreSQL. A porta 5433 evita conflito com um Postgres local em 5432 |
| `DB_USER`, `DB_PASSWORD`, `DB_NAME` | `jungle`, `jungle`, `junglegaming` | Credenciais e banco |
| `AWS_ENDPOINT_URL`, `AWS_REGION` | `http://localhost:4566`, `us-east-1` | LocalStack |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | `test`, `test` | Credenciais do LocalStack |
| `WAGER_CONSUMER_ENABLED` | `1` | Liga o consumidor de `wager-transactions.fifo` |
| `SQS_WAGER_QUEUE`, `SQS_WAGER_DLQ` | `wager-transactions.fifo`, `wager-transactions-dlq.fifo` | Filas de transações. Precisam terminar em `.fifo`. A inicialização (`localstack:init`) cria as filas com estes mesmos nomes |
| `SQS_WAIT_SECONDS`, `SQS_MAX_MESSAGES` | `10`, `10` | Long polling e lote |
| `SQS_MAX_RECEIVE_COUNT` | `5` | Tentativas antes da DLQ. Vale para o consumidor e para a redrive policy do SQS |
| `SQS_RETRY_BASE_SECONDS`, `SQS_RETRY_MAX_SECONDS` | `5`, `900` | Backoff de retry |
| `SQS_VISIBILITY_SECONDS` | `60` | Visibilidade ao receber |
| `SHUTDOWN_GRACE_MS` | `10000` | Tempo de drenagem no SIGTERM |
| `OUTBOX_POLL_MS`, `OUTBOX_BATCH_SIZE`, `OUTBOX_MAX_BACKOFF_MS` | `500`, `50`, `300000` | Publisher da outbox. `OUTBOX_POLL_MS=0` desliga |
| `EVENTS_QUEUE_NAME` | `wager-events` | Fila de eventos de integração. Criada pela inicialização com este nome |
| `PENDING_REFERENCE_POLL_MS` | `1000` | Worker de referências. `0` desliga |
| `PENDING_REFERENCE_BATCH_SIZE`, `PENDING_REFERENCE_MAX_ATTEMPTS` | `50`, `10` | Lote e limite de tentativas |
| `PENDING_REFERENCE_TTL_MS` | `86400000` | TTL de uma referência pendente (24h) |
| `PENDING_REFERENCE_BASE_DELAY_MS`, `PENDING_REFERENCE_MAX_DELAY_MS` | `1000`, `300000` | Backoff das consultas |

## API

Formato de erro: `{ code, failureCode?, message? }`. Rejeições de negócio trazem `failureCode`.
O status completo está em [`docs/http-contract.md`](./docs/http-contract.md).

Os exemplos usam `jq` para extrair ids. Sem `jq`, copie os ids da resposta.

### Criar wallet

```bash
PLAYER_ID=0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1
WALLET_ID=$(curl -s -X POST http://localhost:3000/wallets \
  -H 'content-type: application/json' \
  -d "{\"playerId\":\"$PLAYER_ID\",\"initialBalance\":{\"amount\":\"1000.00\",\"currency\":\"BRL\"}}" | jq -r .id)
echo "$WALLET_ID"
```

Saldo inicial zero cria só a wallet. Saldo maior que zero gera a transação interna `OPENING` e o lançamento CREDIT, na mesma transação. Criar de novo a mesma combinação de jogador e moeda responde `409 DUPLICATE_WALLET`.

### Apostar (BET), com `Idempotency-Key`

```bash
curl -s -X POST http://localhost:3000/wagering/transactions \
  -H 'content-type: application/json' \
  -H 'idempotency-key: provider-a:transaction-123' \
  -d "{\"providerId\":\"provider-a\",\"externalTransactionId\":\"transaction-123\",\"playerId\":\"$PLAYER_ID\",\"walletId\":\"$WALLET_ID\",\"roundId\":\"round-987\",\"gameId\":\"fortune-chimp\",\"kind\":\"BET\",\"money\":{\"amount\":\"25.00\",\"currency\":\"BRL\"}}"
# 200 {"transactionId":"…","status":"PROCESSED","balance":{"amount":"975.00","currency":"BRL"},"failureCode":null,"idempotentReplay":false}
```

Repetir a mesma requisição devolve a mesma resposta, com `idempotentReplay: true`. A mesma chave com outro payload responde `409 IDEMPOTENCY_CONFLICT`. Saldo insuficiente responde `422` com `failureCode: "INSUFFICIENT_BALANCE"`.

### Ganhar (WIN) e perder (LOSS)

```bash
# WIN: credita
curl -s -X POST http://localhost:3000/wagering/transactions \
  -H 'content-type: application/json' -H 'idempotency-key: provider-a:win-1' \
  -d "{\"providerId\":\"provider-a\",\"externalTransactionId\":\"win-1\",\"playerId\":\"$PLAYER_ID\",\"walletId\":\"$WALLET_ID\",\"roundId\":\"round-987\",\"gameId\":\"fortune-chimp\",\"kind\":\"WIN\",\"money\":{\"amount\":\"40.00\",\"currency\":\"BRL\"}}"

# LOSS: registra o resultado sem mover saldo
curl -s -X POST http://localhost:3000/wagering/transactions \
  -H 'content-type: application/json' -H 'idempotency-key: provider-a:loss-1' \
  -d "{\"providerId\":\"provider-a\",\"externalTransactionId\":\"loss-1\",\"playerId\":\"$PLAYER_ID\",\"walletId\":\"$WALLET_ID\",\"roundId\":\"round-987\",\"gameId\":\"fortune-chimp\",\"kind\":\"LOSS\",\"money\":{\"amount\":\"10.00\",\"currency\":\"BRL\"}}"
```

### Reembolsar (REFUND) e reverter (ROLLBACK)

REFUND reverte uma BET processada. ROLLBACK reverte uma BET, uma WIN ou um REFUND. Os dois exigem `referenceExternalTransactionId`.

```bash
curl -s -X POST http://localhost:3000/wagering/transactions \
  -H 'content-type: application/json' -H 'idempotency-key: provider-a:refund-1' \
  -d "{\"providerId\":\"provider-a\",\"externalTransactionId\":\"refund-1\",\"playerId\":\"$PLAYER_ID\",\"walletId\":\"$WALLET_ID\",\"roundId\":\"round-987\",\"gameId\":\"fortune-chimp\",\"kind\":\"REFUND\",\"referenceExternalTransactionId\":\"transaction-123\",\"money\":{\"amount\":\"25.00\",\"currency\":\"BRL\"}}"
```

Se a referência ainda não existe, a resposta é `202` com `status: "PENDING_REFERENCE"`, e o worker reprocessa com backoff. Sem a referência dentro de 10 tentativas ou de 24h, a transação vira `REJECTED` com `REFERENCE_NOT_FOUND`.

### Consultas

```bash
curl -s http://localhost:3000/wallets/$WALLET_ID
curl -s "http://localhost:3000/wallets/$WALLET_ID/ledger?limit=50"
# use o nextCursor da resposta para a próxima página:
curl -s "http://localhost:3000/wallets/$WALLET_ID/ledger?cursor=<nextCursor>"
curl -s http://localhost:3000/wagering/transactions/<transactionId>
curl -s http://localhost:3000/providers/provider-a/wagering/transactions/transaction-123
```

### Reconciliação

```bash
curl -s -X POST http://localhost:3000/wallets/$WALLET_ID/reconciliation
# {"walletId":"…","storedBalance":{…},"calculatedBalance":{…},"difference":{…},"consistent":true,"checkedEntries":5}
```

O servidor calcula tudo a partir do ledger. O corpo da requisição é ignorado. Divergência aparece na resposta, em log e em `reconciliation_divergence_total`. Nada é corrigido automaticamente.

## Filas e eventos

- **Entrada:** `wager-transactions.fifo`. Mensagem `WagerTransactionRequested`, com grupo FIFO por `walletId`. Formato na seção 13 do `ARCHITECTURE.md`.
- **DLQ:** `wager-transactions-dlq.fifo`. Recebe mensagens com JSON ou schema inválido, `OPENING`, wallet inexistente e as que esgotam as tentativas. O atributo `reason` traz o motivo.
- **Eventos de integração:** `wager-events` (padrão). Entregues at-least-once. Consumidores deduplicam por `eventId`.
- **Nomes configuráveis:** `localstack:init`, o consumidor e o publisher leem as mesmas variáveis. Trocar um nome no `.env` e rodar `localstack:init` cria as filas novas.

Para testar o consumidor sem a API, envie uma mensagem para `wager-transactions.fifo` com `MessageGroupId` igual ao `walletId`.

## Observabilidade

- **Logs:** uma linha JSON por evento, em stdout. Campos de correlação: `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`. Valores monetários e payloads nunca entram no log.
- **Correlação:** envie `x-correlation-id` para correlacionar uma requisição. Sem o cabeçalho, a aplicação gera um.
- **Métricas:** `GET http://localhost:3000/metrics` (formato Prometheus).
- **Health:** `/health/live` (processo) e `/health/ready` (PostgreSQL, SQS e drenagem).

## Solução de problemas

| Sintoma | Causa provável | O que fazer |
|---|---|---|
| `connection refused` na porta 5433 | Container não subiu | `docker compose ps`; aguarde `healthy` |
| `/health/ready` responde 503 com `sqs: down` | LocalStack não está pronto, ou as filas não existem | `docker compose logs localstack`; depois `bun run localstack:init` |
| `docker: command not found` | CLI fora do `PATH` no macOS | Veja os pré-requisitos |
| Porta 3000 em uso | Outro processo | `PORT=3001 bun run dev` |

## Estrutura

```
src/
  domain/           regras puras: Money, Wallet, WagerTransaction, eventos, outbox, inbox
  application/      casos de uso, portas e workers (sem framework)
  infrastructure/   MikroORM, SQS, logs, métricas, relógio
  interfaces/       HTTP (controllers, DTOs, filtros, interceptors), consumidor SQS, schedulers
  config/           leitura de variáveis de ambiente
scripts/            migrations (migrate.ts) e inicialização do LocalStack
test/               unit, integration, concurrency, support, setup
docs/               contrato HTTP, códigos de falha, runbook e specs por etapa
```
