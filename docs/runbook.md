# Runbook de operação

Como diagnosticar os sintomas mais comuns. Todos os sinais estão em `GET /metrics` e nos logs JSON
(filtre por `event` e `service`).

## Duplicatas
- **Métrica:** `duplicates_detected_total{source}`. Um aumento é esperado com redelivery do SQS e replays do provedor.
- **Verificar:** eventos `message_duplicate` (SQS) e `transaction_decided` com `idempotentReplay: true`.
- **Atenção se:** o crescimento não bater com as reentregas. Uma duplicata que virou efeito duplicado é falha eliminatória. A invariante é `wallet.balance == soma do ledger` (`POST /wallets/:id/reconciliation`).

## DLQ (`wager-transactions-dlq.fifo`)
- **Métrica:** `dlq_messages_total`.
- **Ver a mensagem:** atributo `reason` e `originalMessageId` na mensagem da DLQ.
- **Motivos típicos:** `corpo não é JSON`, `schema inválido`, `OPENING` recebido, wallet inexistente, `limite de tentativas atingido`.
- **Ação:** corrija a causa (payload do provedor, criação da wallet) e reenvie a mensagem para `wager-transactions.fifo`. A inbox impede o efeito duplicado se ela já tiver sido processada.

## Retries e erros transitórios
- **Métrica:** `retries_total{component}`, `lock_conflicts_total`.
- **Logs:** `message_retry`, `outbox_publish_failed`, `pending_reference_attempt` com `outcome: "rescheduled"`.
- **`lock_conflicts_total` alto:** wallet quente (muitas operações no mesmo jogador). Confira `processing_latency_seconds{source="http"}`.

## Outbox
- **Lag:** `outbox_lag_seconds`. Lag crescente indica que o publisher parou ou que o SQS está inacessível. Confira `/health/ready` e `outbox_publish_failed_total`.
- **Publicação:** eventos `outbox_publish_failed` mostram `attempts` e `nextAttemptAt`.
- **Duplicidade na fila de eventos é esperada** após falha entre publicar e marcar. Consumidores deduplicam pelo `eventId`.

## Referências pendentes
- **Logs:** `pending_reference_attempt` (`outcome`: `rescheduled`, `resolved`, `rejected`, `expired`).
- **`expired`:** a referência nunca chegou no limite de tentativas ou no TTL. A transação fica `REJECTED` com `REFERENCE_NOT_FOUND`.

## Divergências de reconciliação
- **Métrica:** `reconciliation_divergence_total`. Qualquer valor acima de zero exige investigação.
- **Log:** `reconciliation_divergence` com `walletId`, saldo armazenado e calculado.
- **Nada é corrigido automaticamente.** A correção é uma decisão operacional.

## Shutdown e readiness
- **SIGTERM:** o consumidor para de receber, espera `SHUTDOWN_GRACE_MS` e devolve o que sobrar à fila.
- **Durante o drain:** `/health/ready` responde 503 com `checks.draining = "down"`. Balanceadores tiram o processo da rotação.
- **Mensagens devolvidas** ficam visíveis de novo para outra instância. Nenhuma é perdida.
