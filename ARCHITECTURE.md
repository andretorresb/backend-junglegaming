# ARCHITECTURE.md

Documento vivo. Cada decisão relevante é registrada aqui com motivo, alternativas e trade-offs.
Estado atual: **Etapa 7 (transactional outbox)**.

## 1. Stack

| Item | Escolha | Status |
|---|---|---|
| Runtime / package manager / test runner | Bun 1.x | Adotado |
| Linguagem | TypeScript estrito (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) | Adotado |
| Framework | NestJS 11 | Adotado |
| ORM | MikroORM 6 (PostgreSQL) | Adotado — ver seção 2 |
| Banco | PostgreSQL 16 | Adotado |
| Mensageria | AWS SQS via LocalStack 3.8 | Adotado (uso a partir da Etapa 7) |
| Orquestração local | Docker Compose | Adotado |

## 2. Escolha do ORM: MikroORM

**Decisão:** MikroORM (preferencial no enunciado).

**Motivo:**
- Unit of Work e Identity Map explícitos: controle fino sobre quando o estado é gravado, útil para o commit atômico de wallet + ledger + inbox + outbox.
- `EntityManager.transactional()` para a fronteira transacional.
- Suporte a `LockMode.PESSIMISTIC_WRITE` (`SELECT ... FOR UPDATE`), usado na estratégia de concorrência (Etapa 3).

**Alternativas consideradas:** TypeORM (aceito pelo enunciado, menos explícito em Unit of Work). Prisma fora de escopo.

**Separação:** o domínio (`src/domain`) não importa o ORM. Entidades de persistência e mapeadores ficam em `src/infrastructure/persistence` (Etapa 2).

## 3. Autenticação

**Status:** pendente de decisão, a registrar até a Etapa 6.

Opções:
- Integrar IdP externo (Keycloak ou Zitadel) em Docker Compose.
- Não implementar, documentar o desenho e deixar `AuthGuard` no-op e `ProviderIdentityPort` como pontos de extensão.

Escopo: endpoints de health ficam abertos. Mensagens da fila são canal interno confiável, mas a identidade do provedor no payload continua sujeita às validações de domínio.

## 4. Configuração

- Variáveis de ambiente lidas em `src/config/env.ts` (ver `.env.example`).
- `mikro-orm.config.ts` na raiz é compartilhado pela aplicação e pela CLI de migrations.

## 5. Health checks

- `GET /health/live`: processo vivo, sem IO, sem autenticação. **Implementado.**
- `GET /health/ready`: Postgres e SQS alcançáveis. **Pendente (Etapa 6).**

## 6. Domínio (Etapa 1)

### 6.1 Money
- Representação interna: `decimal.js` (precisão 40, sem arredondamento silencioso).
- Entrada aceita: `^-?\d+(\.\d{1,2})?$`. Rejeita `NaN`, `Infinity`, notação científica, vazio, sinal `+`, mais de 2 casas.
- `Money.from` aceita negativos (uso interno); `Money.fromInput` rejeita negativos (contratos de entrada).
- Serialização: sempre 2 casas (`"25.00"`). `-0` é normalizado para `0`.
- `equals` com moedas diferentes retorna `false`; `isLessThan` e operações aritméticas lançam `CurrencyMismatchError`.

### 6.2 Transições de `WagerTransaction`

| De | Para |
|---|---|
| `PENDING` | `PROCESSED`, `PENDING_REFERENCE` (só REFUND/ROLLBACK), `REJECTED`, `FAILED` |
| `PENDING_REFERENCE` | `PROCESSED`, `REJECTED`, `FAILED` |
| `PROCESSED`, `REJECTED`, `FAILED` | nenhuma (terminais) |

Transição inválida lança `InvalidTransactionStateError`, que é erro de programação e não caminho de negócio.

### 6.3 Direção do lançamento (`ledgerDirectionFor`)

| Kind | Direção | Referência aceita |
|---|---|---|
| `OPENING`, `WIN` | CREDIT | — |
| `BET` | DEBIT | — |
| `LOSS` | sem lançamento | — |
| `REFUND` | CREDIT | somente `BET` |
| `ROLLBACK` | inverso da referência: `BET` → CREDIT; `WIN` ou `REFUND` → DEBIT | `BET`, `WIN`, `REFUND` |

