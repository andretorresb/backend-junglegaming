# Spec — Etapa 9: Observabilidade

## Objetivo
Diagnóstico operacional com logs estruturados sem dados financeiros sensíveis, métricas obrigatórias e health checks revisados.

## Pré-requisitos
Etapas 6 a 8.

## Escopo

### Logs estruturados (`src/infrastructure/logging/`)
- Biblioteca: `pino` (ou logger NestJS com formatter JSON). Uma escolha, documentada.
- Campos padrão em todo log: `level`, `time`, `service`, `correlationId`.
- Campos contextuais quando disponíveis: `messageId`, `transactionId`, `walletId`, `providerId`.
- `correlationId`: vem do header `X-Correlation-Id` ou é gerado; propagado para eventos (`IntegrationEvent.correlationId`) e logs de workers.
- Proibido: payload financeiro completo, `amount` em logs de processamento (usar apenas IDs e `failureCode`), dados de identidade do jogador além do `playerId` se necessário (preferir hash ou omitir).
- Serializer/redactor para chaves sensíveis (`authorization`, `money`, `payload`).

### Métricas (`src/infrastructure/metrics/`)
- Biblioteca: `prom-client` com endpoint `GET /metrics` (protegido ou porta separada — documentar; não exigir auth nos health).
- Métricas obrigatórias:
  - `wagering_transactions_total{kind,status}`
  - `duplicates_detected_total{source}`
  - `retries_total{component}` (outbox, pending-reference, sqs)
  - `dlq_messages_total`
  - `lock_conflicts_total` (timeouts/erros de lock na wallet)
  - `outbox_lag_seconds` (gauge)
  - `processing_latency_seconds` (histograma, label `source`)
  - `reconciliation_divergence_total`
- Instrumentação feita nos pontos de decisão (use case, consumidor, workers), não em controllers.

### Health checks
- Revisar Etapa 6: `ready` deve refletir Postgres, SQS e estado de shutdown.
- Adicionar `GET /health/workers` opcional (último ciclo de cada worker) — opcional.

### Diagnóstico
- Runbook curto em `docs/runbook.md`: como ver duplicatas, DLQ, outbox lag, divergências.

## Testes
- Unitário: redactor remove campos sensíveis.
- Integração: requisição HTTP gera log JSON com `correlationId` e `transactionId`; nenhum log contém `amount` nem o body completo.
- Integração: BET duplicada incrementa `duplicates_detected_total`; `wagering_transactions_total` reflete status.
- Integração: `/metrics` expõe todas as métricas obrigatórias (teste de presença de nome).

## Critérios de aceite
1. Logs JSON verificados em um request real (saída capturada no teste).
2. Todas as métricas obrigatórias presentes em `/metrics`.
3. Teste comprova ausência de payload financeiro nos logs.
4. `docs/runbook.md` criado.
