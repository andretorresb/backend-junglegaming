# Spec — Etapa 10: Testes de integração e concorrência

## Objetivo
Provar as garantias do enunciado com infraestrutura real (PostgreSQL e SQS), paralelismo real e processos separados. Nenhum mock substitui Postgres ou SQS.

## Pré-requisitos
Etapas 0 a 9.

## Escopo

### Infraestrutura de teste
- Decidir: Docker Compose de teste (`docker-compose.test.yml`) **ou** Testcontainers. Documentar a escolha. Recomendação: Compose + banco dedicado (`junglegaming_test`) para simplicidade e reprodutibilidade.
- Setup por suíte: migrations `up` em banco limpo; `truncate` entre testes (ou schema por suíte).
- Scripts:
  - `bun run test:unit`
  - `bun run test:integration`
  - `bun run test:concurrency`
  - `bun run test` = unit + integration + concurrency (ou alias documentado).

### Helper obrigatório `assertLedgerInvariant(walletId)`
- `wallet.balance == SUM(ledger com sinal)`.
- Chamado ao final de **todo** teste que altera saldo.

### Processos separados para ≥ 3 instâncias
- Script que sobe 3 processos da aplicação (ou workers) apontando para o mesmo banco e fila (`Bun.spawn`).
- Disparo de carga concorrente distribuído entre as instâncias via HTTP.

### Matriz de integração (`test/integration/`)
- Migrations e constraints (já na Etapa 2 — linkar).
- Atomicidade wallet + ledger + inbox + outbox (forçar falha em cada etapa do commit e verificar rollback completo).
- Inbox e redelivery.
- Publishers concorrentes sobre a mesma outbox.
- Retry e DLQ.
- Recuperação após reinicialização: parar app, reiniciar, verificar consistência final e que pendentes continuam sendo processados.

### Matriz de concorrência (`test/concurrency/`)
1. Mesma aposta 50× em paralelo → 1 débito.
2. Disputa de saldo: 100.00, duas BETs de 80.00 → 1 PROCESSED, 1 REJECTED, saldo 20.00, 1 débito.
3. Wallets distintas em paralelo → cada uma consistente; sem erro de lock global.
4. ≥ 3 processos simultâneos → invariante por wallet.
5. Worker morto depois do commit e antes do ack → redelivery não duplica.
6. Dois publishers sobre a mesma outbox → sem perda, sem duplicação de lote.
7. ROLLBACK/REFUND antes da referência → resolvido sem duplicar.
8. Reinício do serviço com verificação de consistência final.

### Determinismo
- Clock injetado em todos os testes que dependem de tempo.
- Sem `sleep` fixo: esperar condição com timeout (`waitFor(predicate, timeout)`).
- Sementes/IDs determinísticos quando possível (UUIDv7 gerado por factory de teste).
- Teste repetido N vezes em CI local (`bun run test:concurrency --repeat 5`) sem flaky.

## Critérios de aceite
1. `bun run test` verde.
2. Os 8 cenários de concorrência existem e passam.
3. Nenhum teste de integração ou concorrência usa mock de Postgres ou SQS (verificar com grep).
4. Repetição de 5 execuções da suíte de concorrência sem falha intermitente.
5. `assertLedgerInvariant` presente nos testes que mudam saldo.
