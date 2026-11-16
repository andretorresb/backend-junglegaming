# Teste de carga

Diferencial opcional da seção 14 do enunciado. Comando: `bun run test:load`
(pré-requisitos: `docker compose up -d` e `bun run localstack:init`).
Script: [`scripts/load/run.ts`](../scripts/load/run.ts). Resultado bruto da última execução:
[`load-test-results.json`](./load-test-results.json).

## Ambiente

| Item | Valor |
|---|---|
| Máquina | Apple M3, 8 núcleos, 8 GB de RAM (macOS) |
| Runtime | Bun 1.4.4 |
| Banco | PostgreSQL 16.16 em container (Docker Desktop), `max_connections = 100` |
| Mensageria | LocalStack 3.8 (SQS emulado) em container |
| Aplicação | 3 processos (`bun src/main.ts`), pool padrão do MikroORM, publisher da outbox ligado |
| Gerador de carga | Mesmo host, Bun `fetch`, laço fechado |

Tudo roda na mesma máquina: aplicação, banco, LocalStack e gerador disputam CPU e memória.

## Metodologia

- **Banco dedicado** (`junglegaming_load`), migrado e limpo no início. A fila de eventos é esvaziada no início e no fim.
- **3 processos** da aplicação, como em produção com várias instâncias. As requisições são distribuídas entre eles em rodízio.
- **Wallets criadas pela API** (`POST /wallets`), com saldo alto para que as apostas não sejam rejeitadas por saldo.
- **Usuários virtuais em laço fechado:** 64. Cada um envia a próxima requisição quando a anterior responde. A latência medida inclui a fila do lado do servidor.
- **Mistura de operações:** 60% BET, 30% WIN e 10% LOSS, com valores de 1 a 10 BRL. 5% das requisições repetem uma anterior, com a mesma chave e o mesmo corpo, para exercitar o replay idempotente.
- **Janelas:** 5s de aquecimento (descartados) e 30s medidos por cenário.
- **Cenários:**
  - `distributed`: 100 wallets, operações espalhadas.
  - `hot-wallet`: 1 wallet recebe tudo. Pior caso do lock pessimista por wallet.
- **Classificação dos status:** 200 e 202 são sucesso; 422 é rejeição de negócio (não é erro); 503 é conflito transitório de lock (contado à parte); qualquer outro 4xx, todo 5xx e falha de rede são erro.
- **Outbox:** o lag (`outbox_lag_seconds`) é amostrado a cada segundo em todos os processos. Depois da carga, mede-se o tempo até não haver evento pendente, com limite de 120s.
- **Correção após a carga:** para cada wallet do cenário, verifica-se `saldo armazenado == soma do ledger`.

## Resultados

Mesmos parâmetros em todas as execuções. A primeira revelou o gargalo da publicação um a um. A segunda, com publicação em lote, revelou o da reivindicação com backlog grande. As seguintes medem o índice novo com 4 e 8 faixas.

### Execução 1: publisher original (uma mensagem por transação)

| Cenário | Req | Req/s | p50 ms | p95 ms | p99 ms | máx ms | Erro | 503 | Replays | Lag máx | Drenagem | Wallets inconsistentes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| distributed | 34.063 | 1.135 | 50,3 | 114,9 | 156,5 | 336,0 | 0% | 0% | 1.656 | 22,5 s | **não drenou em 120 s** | 0/100 |
| hot-wallet | 10.696 | 357 | 178,0 | 235,0 | 280,8 | 344,7 | 0% | 0% | 519 | 178,9 s | **não drenou em 120 s** | 0/1 |

Taxa real de publicação: **36 eventos/s**, para uma geração de cerca de 2.000 eventos/s. Ao fim havia 81.781 eventos pendentes.

### Execução 2: publisher em lote, índice antigo

| Cenário | Req | Req/s | p50 ms | p95 ms | p99 ms | máx ms | Erro | 503 | Replays | Lag máx | Drenagem | Wallets inconsistentes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| distributed | 27.212 | 907 | 64,5 | 134,8 | 204,1 | 436,9 | 0% | 0% | 1.309 | 21,2 s | 23,2 s | 0/100 |
| hot-wallet | 10.884 | 363 | 133,0 | 354,7 | 431,1 | 721,2 | 0% | 0% | 574 | 0,9 s | 0,3 s | 0/1 |

Taxa real de publicação: **847 eventos/s**. Todos os 79.932 eventos foram publicados.

### Execuções 3 a 6: índice na ordem de leitura (atual)

Índice `outbox_pending_order_idx` e sucessos marcados num único `UPDATE`. Duas execuções com 4 faixas e duas com 8 (padrão atual). Os 422 e os 503 seguem em zero.

| Faixas | Cenário | Req/s | p50 ms | p99 ms | Erro | Lag máx | Drenagem | Wallets inconsistentes |
|---|---|---|---|---|---|---|---|---|
| 4 | distributed | 1.024 | 56,7 | 217,5 | 0% | 12,7 s | 4,9 s | 0/100 |
| 4 | distributed | 1.174 | 50,0 | 150,1 | 0% | 13,3 s | 5,8 s | 0/100 |
| 8 | distributed | 1.119 | 53,4 | 170,6 | 0% | 7,3 s | 4,1 s | 0/100 |
| 8 | distributed | 996 | 57,3 | 239,2 | 0% | 8,3 s | 3,1 s | 0/100 |
| 4 | hot-wallet | 421 | 107,5 | 390,0 | 0% | 0,2 s | 0,3 s | 0/1 |
| 4 | hot-wallet | 410 | 97,5 | 418,7 | 0% | 0,2 s | 0,3 s | 0/1 |
| 8 | hot-wallet | 435 | 97,6 | 384,1 | 0% | 0,2 s | 0,3 s | 0/1 |
| 8 | hot-wallet | 426 | 120,0 | 325,3 | 0% | 0,2 s | 0,3 s | 0/1 |