A validação de tipo da referência fica nesse método (fonte única). A validação de contexto (provider, player, wallet, moeda, rodada), de status e de valor fica na Etapa 4.

### 6.4 Hash de payload (`payloadHash`)
1. Monta o subconjunto: `providerId, externalTransactionId, playerId, walletId, roundId, gameId, kind, money (MoneyProps), referenceExternalTransactionId` (ausente = `null`).
2. Serializa como JSON canônico: chaves de objeto ordenadas recursivamente (ordem de código UTF-16), arrays preservam a ordem, sem espaços.
3. SHA-256 do texto UTF-8, em hexadecimal minúsculo (64 caracteres).

`Idempotency-Key` e metadados de transporte não entram no hash.

### 6.5 Wallet
- `version` começa em 1 e incrementa somente quando o saldo muda (`debit`/`credit` com valor positivo).
- `debit` sem saldo lança `InsufficientBalanceError` antes de qualquer alteração.
- Na Etapa 4, a reversão que faria saldo negativo será traduzida para `NEGATIVE_BALANCE_ON_REVERSAL` pela camada de aplicação.

## 7. Persistência (Etapa 2)

### 7.1 Schema
Tabelas: `wallets`, `wager_transactions`, `wallet_ledger_entries`, `inbox_messages`, `outbox_messages`. Migrations em `src/infrastructure/persistence/migrations`, cada uma com `up` e `down`.

Garantias no banco:
- `wallets`: `UNIQUE (player_id, currency)`; `CHECK (balance >= 0)`; `CHECK (version >= 1)`.
- `wager_transactions`: `UNIQUE (provider_id, external_transaction_id)`; `UNIQUE (idempotency_key)`; `CHECK` de `kind`, `status` e amount > 0; REFUND/ROLLBACK exigem referência e BET/WIN/LOSS não aceitam; FK composta `(wallet_id, currency)` garante moeda igual à da wallet.
- `wallet_ledger_entries`: trigger `BEFORE UPDATE OR DELETE` bloqueia alteração (imutabilidade); `UNIQUE (wallet_id, transaction_id)` (no máximo um lançamento por transação e wallet); `CHECK` de direção, amount > 0 e saldos não negativos; FK composta de moeda.
- `inbox_messages`: PK `(consumer_name, message_id)`.
- `outbox_messages`: índice parcial para eventos pendentes; `attempts >= 0`; `payload` deve ser objeto JSON.

### 7.2 Tipos
- Dinheiro: `numeric(19,2)`. Nenhuma coluna monetária usa float ou double.
- Identificadores internos e `player_id`/`wallet_id`: `uuid`. Identificadores do provedor e `round_id`/`game_id`: `text`.
- `payload_hash`: `char(64)` (SHA-256 hexadecimal).

### 7.3 Limitações conhecidas
- O banco não garante que toda alteração de saldo tenha lançamento correspondente (exigiria trigger de consistência entre tabelas). Essa invariante é garantida pela camada de domínio (`Wallet` e `WalletLedgerEntry`) e verificada pelo helper `assertLedgerInvariant` nos testes (Etapas 3 a 10).
- `TRUNCATE` não é bloqueado pela trigger (que é de linha). Ele é usado apenas nos testes.
- `numeric(19,2)` arredonda entradas com mais casas; a validação de escala é feita antes pelo `Money`.

### 7.4 Execução de migrations
- `bun run migration:up`, `migration:down`, `migration:reset`, `migration:status`, `migration:create <nome>`.
- Usa `scripts/migrate.ts` (API programática do MikroORM). A CLI `mikro-orm` v6 não aplica migrations com config TypeScript sob Bun: termina com código 0 e não faz nada.

## 8. Núcleo financeiro (Etapa 3)

### 8.1 Estratégia de concorrência: lock pessimista por wallet
- `SELECT ... FOR UPDATE` na linha da wallet, dentro da mesma transação SQL de toda a operação.
- Unidade de concorrência: `walletId`. Não há lock global. Wallets distintas processam em paralelo.
- **Por que pessimista e não otimista:** a wallet é uma hot spot por natureza (apostas em sequência do mesmo jogador). Optimistic locking com retry faria a maioria das requisições concorrentes dar retry e, sob carga, ultrapassar o limite de tentativas. O lock serializa a fila de forma previsível.
- Guarda de versão no `UPDATE` (`WHERE version = <anterior>`): com o lock nunca diverge; se diverge, a operação falha em vez de sobrescrever.
- `lock_timeout = 2s` por transação (`SET LOCAL`). Espera acima disso vira `TRANSIENT_UNAVAILABLE` (HTTP 503 com `Retry-After: 1`). Nada é gravado.

