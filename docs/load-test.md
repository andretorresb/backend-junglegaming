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

Foram duas execuções com os mesmos parâmetros. A primeira revelou um gargalo na outbox. A segunda foi feita depois da correção.

### Execução 1: publisher original (uma mensagem por transação)

| Cenário | Req | Req/s | p50 ms | p95 ms | p99 ms | máx ms | Erro | 503 | Replays | Lag máx | Drenagem | Wallets inconsistentes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| distributed | 34.063 | 1.135 | 50,3 | 114,9 | 156,5 | 336,0 | 0% | 0% | 1.656 | 22,5 s | **não drenou em 120 s** | 0/100 |
| hot-wallet | 10.696 | 357 | 178,0 | 235,0 | 280,8 | 344,7 | 0% | 0% | 519 | 178,9 s | **não drenou em 120 s** | 0/1 |

Taxa real de publicação: **36 eventos/s**, para uma geração de cerca de 2.000 eventos/s. Ao fim havia 81.781 eventos pendentes.

### Execução 2: publisher em lote (atual)

| Cenário | Req | Req/s | p50 ms | p95 ms | p99 ms | máx ms | Erro | 503 | Replays | Lag máx | Drenagem | Wallets inconsistentes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| distributed | 27.212 | 907 | 64,5 | 134,8 | 204,1 | 436,9 | 0% | 0% | 1.309 | 21,2 s | 23,2 s | 0/100 |
| hot-wallet | 10.884 | 363 | 133,0 | 354,7 | 431,1 | 721,2 | 0% | 0% | 574 | 0,9 s | 0,3 s | 0/1 |

Taxa real de publicação: **847 eventos/s**. Todos os 79.932 eventos foram publicados.

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

### O que ainda não está bom
- **No cenário distribuído, a outbox ainda fica para trás durante a carga máxima.** A geração estimada é de cerca de 1.650 eventos/s (907 req/s, quase todas com 2 eventos), contra 847 publicados/s. O lag cresceu até 21 s e drenou em 23 s depois que a carga parou. Sob a carga da wallet quente (cerca de 700 eventos/s), a publicação acompanha, com lag abaixo de 1 s.
- **O throughput da API caiu de 1.135 para 907 req/s no cenário distribuído** na segunda execução. A hipótese, não verificada, é a disputa por recursos: as 4 faixas do publisher ocupam até 4 das 10 conexões do pool de cada processo, e tudo roda na mesma máquina. Separar o publisher em processo próprio, ou aumentar o pool, são os próximos passos para testar essa hipótese.
- **A latência da wallet quente piorou na cauda** (p99 de 281 para 431 ms), enquanto a mediana melhorou (178 para 133 ms). Com uma execução de cada, não dá para separar o efeito da mudança da variação entre execuções.

### Wallet quente
- A wallet quente processou cerca de 360 req/s com uma única linha travada por vez. Isso é o teto do lock pessimista por wallet neste ambiente: cada transação da mesma wallet espera a anterior.
- É o trade-off escolhido (seção 8.1 do `ARCHITECTURE.md`): previsibilidade e correção sob concorrência, ao custo de serializar a wallet quente.

## Limitações do experimento

- **Uma execução por configuração.** Não há média nem desvio entre execuções, então diferenças pequenas de latência não são conclusivas.
- **Gerador no mesmo host.** O gerador disputa CPU com a aplicação e o banco. Os números são um limite inferior do que a aplicação faria com o gerador em outra máquina.
- **LocalStack não é SQS.** A latência e os limites de vazão do SQS real são outros. O número de 847 eventos/s vale para este ambiente.
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
`LOAD_WALLETS` (100), `LOAD_DUPLICATE_RATIO` (0.05). Faixas do publisher: `OUTBOX_PARALLELISM` (4).
