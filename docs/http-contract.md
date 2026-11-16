# Contrato HTTP

Todas as respostas de erro têm o formato `{ code, failureCode?, message? }`. Rejeições de negócio
sempre trazem `failureCode` (ver `docs/failure-codes.md`).

## Status por situação

| Situação | HTTP | Corpo |
|---|---|---|
| Processado (transação ou reversão) | 200 | `{ transactionId, status: "PROCESSED", balance, failureCode: null, idempotentReplay }` |
| Wallet criada | 201 | `{ id, playerId, balance, version }` |
| Aguardando referência | 202 | `{ transactionId, status: "PENDING_REFERENCE", balance, failureCode: null, idempotentReplay }` |
| Rejeição de regra de negócio | 422 | `{ transactionId, status: "REJECTED", balance, failureCode, idempotentReplay }` |
| Payload inválido, header ausente, cursor ou limit inválido, `OPENING` submetido | 400 | `{ code: "INVALID_PAYLOAD" \| "INTERNAL_ONLY_KIND", message }` |
| Não encontrado (wallet, transação) | 404 | `{ code: "NOT_FOUND" \| "WALLET_NOT_FOUND", message }` |
| Conflito de idempotência ou wallet duplicada | 409 | `{ code: "IDEMPOTENCY_CONFLICT" \| "DUPLICATE_WALLET", failureCode, message }` |
| Falha transitória (lock, deadlock, conexão) | 503 + `Retry-After: 1` | `{ code: "TRANSIENT_UNAVAILABLE", message }` |
| Health `ready` com dependência fora | 503 | `{ status: "down", checks: { postgres, sqs, draining } }`. O motivo do erro vai para o log (`readiness_check_failed`), não para a resposta |
| Erro inesperado | 500 | `{ code: "INTERNAL_ERROR" }` (sem stack no corpo) |

## Endpoints

| Método e rota | Descrição |
|---|---|
| `POST /wallets` | Cria wallet. Saldo inicial > 0 gera OPENING e lançamento CREDIT. |
| `GET /wallets/:walletId` | Saldo, versão e última atualização. |
| `GET /wallets/:walletId/ledger?cursor=&limit=` | Ledger em ordem cronológica. `limit` de 1 a 100 (padrão 50). `nextCursor` é `null` na última página. |
| `POST /wallets/:walletId/reconciliation` | Compara saldo armazenado com o ledger. Ignora saldos enviados pelo cliente. |
| `POST /wagering/transactions` | Submete BET, WIN, LOSS, REFUND ou ROLLBACK. Exige `Idempotency-Key`. |
| `GET /wagering/transactions/:transactionId` | Transação por id interno. |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | Transação por id do provedor. |
| `GET /health/live` | Processo vivo. Sem IO, sem autenticação. |
| `GET /health/ready` | PostgreSQL e SQS alcançáveis, com timeout de 3s por dependência. Resposta sem detalhes de erro. Sem autenticação. |

## Cursor do ledger
- Base64url de JSON `{ t: <ISO-8601>, i: <uuid> }`. O cliente não deve interpretá-lo.
- Ordenação: `(created_at, id)`. Cursor malformado ou com `t` inválido → 400.