### 8.2 Ordem das operações dentro da transação
1. Trava a wallet.
2. Procura a `Idempotency-Key`: replay (mesmo hash) ou conflito (hash diferente).
3. Procura `(providerId, externalTransactionId)`: se existir com outra chave, conflito.
4. Valida jogador e moeda contra a wallet.
5. Aplica a regra, grava transação, lançamento, saldo e outbox juntos.

**Por que travar antes de checar a idempotência:** requisições idênticas ficam na fila do lock. A segunda só lê a transação depois que a primeira comitou. Assim a corrida de idempotência é resolvida pela serialização, e o `UNIQUE` no banco fica como garantia final.

### 8.3 Replay devolve o saldo observado
- `balance_observed` (migration `Migration20261114120300`) guarda o saldo da wallet no momento da decisão.
- Um replay devolve esse saldo, e não o saldo atual. A regra 7 do enunciado exige isso.

### 8.4 Rejeições
- **Por regra de negócio** (saldo insuficiente): a transação é persistida como `REJECTED`, com evento e sem lançamento. Isto é um resultado auditável, não uma exceção que desfaz a transação.
- **Por contexto** (moeda ou jogador divergentes): **não são persistidas**. A FK composta `(wallet_id, currency)` impediria o registro, e a rejeição é determinística para o mesmo payload. Resposta 422 com `failureCode`. Limitação: essas tentativas não ficam auditadas no banco.
- Payload inválido (incluindo valor com 3 casas ou negativo): 400, antes de qualquer escrita.

### 8.5 Corrida entre chaves diferentes com o mesmo external id
Se duas requisições com chaves diferentes e o mesmo `(provider, externalTransactionId)` chegarem juntas em wallets diferentes, uma delas recebe `UNIQUE_VIOLATION` (SQLSTATE 23505). O caso de uso repete a operação uma vez; a segunda tentativa enxerga a linha comitada e responde conflito.

### 8.6 Escopo desta etapa
- Kinds suportados: `BET`, `WIN`, `LOSS`.
- `OPENING`: recusado com 400 `INTERNAL_ONLY_KIND` (interno).
- `REFUND` e `ROLLBACK`: 501 `KIND_NOT_SUPPORTED_YET`. Implementados na Etapa 4.
- Eventos gravados na outbox com envelope provisório (`eventId`, `eventType`, `aggregateId`, `correlationId`, `occurredAt`, `version`, `data`). A forma final, com classes `IntegrationEvent`, chega na Etapa 7.
- Publicação no SQS: fora de escopo (Etapa 7).

### 8.7 Testes
- `test/integration/wagering/`: regras, replay, conflito, rejeições, e a matriz HTTP (status codes, validação, 503).
- `test/concurrency/`: 50 chamadas idênticas em paralelo (1 débito), corrida 80 + 80 sobre saldo 100 (1 PROCESSED, 1 REJECTED, saldo 20), chaves iguais em wallets diferentes, três wallets em paralelo, 30 apostas de 5 sobre saldo 100 (exatamente 20 processadas), e lock travado (503).
- `assertLedgerInvariant` roda ao fim de cada teste que altera saldo.

## 9. Wallets e reversões (Etapa 4)

### 9.1 POST /wallets
- Saldo inicial > 0: wallet, transação interna `OPENING` (PROCESSED) e lançamento CREDIT na mesma transação SQL, com evento `WalletBalanceChanged`.
- Saldo zero: só a wallet. Sem OPENING, sem lançamento, sem evento.
- Duplicata (`playerId` + `currency`): a unicidade do banco é a proteção. A violação vira `DUPLICATE_WALLET` (409). Não há checagem prévia, para não haver janela de corrida.
- **Sem `Idempotency-Key`:** criar a wallet de novo com os mesmos dados já retorna 409, que é uma resposta determinística. Decidido não exigir header nesta etapa.
- Saldo negativo: 400, antes de qualquer escrita.

