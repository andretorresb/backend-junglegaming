# Plano de execução em etapas — Distributed Wagering Processor

Plano derivado do enunciado (`/Users/andretorresdacruz/Downloads/backend-challenge-main/README.md`).
Cada etapa termina com um **critério de aceite verificável** e um commit próprio.
A ordem segue a dependência técnica: domínio → banco → núcleo financeiro → referências → API → mensageria → testes de concorrência → entrega.

Regra transversal: nenhuma etapa avança com `number` para dinheiro, cache em memória como idempotência ou publicação antes do commit (seção 5 do enunciado).

---

## Etapa 0 — Fundação do projeto
**Objetivo:** projeto rodando, tipado em modo estrito e com infraestrutura local.

- Bun 1.x como runtime, package manager e test runner (`bun test`).
- NestJS + TypeScript com `"strict": true`.
- ORM: **MikroORM** (preferencial) — registrar a escolha no `ARCHITECTURE.md`.
- `docker-compose.yml` com PostgreSQL e LocalStack (ou MiniStack).
- Scripts: `bun run dev`, `bun run test`, `bun run test:integration`, `bun run migration:*`.
- Esqueleto de `ARCHITECTURE.md` (decisões, trade-offs, limitações) e `README.md` com setup.
- Decisão de autenticação (seção 2) registrada: ou IdP (Keycloak/Zitadel) ou `AuthGuard` no-op + `ProviderIdentityPort`.

**Aceite:** `docker compose up -d` sobe Postgres e LocalStack; `bun run dev` responde em `GET /health/live`.

---

## Etapa 1 — Domínio puro (sem NestJS, sem ORM)
**Objetivo:** invariantes encapsuladas em classes testáveis de forma isolada.

- `Money`: string decimal com escala fixa de 2, imutável, operações entre moedas diferentes lançam erro de domínio. Usar biblioteca decimal (ex.: `decimal.js` ou `big.js`) — nunca `number`.
  - Rejeitar: `NaN`, `Infinity`, notação científica, string vazia, mais de 2 casas, valores negativos em contrato de entrada.
- `Wallet`: `open`, `rehydrate`, `debit`, `credit`; `version` começa em 1 e só incrementa quando o saldo muda; saldo nunca negativo; moeda da operação = moeda da wallet.
- `WagerTransaction`: enums de `kind` e `status`; máquina de estados com `PROCESSED`, `REJECTED`, `FAILED` terminais; `OPENING` interno; `requiresReference()`, `affectsBalance()`, `matchesPayload()`.
- `WalletLedgerEntry`: imutável, sem métodos de transição; `create` valida `before ± money === after`.
- `FailureCode`: taxonomia estável e documentada (ex.: `INSUFFICIENT_BALANCE`, `REFERENCE_NOT_FOUND`, `NEGATIVE_BALANCE_ON_REVERSAL`, `CURRENCY_MISMATCH`, `INVALID_PAYLOAD`).
- Hash de payload: JSON canônico (chaves ordenadas) de um subconjunto de campos de negócio, SHA-256. Documentar o algoritmo.

**Testes unitários obrigatórios:** escala/arredondamento/entradas inválidas de `Money`; invariantes da `Wallet`; transições proibidas em estados terminais; conflito de moeda; payload divergente.

**Aceite:** `bun test` verde só com testes unitários, sem dependências externas.

---

## Etapa 2 — Schema e migrations
**Objetivo:** as garantias da seção 6 vivem no banco, não só no código.

Migrations versionadas e **reversíveis** (`up` e `down`) para:

- `wallets`: `UNIQUE (player_id, currency)`; `CHECK (balance >= 0)`; `version >= 1`.
- `wager_transactions`: `UNIQUE (provider_id, external_transaction_id)`; `UNIQUE (idempotency_key)`; `CHECK` de status válido; índice por `(wallet_id)` e `(provider_id, reference_external_transaction_id)`.
- `wallet_ledger_entries`: colunas `amount` (NUMERIC com escala 2) e `currency`; `CHECK (direction IN ('DEBIT','CREDIT'))`; `UNIQUE (wallet_id, transaction_id)` (no máximo um lançamento por wallet por transação); **trigger que bloqueia `UPDATE` e `DELETE`** (imutabilidade no banco).
- `inbox_messages`: `PRIMARY KEY (consumer_name, message_id)`.
- `outbox_messages`: índice parcial em `published_at IS NULL` com `next_attempt_at`.

**Aceite:** teste de integração com Postgres real provando que `UPDATE`/`DELETE` no ledger falha, que a duplicidade de wallet falha e que `down` reverte sem erro.

---

## Etapa 3 — Núcleo financeiro: BET, WIN, LOSS e idempotência
**Objetivo:** o caminho feliz correto, com concorrência e idempotência persistente.

