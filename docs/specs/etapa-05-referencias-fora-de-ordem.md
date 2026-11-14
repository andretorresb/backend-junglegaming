# Spec — Etapa 5: Referências fora de ordem

## Objetivo
Tratar REFUND e ROLLBACK que chegam antes da transação referenciada, com reprocessamento agendado, backoff, limite e TTL.

## Pré-requisitos
Etapa 4.

## Escopo

### Comportamento na entrada
- Ao processar REFUND/ROLLBACK cuja referência **não existe** em `(providerId, referenceExternalTransactionId)`:
  - persistir a transação como `PENDING_REFERENCE`;
  - `next_attempt_at = now + backoff inicial`; `attempts = 0`;
  - gravar `WagerTransactionPendingReference` na outbox (mesma transação);
  - resposta HTTP `202` com `status: PENDING_REFERENCE` (mapeamento final na Etapa 6; registrar aqui).
- Referência existe mas não está `PROCESSED` → permanece `REJECTED` `REFERENCE_NOT_PROCESSED` (regra da Etapa 4). Não confundir com ausência.

### Worker `PendingReferenceWorker` (`src/application/wagering/pending-reference.worker.ts`)
- Executado por agendador (intervalo configurável, ex.: `PENDING_REFERENCE_POLL_MS`).
- Seleciona lote de transações `PENDING_REFERENCE` com `next_attempt_at <= now`, usando `FOR UPDATE SKIP LOCKED` (múltiplas instâncias não pegam a mesma linha).
- Para cada uma, reexecuta a lógica de aplicação (mesmo use case / mesmas regras da Etapa 4), dentro de transação própria.
- Sucesso (referência agora `PROCESSED`) → status final `PROCESSED`, ledger, eventos.
- Referência ainda ausente → `attempts++`, `next_attempt_at = now + backoff exponencial` (com teto e jitter).

### Limites (definir e documentar)
- **Limite de tentativas:** `MAX_PENDING_REFERENCE_ATTEMPTS` (sugestão: 10).
- **TTL:** `PENDING_REFERENCE_TTL` (sugestão: 24h desde `created_at`).
- Esgotado qualquer um dos dois → `REJECTED` com `REFERENCE_NOT_FOUND`, evento `WagerTransactionRejected` na outbox (mesma transação).
- Justificar valores no `ARCHITECTURE.md`.

### Backoff
- Função pura `nextAttemptDelay(attempts)` com base, fator, teto e jitter; testável sem relógio real (injeção de `Clock`).

### Clock
- Porta `Clock` (`now(): Date`) injetável. Não usar `new Date()` direto na lógica de domínio/worker.

### Observabilidade mínima nesta etapa
- Log estruturado por tentativa (`transactionId`, `attempts`, resultado) — sem payload.

## Testes
Unitários:
- `nextAttemptDelay` cresce exponencialmente e respeita o teto.
- Decisão de esgotamento por tentativas e por TTL.

Integração:
- `ROLLBACK` entregue antes da `BET`: fica `PENDING_REFERENCE`; então `BET` é processada; ao rodar o worker, `ROLLBACK` vira `PROCESSED` com lançamento invertido; rodar o worker de novo não duplica efeito.
- Referência nunca chega → após N tentativas (com clock injetado) → `REJECTED` `REFERENCE_NOT_FOUND` + evento na outbox.
- TTL expirado com tentativas restantes → `REJECTED` `REFERENCE_NOT_FOUND`.
- Dois workers concorrentes sobre o mesmo lote → nenhuma transação processada duas vezes (`SKIP LOCKED`).
- Worker processa lote com uma transação que falha de forma transitória → não bloqueia as demais.

Concorrência:
- Dois workers rodando em paralelo por N ciclos com 50 pendentes → cada pendente resolvida uma única vez; invariante `assertLedgerInvariant`.

## Critérios de aceite
1. Matriz acima verde.
2. Nenhum uso direto de `new Date()` em `src/domain` ou `src/application/wagering`.
3. Limites e backoff documentados no `ARCHITECTURE.md`.
