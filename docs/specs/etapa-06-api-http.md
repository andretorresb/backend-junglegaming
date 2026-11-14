# Spec — Etapa 6: API HTTP completa

## Objetivo
Contratos HTTP completos, códigos de status consistentes em todos os endpoints, consultas paginadas, reconciliação e health checks reais.

## Pré-requisitos
Etapas 3, 4 e 5.

## Escopo

### Mapeamento de respostas (aplicado de forma uniforme por um filtro global)
| Situação | HTTP | Corpo |
|---|---|---|
| Payload inválido / header ausente | 400 | `{ code: "INVALID_PAYLOAD", message, details? }` |
| Não encontrado (wallet/transação) | 404 | `{ code: "NOT_FOUND" }` |
| Conflito de idempotência | 409 | `{ code: "IDEMPOTENCY_CONFLICT" }` |
| Wallet duplicada | 409 | `{ code: "DUPLICATE_WALLET" }` |
| Rejeição de regra de negócio | 422 | `{ status: "REJECTED", failureCode, transactionId, balance? }` |
| Aceito, processamento pendente | 202 | `{ status: "PENDING_REFERENCE", transactionId }` |
| Processado | 200 (ou 201 em criação de wallet) | `{ transactionId, status, balance, idempotentReplay }` |
| Falha transitória de infra (DB/lock timeout/SQS) | 503 + `Retry-After` | `{ code: "TRANSIENT_UNAVAILABLE" }` |
| Erro inesperado | 500 | `{ code: "INTERNAL_ERROR" }` (sem stack no corpo) |

- Documentar a tabela no `ARCHITECTURE.md` e em `docs/http-contract.md`.
- Corpo de erro segue o mesmo formato sempre.

### Consultas
- `GET /wallets/:walletId` → `{ id, playerId, currency, balance, version, updatedAt }`.
- `GET /wallets/:walletId/ledger?cursor=...&limit=50`
  - Paginação keyset sobre `(created_at, id)`.
  - Cursor **opaco**: base64url de JSON assinado ou não; documentar. Cursor inválido → 400.
  - `limit` entre 1 e 100 (default 50).
  - Resposta: `{ items: [...], nextCursor: string | null }`.
- `GET /wagering/transactions/:id` e `GET /providers/:providerId/wagering/transactions/:externalTransactionId` — já criados na Etapa 3; revisar contrato aqui.

### Reconciliação — `POST /wallets/:walletId/reconciliation`
- Body: `{ walletId, storedBalance, calculatedBalance, difference, consistent, checkedEntries }` conforme enunciado — **mas o servidor calcula**: o cliente não envia saldos.
  - Ler `wallet.balance` (armazenado).
  - Somar ledger (`SUM` com sinal por direção) → `calculatedBalance`.
  - `difference = stored - calculated`; `consistent = difference == 0`; `checkedEntries = count`.
- Divergência: logar `level=error` com `walletId`, métrica `reconciliation_divergence_total` +1, e retornar `200` com `consistent: false` (não corrigir).
- Se o endpoint aceitar body opcional, ignorar campos de saldo enviados pelo cliente (documentar).
- Lock: ler com snapshot consistente (transação `REPEATABLE READ` ou `READ COMMITTED` com leitura única — justificar).

### Health
- `GET /health/live` → 200 sem IO.
- `GET /health/ready` → verifica Postgres (`SELECT 1`) e SQS (`GetQueueAttributes`) com timeout curto. Falha → 503 com detalhes por dependência.
- Ambos **sem autenticação**.

### Autenticação
- Aplicar o mecanismo decidido na Etapa 0 em todos os endpoints de negócio.
- Se for `AuthGuard` no-op: ponto de extensão explícito, documentado.
- Health fora do guard.

### Validação
- DTOs com `class-validator`; `ValidationPipe` global com `whitelist` e `forbidNonWhitelisted`.
- Valores monetários validados pelo `Money.fromInput` (Etapa 1).

## Testes
- Contrato (e2e HTTP com Postgres real) — um teste por linha da tabela acima.
- Ledger: paginação percorre todos os itens sem duplicar nem pular, mesmo com inserções concorrentes entre páginas.
- Cursor adulterado → 400.
- Reconciliação: consistente → `consistent: true`; forçar divergência via SQL direto no ambiente de teste (ex.: UPDATE no balance desabilitando trigger apenas em teste? **Não** — usar wallet com ledger inconsistente criado por fixture controlada, documentando) → `consistent: false`, métrica incrementada.
- `ready` com Postgres derrubado → 503 (ex.: parar o container em teste dedicado ou usar pool com host inválido).

## Critérios de aceite
1. Um teste de contrato por código de status da tabela.
2. Health sem auth; ready retorna 503 quando dependência cai.
3. Paginação estável verificada.
4. `docs/http-contract.md` e `ARCHITECTURE.md` atualizados.
