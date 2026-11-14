# Spec — Etapa 11: Entrega e documentação

## Objetivo
Um avaliador clona o repositório, sobe a infraestrutura e roda os testes seguindo apenas o README. Documentação cobre decisões, trade-offs e limitações.

## Pré-requisitos
Etapas 0 a 10.

## Escopo

### `README.md` (raiz)
- Pré-requisitos: Bun 1.x, Docker, Docker Compose.
- Passo a passo: `bun install`, `docker compose up -d`, `bun run migration:up`, `bun run dev`.
- Comandos de teste: `test:unit`, `test:integration`, `test:concurrency`, `test`.
- Exemplos `curl` para: criar wallet, submeter BET, WIN, LOSS, REFUND, ROLLBACK, consultar ledger, reconciliação, health.
- Como ver métricas e logs.
- Variáveis de ambiente (tabela).

### `ARCHITECTURE.md`
Obrigatório cobrir:
- Visão de componentes (API, workers, Postgres, SQS, LocalStack).
- Escolha do ORM (MikroORM) e mapeamento do `Money` (colunas, reidratação).
- Estratégia de concorrência (lock pessimista por `walletId`) e justificativa vs. optimistic.
- Idempotência: fonte da verdade, algoritmo de `payloadHash` (JSON canônico + SHA-256), replay vs. conflito.
- Taxonomia de `failureCode` (link para `docs/failure-codes.md`).
- Mapeamento HTTP (link para `docs/http-contract.md`).
- Política de referências pendentes: limite de tentativas, TTL, backoff — e justificativa.
- Outbox e inbox: semântica at-least-once, deduplicação, crash recovery.
- Decisão de autenticação e ponto de extensão.
- Transações SQL e o que é atômico.
- Interpretações adicionais adotadas (ex.: reversão com saldo negativo, `Idempotency-Key` divergente do default, criação de wallet sem header).
- **Trade-offs e limitações conhecidas** (ex.: uma única moeda BRL na prática, sem reversão parcial, retenção de inbox/outbox, hot wallet com lock pessimista).

### `docs/failure-codes.md`, `docs/http-contract.md`, `docs/runbook.md`
- Já criados nas etapas anteriores — revisar consistência.

### Revisão contra o enunciado
- Checklist de seção 5 (restrições invioláveis 1–9) com evidência (arquivo/teste).
- Checklist de seção 14 (falhas eliminatórias): `number` para dinheiro, saldo negativo por race, débito duplicado, idempotência só em memória, instância única, publicação antes do commit, ausência de ledger, testes só com mocks.
- Checklist de seção 13 (testes obrigatórios) marcado.

### Diferencial opcional (apenas se houver tempo)
- `bun run test:load` com k6, autocannon ou script próprio.
- Registrar ambiente, metodologia, throughput, p50/p95/p99, taxa de erro, conflitos de concorrência e outbox lag em `docs/load-test.md`.

## Critérios de aceite
1. Clone limpo em diretório novo → seguir README → testes verdes.
2. `ARCHITECTURE.md` cobre todos os itens acima.
3. Checklist das seções 5 e 14 preenchido com evidência.
4. Nenhum segredo versionado (`git grep` por credenciais).
