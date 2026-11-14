# Spec — Etapa 8: Consumidor SQS (FIFO, inbox, DLQ, shutdown)

## Objetivo
Processar `wager-transactions.fifo` com redelivery seguro, reutilizando o use case da HTTP, deduplicação por inbox persistente e tratamento de erros em três classes.

## Pré-requisitos
Etapas 3, 5 e 7.

## Escopo

### Infraestrutura local
- Script `scripts/localstack/init-queues.sh` (ou equivalente) que cria:
  - `wager-transactions.fifo` (com `ContentBasedDeduplication` desligado; deduplicação real é do banco)
  - `wager-transactions-dlq.fifo`
  - `RedrivePolicy` com `maxReceiveCount` configurável (ex.: 5).
- Executado no `docker compose` (serviço de init) ou via `bun run localstack:init`.

### Formato de mensagem
- Conforme seção 10 do enunciado: `messageId`, `type: WagerTransactionRequested`, `occurredAt`, `data`.
- Validação de schema (DTO/zod-like) antes de chamar o use case. Schema inválido → erro **permanente** → DLQ.
- Identidade do provedor no `data` sujeita às mesmas validações de domínio (regra da seção 2).

### Consumidor (`src/interfaces/messaging/sqs/wager-transactions.consumer.ts`)
- `ReceiveMessage` com long polling (`WaitTimeSeconds`), `MaxNumberOfMessages` configurável.
- Para cada mensagem, em transação única (`em.transactional`):
  1. Inserir em `inbox_messages (consumer_name, message_id)` com `payload_hash`. Conflito de PK → **duplicata**: incrementar métrica `duplicates_detected_total`, confirmar (ack) se já processada, senão tratar como em andamento (não ack).
  2. Chamar `ProcessWagerTransaction` (mesmo use case da HTTP) com `source: 'SQS'`.
  3. Marcar `inbox.markProcessed`.
  4. Commit.
- **Ack (`DeleteMessage`) somente após o commit** da transação acima.

### Classificação de erros
| Classe | Exemplos | Ação |
|---|---|---|
| Negócio | `REJECTED` (saldo, referência, moeda) | commit do resultado + ack |
| Transitória | Postgres/lock timeout, SQS indisponível | não ack; visibility timeout → retry com backoff |
| Permanente | schema inválido, `OPENING` recebido, esgotou `maxReceiveCount` | enviar à DLQ (SQS faz via redrive ou envio explícito) e ack da original |

- Erro transitório dentro da transação → rollback completo (inclusive inbox).
- Contador de `ApproximateReceiveCount` para decidir DLQ quando aplicável.

### Ordenação e FIFO
- `MessageGroupId = walletId` para paralelismo entre wallets.
- FIFO **não** é garantia de consistência: banco continua decidindo (regra da seção 8).

### Shutdown (`SIGTERM`)
- Ao receber SIGTERM: parar `ReceiveMessage`; aguardar mensagens em processamento até timeout (`SHUTDOWN_GRACE_MS`); mensagens não concluídas → `ChangeMessageVisibility(0)` para devolver.
- Só depois fechar pool de conexões do ORM e SQS client.
- Health `ready` deve refletir o estado de shutdown (retornar 503 durante drenagem).

### Métricas
- `sqs_messages_received_total`, `sqs_messages_acked_total`, `dlq_messages_total`, `duplicates_detected_total`, `retries_total`, `processing_latency_seconds`.

## Testes
Integração com LocalStack SQS real + Postgres real:
- Mensagem válida → processada, ack, ledger e outbox gravados.
- Mesma mensagem entregue duas vezes (redelivery forçado) → um único efeito; segunda é duplicata.
- Mensagem com schema inválido → DLQ.
- Erro transitório simulado (Postgres indisponível por pequeno intervalo ou falha injetada no repositório) → sem ack, reentregue, depois processada.
- Worker morto **depois do commit e antes do ack** (kill do processo ou falha injetada após commit) → redelivery não duplica (inbox bloqueia).
- Mensagem excede `maxReceiveCount` → DLQ.
- SIGTERM durante processamento → mensagem em andamento concluída ou devolvida (`visibility = 0`); nenhuma perda.
- `OPENING` via fila → erro permanente → DLQ.

Concorrência:
- Duas instâncias do consumidor consumindo a mesma fila com mensagens de várias wallets → invariante `assertLedgerInvariant` por wallet.

## Critérios de aceite
1. Matriz de testes verde com LocalStack real (sem mock de SQS).
2. Nenhum ack antes do commit (verificar por teste que força falha após commit).
3. DLQ recebe mensagens permanentes.
4. Shutdown documentado e testado.