### 9.2 Referência ausente
- Resolvido na Etapa 5: ver seção 10. A reversão fica `PENDING_REFERENCE`, sem movimento de saldo, e o worker a reprocessa.

### 9.3 Regras de reversão (`src/domain/wagering/reversal-rules.ts`)
Ordem de validação, na primeira falha:
1. referência ausente → `REFERENCE_NOT_FOUND`;
2. jogador, wallet, rodada, provedor ou moeda diferentes → `REFERENCE_CONTEXT_MISMATCH`;
3. tipo não permitido (REFUND: só BET; ROLLBACK: BET, WIN ou REFUND) → `REFERENCE_TYPE_NOT_ALLOWED`;
4. referência não `PROCESSED` → `REFERENCE_NOT_PROCESSED`;
5. referência já revertida → `REFERENCE_ALREADY_REVERSED`;
6. valor diferente → `AMOUNT_MISMATCH_ON_REVERSAL`;
7. reversão que debitaria sem saldo → `NEGATIVE_BALANCE_ON_REVERSAL` (código distinto de `INSUFFICIENT_BALANCE`).

A direção do lançamento vem de `ledgerDirectionFor`, que é a única fonte da regra de inversão.

### 9.4 Interpretação: uma transação é revertida no máximo uma vez
- A regra 4 do enunciado diz "não pode ser revertida duas vezes **pelo mesmo tipo** de operação".
- Pela leitura literal, um REFUND e um ROLLBACK da mesma BET creditariam duas vezes um único débito. Isto viola a invariante "não pode duplicar créditos".
- Adotei: **no máximo uma reversão processada por transação, qualquer que seja o tipo.**
- Garantia no banco: índice único parcial `wt_single_processed_reversal_uq` sobre `reference_transaction_id` onde `kind IN (REFUND, ROLLBACK) AND status = PROCESSED`. Uma reversão rejeitada não bloqueia outra.

### 9.5 Testes
- `test/unit/domain/reversal-rules.spec.ts`: matriz de validação.
- `test/integration/reversals/`: 17 casos da matriz, incluindo replay e o índice.
- `test/integration/wallets/`: criação de wallet, duplicata e atomicidade (falha na outbox desfaz tudo).
- `test/concurrency/reversal-concurrency.spec.ts`: REFUND e ROLLBACK simultâneos, 20 REFUNDs paralelos, ROLLBACK de WIN com apostas concorrentes.

## 10. Referências fora de ordem (Etapa 5)

### 10.1 Entrada
- REFUND ou ROLLBACK cuja referência não existe, ou existe mas ainda está `PENDING_REFERENCE`, vira `PENDING_REFERENCE`.
- A transação é persistida com `reference_attempts = 0` e `reference_next_attempt_at` (primeira consulta, com backoff e jitter). Evento `WagerTransactionPendingReference` na outbox, na mesma transação.
- HTTP responde **202** com `status: PENDING_REFERENCE`.
- Referência existente e não processada (ex.: `REJECTED`) continua sendo rejeitada na hora com `REFERENCE_NOT_PROCESSED`. Aguardar não resolveria esse caso.

### 10.2 Worker (`PendingReferenceWorker`)
- Cada transação vencida é processada em transação SQL própria:
  1. reivindica a próxima com `SELECT ... FOR UPDATE SKIP LOCKED` (verificado no SQL gerado): duas instâncias nunca pegam a mesma linha;
  2. trava a wallet, como o caminho HTTP e a fila;
  3. se a referência apareceu, aplica a mesma regra de reversão do caso de uso (`apply-reversal.ts`). Uma única implementação;
  4. se não apareceu, conta a tentativa e reagenda, ou expira.
- Falha em um item (ex.: timeout de lock) faz rollback só dele. O item é excluído do restante do ciclo e volta no próximo.
- O agendador (`PendingReferenceScheduler`) roda um ciclo por vez, em intervalo fixo. `PENDING_REFERENCE_POLL_MS=0` desliga o agendamento.

