# Spec — Etapa 0: Fundação

## Objetivo
Projeto NestJS rodando com Bun, TypeScript estrito, ORM configurado e infraestrutura local (Postgres + LocalStack) sobe com `docker compose`.

## Escopo
- Inicialização com Bun 1.x (`bun install`, `bun run`, `bun test`).
- NestJS + TypeScript com `"strict": true`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`.
- MikroORM configurado (PostgreSQL driver) — sem entidades de negócio ainda.
- `docker-compose.yml`: serviço `postgres` (versão 16) e `localstack` (SQS habilitado).
- `.env.example` com variáveis de conexão.
- Endpoint `GET /health/live` (sem IO, sem auth).
- Scripts em `package.json`: `dev`, `build`, `test`, `test:integration`, `typecheck`, `lint` (se aplicável).
- `ARCHITECTURE.md` com esqueleto e a decisão de ORM (MikroORM) e de autenticação (pendente, a registrar).
- `README.md` do projeto com setup.
- `.gitignore` (node_modules, dist, .env).

## Fora de escopo
- Entidades, migrations de negócio, regras de domínio.
- Autenticação efetiva.

## Decisões a registrar em `ARCHITECTURE.md`
- MikroORM como ORM (preferencial do enunciado) e motivo.
- Auth: decisão preliminar (IdP ou no-op + porta) — pode ficar marcada como "a definir até a Etapa 6".

## Critérios de aceite
1. `bun install` sem erros.
2. `bun run typecheck` sem erros.
3. `docker compose up -d` sobe Postgres e LocalStack saudáveis (healthcheck definido).
4. `bun run dev` sobe a aplicação e `GET /health/live` responde `200` com `{ "status": "ok" }`.
5. `bun test` roda (pode ter zero testes, mas sai com código 0).
6. Clone limpo + comandos do README chega ao passo 4.

## Notas
- Porta da aplicação via `PORT` (padrão 3000).
- Nenhuma credencial real versionada.