- Use case único `ProcessWagerTransaction` (reutilizado depois pela fila).
- Transação SQL única: persistir a transação → adquirir lock da wallet → validar → alterar saldo → gravar ledger → gravar outbox.
- Estratégia de concorrência por `walletId` (escolha justificada no `ARCHITECTURE.md`): recomendado `SELECT ... FOR UPDATE` na linha da wallet, com ordem determinística de locks quando houver mais de uma wallet. Não usar lock global.
- Idempotência: chave `Idempotency-Key` persistida com constraint única; mesma chave + mesmo hash → replay com `idempotentReplay: true` e resultado original (incluindo saldo daquele momento); mesma chave + hash diferente → conflito.
- `LOSS` não altera saldo e não gera ledger, mas emite `WagerTransactionProcessed`.
- Endpoint `POST /wagering/transactions` (controller fino, lógica no use case).
- Endpoints de consulta: `GET /wagering/transactions/:id`, `GET /providers/:providerId/wagering/transactions/:externalTransactionId`.

**Aceite:** teste de concorrência com 50 requisições paralelas da mesma aposta → 1 débito. Teste de duas apostas de 80.00 em wallet de 100.00 em paralelo → 1 `PROCESSED`, 1 `REJECTED` (`INSUFFICIENT_BALANCE`), saldo final 20.00, 1 linha de débito no ledger.

---

## Etapa 4 — Criação de wallet e reversões
**Objetivo:** completar as regras de negócio da seção 7.

- `POST /wallets`: saldo inicial > 0 gera `OPENING` e lançamento `CREDIT` **na mesma transação SQL**. Duplicidade `playerId + currency` → 409.
- `REFUND`: referencia apenas `BET` `PROCESSED`, uma única vez, valor igual ao da referência.
- `ROLLBACK`: referencia `BET`, `WIN` ou `REFUND`, uma única vez, valor igual, lançamento invertido.
- Validar que a referência pertence ao mesmo `providerId`, `playerId`, `walletId`, moeda e `roundId`.
- Reversão que geraria saldo negativo → `REJECTED` com `failureCode` **distinto** de aposta sem saldo, auditável.
- Decidir e documentar: o que acontece com reversão de `WIN` cujo saldo já foi gasto (vira `NEGATIVE_BALANCE_ON_REVERSAL`).

**Aceite:** testes unitários e de integração para cada combinação válida e inválida de `kind` × referência × status.

---

## Etapa 5 — Referências fora de ordem
**Objetivo:** tratar `REFUND`/`ROLLBACK` que chegam antes da `BET`.

- Referência ausente → persistir como `PENDING_REFERENCE` e publicar `WagerTransactionPendingReference` (evento vai para outbox).
- Worker agendado (`@nestjs/schedule` ou loop próprio) que reprocessa `PENDING_REFERENCE` com **backoff exponencial**.
- Limite de tentativas **e** TTL, ambos documentados e justificados.
- Esgotado → `REJECTED` com `REFERENCE_NOT_FOUND`, evento `WagerTransactionRejected` publicado.
- Seleção dos pendentes com `FOR UPDATE SKIP LOCKED` para múltiplas instâncias.

**Aceite:** teste em que `ROLLBACK` chega antes de `BET` e, após a `BET` ser processada, o worker resolve o `ROLLBACK` sem duplicar efeito.

---

## Etapa 6 — API HTTP completa
**Objetivo:** contratos claros e códigos HTTP consistentes.

- Mapeamento (documentar no `ARCHITECTURE.md`):
  - `400` payload inválido;
  - `409` conflito de idempotência / wallet duplicada;
  - `422` rejeição por regra de negócio (ex.: saldo insuficiente), com corpo contendo `failureCode`;
  - `202` aceito com processamento pendente (`PENDING_REFERENCE`);
  - `503` falha transitória de infraestrutura (com `Retry-After`).
- `GET /wallets/:walletId` e `GET /wallets/:walletId/ledger?cursor=&limit=` com **cursor opaco e estável** (keyset sobre `(created_at, id)`).
- `POST /wallets/:walletId/reconciliation`: recalcula saldo pelo ledger; divergência é logada, contabilizada em métrica e sinalizada na resposta (nunca corrigida silenciosamente).
- `GET /health/live` (sem IO) e `GET /health/ready` (Postgres + SQS), **sem autenticação**.
- Validação de DTO (ex.: `class-validator`) e filtro global de exceções mapeando erros de domínio → HTTP.
- Autenticação: aplicar o mecanismo escolhido na Etapa 0 (IdP ou `AuthGuard` no-op) nos endpoints de negócio.

**Aceite:** teste de contrato para cada código de status; `ready` retorna 503 quando o Postgres é derrubado.

---

## Etapa 7 — Transactional Outbox
**Objetivo:** eventos publicados somente após commit, sem perda, com múltiplos publishers.

- `IntegrationEvent<T>` abstrato + subclasses concretas (`WagerTransactionProcessed`, `WagerTransactionRejected`, `WalletBalanceChanged` — **só quando o saldo muda** —, `WagerTransactionPendingReference`).
- `OutboxMessage.enqueue` gravado na mesma transação da alteração financeira.
- Publisher worker: `SELECT ... FOR UPDATE SKIP LOCKED` em lote, publica no SQS, marca `published_at`; falha → `scheduleRetry` com backoff.
- Garantir que publicação duplicada é segura: `eventId` estável; consumidor deduplica.
- Métrica de **outbox lag** (idade do evento pendente mais antigo).

