# Códigos de falha (`failureCode`)

Código estável e legível por máquina, presente em toda rejeição de negócio.
Permite ao provedor decidir se reenvia, corrige o payload ou desiste.
Os valores são contrato: não renomear sem versionar.

| Código | Quando ocorre | Provedor deve |
|---|---|---|
| `INVALID_PAYLOAD` | Valor monetário inválido, campo obrigatório ausente, referência ausente em kind que exige, referência informada em kind que não aceita | Corrigir o payload. Não reenviar igual |
| `INSUFFICIENT_BALANCE` | BET (ou débito de operação não reversão) maior que o saldo | Desistir da aposta ou aguardar crédito. Não reenviar igual |
| `NEGATIVE_BALANCE_ON_REVERSAL` | ROLLBACK/REFUND que reverteria um crédito e deixaria o saldo negativo. Situação operacional distinta de aposta sem saldo: exige análise | Escalar para operação. Não reenviar automaticamente |
| `CURRENCY_MISMATCH` | Moeda da transação diferente da moeda da wallet | Corrigir o payload |
| `PLAYER_MISMATCH` | `playerId` da transação diferente do dono da wallet | Corrigir o payload |
| `REFERENCE_NOT_FOUND` | A referência não apareceu dentro do limite de tentativas ou do TTL. A reversão foi rejeitada após esperar (`PENDING_REFERENCE`, seção 10 do ARCHITECTURE.md) | Verificar se a transação original foi enviada. Pode reenviar a original e depois a reversão |
| `REFERENCE_NOT_PROCESSED` | Referência existe mas não está `PROCESSED` (ex.: foi rejeitada) | Não reverter o que não foi aplicado |
| `REFERENCE_ALREADY_REVERSED` | Referência já foi revertida pelo mesmo tipo de operação | Não reenviar. Já está revertida |
| `REFERENCE_TYPE_NOT_ALLOWED` | Tipo da referência não permitido (REFUND só referencia BET; ROLLBACK referencia BET, WIN ou REFUND) | Corrigir o payload |
| `REFERENCE_CONTEXT_MISMATCH` | Referência de outro provider, player, wallet, moeda ou rodada | Corrigir o payload |
| `AMOUNT_MISMATCH_ON_REVERSAL` | Valor de REFUND/ROLLBACK diferente do valor da referência (reversão parcial fora de escopo) | Corrigir o valor |
| `DUPLICATE_WALLET` | Já existe wallet para o mesmo `playerId` + `currency` | Usar a wallet existente |
| `IDEMPOTENCY_CONFLICT` | Mesma `Idempotency-Key` com payload diferente | Não reenviar com payload diferente. Gerar nova chave para nova operação |
| `INTERNAL_ONLY_KIND` | Tentativa de submeter `OPENING` pela API ou fila | Não aplicável ao provedor |

## Erros que **não** carregam `failureCode`

Erros de programação ou de integridade, que não são respostas de negócio ao provedor:

- `InvalidTransactionStateError`: transição inválida (ex.: alterar transação terminal).
- `LedgerArithmeticError`: aritmética de lançamento inconsistente.
- `InvalidInvariantError`: violação de invariante de domínio (ex.: moeda da movimentação diferente da wallet).

Falhas transitórias de infraestrutura (Postgres, SQS, lock timeout) também não são `failureCode`. São mapeadas para `503` com `Retry-After` na Etapa 6.
