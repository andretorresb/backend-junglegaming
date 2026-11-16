# Distributed Wagering Processor

Serviço financeiro distribuído que processa transações de apostas de múltiplos provedores de jogos.
Desafio técnico — Jungle Gaming.

> Estado atual: **Etapa 2 (schema e migrations)**. Ver [`ETAPAS.md`](./ETAPAS.md) e [`docs/specs/`](./docs/specs/).

## Pré-requisitos

- [Bun](https://bun.sh) 1.x
- Docker e Docker Compose

## Setup

```bash
cp .env.example .env
bun install
docker compose up -d
bun run dev
```

Verificação:

```bash
curl -s http://localhost:3000/health/live
# {"status":"ok"}
```

## Comandos

| Comando | Descrição |
|---|---|
| `bun run dev` | Sobe a aplicação com recarga automática |
| `bun run start` | Sobe a aplicação sem watch |
| `bun run typecheck` | Checagem de tipos (`tsc --noEmit`) |
| `bun run test` | Executa a suíte de testes |
| `bun run migration:up` | Aplica migrations pendentes |
| `bun run migration:down` | Reverte a última migration |
| `bun run migration:reset` | Reverte todas as migrations |
| `bun run migration:status` | Lista migrations executadas e pendentes |
| `bun run localstack:init` | Cria as filas no LocalStack (`wager-transactions.fifo`, DLQ e `wager-events`) |
| `bun run test:integration` | Testes de schema e mapeamento (exige Postgres; usa o banco `junglegaming_test`) |

## Documentação

- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — decisões, trade-offs e limitações.
- [`ETAPAS.md`](./ETAPAS.md) — plano de execução em etapas.
- [`docs/specs/`](./docs/specs/) — specs por etapa.