**Aceite:** teste com dois publishers concorrentes sobre a mesma outbox → cada evento publicado ao menos uma vez e nenhum lote processado por dois ao mesmo tempo. Teste de crash: processo morre entre commit e publicação → outra instância publica.

---

## Etapa 8 — Consumidor SQS (FIFO, inbox, DLQ)
**Objetivo:** processar `wager-transactions.fifo` com redelivery seguro.

- Filas `wager-transactions.fifo` e `wager-transactions-dlq.fifo` criadas via script no LocalStack.
- Consumidor chama **o mesmo use case** da HTTP.
- Deduplicação por inbox persistente `(consumerName, messageId)` **dentro** da transação de negócio.
- `ack` somente após commit.
- Classificação de erros:
  - negócio → terminal, `ack`;
  - transitório → não `ack`, retry com backoff (visibility timeout);
  - permanente / excedeu tentativas → DLQ.
- `SIGTERM`: parar de receber, concluir mensagens em andamento ou devolver visibilidade, depois fechar conexões.
- Não confiar em FIFO como garantia: o banco é a fonte da verdade.

**Aceite:** mensagem entregue duas vezes → um único efeito. Worker morto após commit e antes do ack → redelivery não duplica. Mensagem com erro permanente → DLQ após N tentativas.

---

## Etapa 9 — Observabilidade
**Objetivo:** diagnóstico sem vazar dados financeiros.

- Logs JSON estruturados com `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`.
- Proibido logar payload financeiro completo.
- Métricas mínimas: transações por status, duplicatas detectadas, retries, mensagens em DLQ, conflitos de lock, outbox lag, latência de processamento, divergências de reconciliação.
- Health checks já cobertos na Etapa 6; revisar se refletem o estado real.
- OpenTelemetry e dashboard: opcionais, só se sobrar tempo.

**Aceite:** demonstração (log/endpoint de métricas) de que uma duplicata aparece na métrica e que o log não contém o payload.

---

## Etapa 10 — Testes de integração e concorrência
**Objetivo:** provar as garantias com paralelismo real, sem substituir Postgres/SQS por mocks.

Integração (containers reais):
- migrations e constraints; atomicidade wallet+ledger+inbox+outbox; redelivery; publishers concorrentes; retry e DLQ; recuperação após reinício.

Concorrência:
1. mesma aposta 50× em paralelo → um débito;
2. disputa de saldo (cenário da seção 8);
3. wallets distintas em paralelo;
4. **≥ 3 processos/instâncias** simultâneos (subir a aplicação 3× e disparar carga);
5. worker morto depois do commit e antes do ack;
6. dois publishers sobre a mesma outbox;
7. `ROLLBACK`/`REFUND` antes da referência;
8. reinício com verificação de consistência final.

**Invariante final em todos os testes:** `wallet.balance == soma reconstruída pelo ledger`. Implementar como helper reutilizável chamado ao final de cada teste.

**Aceite:** `bun run test:integration` e `bun run test:concurrency` verdes; nenhuma suíte usa mock de Postgres ou SQS.

---

## Etapa 11 — Entrega e documentação
**Objetivo:** o avaliador consegue subir e entender tudo sem perguntar.

- `README.md`: pré-requisitos, `docker compose up`, migrations, seed, comandos de teste, exemplos `curl` dos fluxos principais.
- `ARCHITECTURE.md`: escolha do ORM e mapeamento do `Money`; estratégia de lock e justificativa; idempotência e algoritmo de hash; taxonomia de `failureCode`; mapeamento HTTP; política de referências pendentes (limite/TTL); outbox e inbox; decisão de auth; trade-offs e **limitações conhecidas**.
- Diferencial opcional: `bun run test:load` com ambiente, metodologia, throughput, p50/p95/p99, taxa de erro, conflitos e outbox lag — só se houver tempo.
- Revisão final contra a tabela de avaliação (seção 14) e contra as falhas eliminatórias.

**Aceite:** um clone limpo + `docker compose up` + comandos do README chega a testes verdes.

---

## Ordem sugerida e checkpoints

| Etapa | Foco | Checkpoint de risco |
|---|---|---|
| 0 | Fundação | ambiente sobe |
| 1 | Domínio | `Money` e `Wallet` testados antes de qualquer IO |
| 2 | Schema | constraints provadas no Postgres real |
| 3 | Núcleo | race de 80+80 em 100 passa |
| 4–5 | Regras e referências | ordem invertida resolvida |
| 6 | HTTP | códigos consistentes |
| 7–8 | Outbox e SQS | crash recovery |
| 9–10 | Observabilidade e testes | invariante final em todos os testes |
| 11 | Entrega | clone limpo funciona |

Se o tempo apertar, a prioridade de corte é: **diferenciais → observabilidade avançada → autenticação real (manter o ponto de extensão)**. Nunca cortar: Etapas 1–3, 7 e as garantias de concorrência da 10.