### 10.3 Limites e backoff (`src/domain/wagering/reference-retry-policy.ts`)
- Atraso: `min(teto, base × 2^tentativas) × (0,5 a 1,0)` (jitter). Padrões: base 1s, teto 5 min.
- Limite de tentativas: 10. Com o backoff padrão, cobre cerca de 25 min.
- TTL: 24h desde a chegada. Limita o tempo de vida de uma transação pendente mesmo que o worker fique parado.
- Justificativa: a reversão costuma chegar em segundos ou minutos depois da aposta. As primeiras consultas são rápidas, as seguintes espaçam a carga. O TTL impede acúmulo indefinido.
- Esgotado o limite ou o TTL: `REJECTED` com `REFERENCE_NOT_FOUND`, e evento `WagerTransactionRejected`.
- Variáveis: `PENDING_REFERENCE_MAX_ATTEMPTS`, `PENDING_REFERENCE_TTL_MS`, `PENDING_REFERENCE_BASE_DELAY_MS`, `PENDING_REFERENCE_MAX_DELAY_MS`, `PENDING_REFERENCE_BATCH_SIZE`, `PENDING_REFERENCE_POLL_MS`.

### 10.4 Decisões
- **Espera encadeada:** um ROLLBACK de um REFUND pendente também aguarda. Sem isso, o ROLLBACK seria rejeitado como `REFERENCE_NOT_PROCESSED` antes de o REFUND chegar.
- **Lock antes da reivindicação:** o worker reivindica a linha e depois trava a wallet, na mesma transação. A ordem é a mesma do caminho HTTP: nunca há ciclo de locks, porque o caminho HTTP não trava linhas de transações existentes.
- **Logs sem valores:** cada tentativa gera um registro JSON com `transactionId`, `walletId`, `attempts`, `outcome` e `failureCode`. Nunca `amount` nem payload.

### 10.5 Testes
- `test/unit/domain/reference-retry-policy.spec.ts`: backoff, teto, jitter, limite e TTL.
- `test/integration/wagering/pending-reference.spec.ts`: 10 casos, incluindo a cadeia ROLLBACK → REFUND → BET, referência que nunca chega, TTL, valor divergente, saldo gasto e falha transitória isolada.
- `test/concurrency/pending-reference-concurrency.spec.ts`: 50 reversões pendentes drenadas por dois workers em paralelo, sem duplicidade.

## 11. API HTTP completa (Etapa 6)

### 11.1 Autenticação (seção 2 do enunciado)
- **Decisão:** não integrar IdP nesta entrega. O enunciado aceita essa escolha, desde que o ponto de extensão fique explícito e documentado.
- `AuthGuard` (`src/interfaces/http/auth/auth.guard.ts`) é registrado globalmente e hoje deixa tudo passar. A troca por validação real de token (Keycloak ou Zitadel) acontece nesse guard, sem mudar os controllers.
- Health checks são marcados com `@Public()`. São abertos mesmo quando o guard for real.
- Escopo: mensagens da fila são canal interno confiável, mas a identidade do provedor no payload continua sujeita às validações de domínio (jogador, moeda, referência).

### 11.2 Consultas e ledger
- `GET /wallets/:id`, `GET /wallets/:id/ledger` e `POST /wallets/:id/reconciliation` estão implementados em `WalletQueries`.
- **Cursor do ledger:** base64url de `{ t, i }`, onde `t` é o `created_at` do último item e `i` o id. Ordenação `(created_at, id)`. Cursor adulterado é 400.
- **Estabilidade:** `created_at` é sempre gravado a partir de `Date` do JavaScript (precisão de milissegundos). O valor que volta do banco é exato, então o cursor não repete nem pula linhas. O teste de paginação com inserções concorrentes comprova isso.
- **Limitação:** uma transação de longa duração que commita um lançamento com `created_at` anterior ao cursor pode fazer esse item ser entregue fora de ordem ou não ser entregue na paginação em curso. O ledger é lido em páginas independentes, então a limitação se restringe a paginações abertas durante escrita concorrente.

### 11.3 Reconciliação
- O servidor calcula tudo. Saldos enviados pelo cliente são ignorados (a rota não tem corpo validado).
- Leitura em `REPEATABLE READ`: o saldo armazenado e a soma do ledger vêm do mesmo snapshot.
- Divergência: `consistent: false`, `difference` preenchido, log de erro `reconciliation_divergence` e métrica `reconciliation_divergence_total`. Nada é corrigido.