O `load-test-results.json` é da última execução (8 faixas).

Nos dois cenários e nas duas execuções: nenhum 422, nenhum 503, nenhum conflito de lock registrado (`lock_conflicts_total = 0`).

## Análise

### Correção sob carga
- **Nenhuma wallet inconsistente** nas duas execuções: o saldo bateu com o ledger em todas as 101 wallets, depois de cerca de 82 mil requisições concorrentes em 3 processos.
- **Replays corretos:** cerca de 5% das requisições foram repetições, e todas voltaram como replay (`idempotentReplay: true`), sem novo efeito.
- **Nenhum erro e nenhum 503.** Na wallet quente, o p99 ficou em 431 ms, longe do `lock_timeout` de 2 s, então nenhuma requisição chegou a estourar o lock.

### Gargalo encontrado: publicação da outbox
- **Causa:** o publisher original abria uma transação por mensagem, fazia uma chamada ao SQS e esperava o intervalo de polling entre ciclos. Isso limitava cada processo a cerca de 12 eventos/s.
- **Correção:**
  - lotes de 10 mensagens por transação, publicados com `SendMessageBatch`;
  - 4 faixas concorrentes por processo, com `FOR UPDATE SKIP LOCKED` garantindo lotes disjuntos;
  - ciclo seguido, sem esperar o intervalo, enquanto o lote vem cheio.
- **Efeito:** de 36 para 847 eventos/s, cerca de 23 vezes mais. A semântica at-least-once continua a mesma, e falha de um evento dentro do lote só reagenda aquele evento.

### Segundo gargalo: reivindicação com backlog grande
- **Causa:** o índice da outbox era `(next_attempt_at, occurred_at, id)`, que não serve ao `ORDER BY occurred_at, id` da reivindicação. Com 80 mil pendentes, cada lote de 10 fazia uma varredura sequencial e ordenava tudo em disco: `EXPLAIN ANALYZE` mediu 481 ms. Quanto maior o backlog, mais lenta a publicação, que é o pior comportamento possível sob carga.
- **Correção:** índice parcial `(occurred_at, id) WHERE published_at IS NULL` (migration `Migration20261116120000_outbox_pending_order`). A mesma consulta passou a 0,07 ms, uma varredura de índice que para no `LIMIT`. A consulta do lag também usa o índice. Os sucessos de cada lote passaram a ser marcados num único `UPDATE`, em vez de um por mensagem.
- **Efeito:** com 4 faixas, o lag máximo caiu de 21 para cerca de 13 s, e a drenagem de 23 para cerca de 5 s. Com 8 faixas, o lag ficou entre 7 e 8 s nas duas execuções. Por isso o padrão passou a 8.

### O que ainda não está bom
- **No cenário distribuído, a outbox ainda atrasa durante a carga máxima.** A geração é de cerca de 2.000 eventos/s. O lag chega a 7 ou 8 s, e o backlog drena em 3 a 4 s quando a carga para, a cerca de 5.000 eventos/s. Ou seja, o publisher sozinho é mais rápido que a geração; durante a carga ele disputa CPU e conexões com a API, o banco, o LocalStack e o gerador, todos na mesma máquina. O próximo passo seria rodar o publisher em processo próprio. Sob a carga da wallet quente, a publicação acompanha, com lag de 0,2 s.
- **O throughput da API varia bastante entre execuções** (de 996 a 1.174 req/s no cenário distribuído, com a mesma configuração). Não há diferença clara entre 4 e 8 faixas, e a queda para 907 req/s na execução 2 não se repetiu depois do índice: era, ao menos em parte, efeito da reivindicação lenta.
- **A latência da wallet quente piorou na cauda** (p99 de 281 para 431 ms), enquanto a mediana melhorou (178 para 133 ms). Com uma execução de cada, não dá para separar o efeito da mudança da variação entre execuções.

### Wallet quente
- A wallet quente processou cerca de 360 req/s com uma única linha travada por vez. Isso é o teto do lock pessimista por wallet neste ambiente: cada transação da mesma wallet espera a anterior.
- É o trade-off escolhido (seção 8.1 do `ARCHITECTURE.md`): previsibilidade e correção sob concorrência, ao custo de serializar a wallet quente.

## Limitações do experimento

- **Poucas execuções.** No máximo duas por configuração. A variação entre execuções iguais (cerca de 15% no throughput) é maior que várias das diferenças medidas, então só o efeito no lag, que se repetiu, é conclusivo.
- **Gerador no mesmo host.** O gerador disputa CPU com a aplicação e o banco. Os números são um limite inferior do que a aplicação faria com o gerador em outra máquina.
- **LocalStack não é SQS.** A latência e os limites de vazão do SQS real são outros. As taxas de publicação valem para este ambiente.
- **Docker Desktop no macOS.** A rede entre containers e host passa por uma VM, o que acrescenta latência.
- **Só a API HTTP.** O consumidor da fila `wager-transactions.fifo` não foi submetido a carga.
- **Janelas curtas** (30 s). Efeitos de longo prazo, como o crescimento da inbox e da outbox, não aparecem.

## Como reproduzir

```bash
docker compose up -d
bun run localstack:init
bun run test:load
```

Parâmetros: `LOAD_PROCESSES` (3), `LOAD_VUS` (64), `LOAD_DURATION_S` (30), `LOAD_WARMUP_S` (5),
`LOAD_WALLETS` (100), `LOAD_DUPLICATE_RATIO` (0.05). Faixas do publisher: `OUTBOX_PARALLELISM` (8).
