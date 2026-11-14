# Spec — Etapa 7: Transactional Outbox

## Objetivo
Publicar eventos de integração somente após o commit, sem perda, com múltiplos publishers concorrentes e publicação duplicada segura.

## Pré-requisitos
Etapas 3 a 6 (eventos já são gravados na outbox pelos use cases).

## Escopo

### Modelo de eventos (`src/domain/events/`)
- `IntegrationEvent<T>` abstrata conforme seção 11 do enunciado: `eventId`, `aggregateId`, `correlationId`, `causationId?`, `occurredAt`, `data`, `toJSON()` com `occurredAt` em ISO-8601 e `version`.
- Subclasses concretas, `eventType` e `version` no tipo:
  - `WagerTransactionProcessed`
  - `WagerTransactionRejected`
  - `WalletBalanceChanged` (só quando o saldo muda)
  - `WagerTransactionPendingReference`
- `data` sempre com `MoneyProps` (string), nunca `Money`.
- `eventId` gerado uma vez por evento e preservado em retries (base da deduplicação).

### `OutboxMessage` (`src/domain/outbox/outbox-message.ts`)
- `enqueue`, `rehydrate`, `isPending`, `isDue(now)`, `markPublished(at)`, `scheduleRetry(now)` com backoff exponencial e teto.
- Usa `Clock` injetável.

### Publicação (`src/application/outbox/outbox-publisher.worker.ts`)
- Loop com intervalo configurável.
- Seleção em lote: `SELECT ... FOR UPDATE SKIP LOCKED` onde `published_at IS NULL AND (next_attempt_at IS NULL OR next_attempt_at <= now)`, `ORDER BY occurred_at, id`, `LIMIT batch`.
- Para cada mensagem: publicar no SQS (porta `EventPublisherPort`, implementação `SqsEventPublisher`) — `MessageId`/`MessageDeduplicationId` = `eventId` quando a fila for FIFO de eventos (definir fila de eventos separada ou tópico; documentar).
- Sucesso → `markPublished`; falha → `scheduleRetry`.
- Commit do lote após marcar cada mensagem.

**Atenção à regra 4 (não publicar antes do commit):** o worker só lê mensagens já commitadas — por construção, pois só processa linhas visíveis após commit do use case.

### Crash entre publicação e marcação
- Se o processo morre após publicar e antes de `markPublished`, a mensagem será republicada: aceitável. Consumidor deduplica por `eventId` (ver Etapa 8).
- Documentar essa semântica (at-least-once) no `ARCHITECTURE.md`.

### Métricas
- `outbox_lag_seconds` (idade do evento pendente mais antigo, via query `MIN(occurred_at)`).
- `outbox_published_total`, `outbox_publish_failed_total`.

### Configuração
- `OUTBOX_BATCH_SIZE`, `OUTBOX_POLL_MS`, `OUTBOX_MAX_BACKOFF_MS`.

## Testes
Unitários:
- `IntegrationEvent` subclasses: `eventType`, `version`, `toJSON` com ISO-8601, `data` com MoneyProps string.
- `WalletBalanceChanged` não é gerado quando saldo não muda (teste de fluxo nas etapas 3–5; reforçar aqui).
- `scheduleRetry` backoff crescente e teto.

Integração (Postgres real + LocalStack SQS):
- Após processar uma BET, a outbox contém o evento na mesma transação; sem commit (forçar erro antes do commit), nenhuma linha de outbox persiste.
- Publisher publica e marca `published_at`.
- Falha simulada do SQS (porta com falha injetada / LocalStack parado) → `attempts` incrementa, `next_attempt_at` no futuro.

Concorrência:
- Dois publishers concorrentes sobre 200 mensagens → cada mensagem marcada exatamente uma vez como publicada; nenhuma publicada por dois workers ao mesmo tempo (verificar por contagem de publicações do fake/spy do SQS, com tolerância apenas para republicação explícita de crash).
- **Crash test:** processo publisher morre após `publish` e antes de `markPublished` (kill via hook de teste); outra instância publica novamente; consumidor (Etapa 8) deduplica — aqui verificar que a mensagem foi republicada com o mesmo `eventId`.

## Critérios de aceite
1. Testes de atomicidade (rollback não deixa outbox órfã) verdes.
2. Dois publishers concorrentes sem duplicação de lote.
3. Crash test demonstra republicação com mesmo `eventId`.
4. `outbox_lag_seconds` exposto.