### 11.4 Health
- `/health/live`: sem IO.
- `/health/ready`: PostgreSQL (`select 1`) e SQS (`ListQueues`) em paralelo, timeout de 3s por dependência. Falha em qualquer uma → 503 com `checks` e `errors`.
- Timeout de 3s, e não 1s: a primeira chamada a uma dependência fria (pool, SDK) pode passar de 2s. Um probe que dá falso negativo no boot é pior que um probe um pouco mais lento.

### 11.5 Contrato
- Status por situação e lista de endpoints em `docs/http-contract.md`.

### 11.6 Testes
- `test/integration/wallets/queries.spec.ts`: consultas, paginação de 120 itens, limite, cursor inválido, paginação com inserções concorrentes, reconciliação consistente e divergente (com métrica), e wallet inexistente.
- `test/integration/health/ready.spec.ts`: ready 200 com PostgreSQL e SQS; ready 503 com SQS inalcançável, live continua 200.

## 12. Transactional outbox (Etapa 7)

### 12.1 Eventos (seção 11 do enunciado)
- `IntegrationEvent<T>` é abstrata. Cada subclasse fixa `eventType` e `version` no tipo: `WagerTransactionProcessed`, `WagerTransactionRejected`, `WalletBalanceChanged`, `WagerTransactionPendingReference`.
- `data` usa `MoneyProps` (string), nunca `Money`.
- `WagerTransactionProcessed` cobre toda transação aplicada, inclusive LOSS e o OPENING da criação de wallet.
- `WalletBalanceChanged` é emitido **somente** quando o saldo muda.
- Envelope: `{ eventId, eventType, aggregateId, correlationId, causationId?, occurredAt (ISO-8601), version, data }`.
- `eventId` é gerado uma vez e preservado nos reenvios. É a base da deduplicação do consumidor.

### 12.2 Escrita atômica
- Os eventos são gravados na outbox dentro da mesma transação SQL da alteração que os originou.
- Testado: falha depois da gravação da outbox desfaz tudo, sem evento órfão.

### 12.3 Publicação
- `OutboxPublisherWorker`: cada mensagem é tratada em transação própria. Reivindica com `FOR UPDATE SKIP LOCKED`, publica no SQS, marca como publicada e comita.
- Falha de publicação: `scheduleRetry` com backoff exponencial (base 1s, teto `OUTBOX_MAX_BACKOFF_MS`), na mesma transação.
- Fila de destino: `wager-events` (padrão, configurável por `EVENTS_QUEUE_NAME`). Fila padrão, não FIFO: a deduplicação é do consumidor, pelo `eventId`.
- Fila criada por `bun run localstack:init` (`scripts/localstack/init-queues.ts`). `ensureQueues` também cria `wager-transactions.fifo` e a DLQ, com redrive após `MAX_RECEIVE_COUNT` (5).

### 12.4 Semântica: at-least-once
- Se o processo morre depois de publicar e antes de marcar, a mensagem continua pendente e é publicada de novo, **com o mesmo `eventId`**.
- Testado: falha depois do envio → o mesmo `eventId` aparece duas vezes na fila, e nenhum outro duplica.

### 12.5 Lag
- `outbox_lag_seconds` (gauge): idade da mensagem pendente mais antiga. Zero quando não há pendências.
- Contadores: `outbox_published_total` e `outbox_publish_failed_total`.

### 12.6 Testes
- `test/unit/domain/events-and-outbox.spec.ts`: envelope, `causationId` opcional, backoff, transições da `OutboxMessage`.
- `test/integration/outbox/`: escrita atômica, publicação real no SQS, falha com backoff, lag, id da outbox preservado.
- `test/concurrency/outbox-concurrency.spec.ts`: dois publishers sobre 200 eventos (cada um chega uma vez); duplicidade controlada após falha.

## 11. Pendências desta documentação

Serão preenchidas nas etapas seguintes conforme o plano em `ETAPAS.md` e as specs em `docs/specs/`:
- Estratégia de lock e idempotência (Etapa 3).
- Política de referências pendentes (Etapa 5).
- Mapeamento HTTP (Etapa 6).
- Outbox, inbox e semântica at-least-once (Etapas 7 e 8).
- Trade-offs e limitações (Etapa 11).
