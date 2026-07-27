# s3node — servidor de object storage S3-compatible em Node.js

> Documento de análise e roadmap. Julho de 2026.

## Contexto

Construir um servidor de armazenamento de objetos compatível com a API do Amazon S3, em Node.js.

**Por que agora:** o MinIO — padrão de facto para S3 self-hosted por uma década — teve seu repositório GitHub **arquivado em 12 de fevereiro de 2026**, encerrando a community edition e empurrando usuários para o AIStor comercial. Abriu-se um vácuo real. Ao mesmo tempo, o ecossistema Node **não tem** nenhum servidor S3 moderno e mantido: `s3rver` está parado há 5 anos e se declara ferramenta de teste, e o Zenko CloudServer (Scality) — o único Node de produção — ainda documenta Node 10.x + yarn 1.17.

---

## 1. Veredito e escopo travado

**Escopo decidido: produção single-node + embarcável.** Um servidor real para um nó, que também roda in-process via `npm i`. Durabilidade delegada ao RAID/ZFS embaixo — **sem erasure coding** (inviável em JS/WASM, ver 6.4). Distribuição multi-node fica fora, e essa é uma decisão consciente, não uma omissão: é exatamente onde o Node perde para Go/Rust.

A ideia é **viável e bem posicionada no tempo**, desde que o escopo seja honesto.

- **Viável:** a API do S3 é HTTP + XML + HMAC-SHA256. Nada nela exige uma linguagem de sistema. Object storage é dominado por I/O, não por CPU — o ponto forte do Node.
- **Bem posicionada:** vácuo pós-MinIO + zero concorrência séria em Node.
- **Com um teto:** o Node tem limites estruturais (seção 6) que tornam inviável competir em throughput bruto ou em durabilidade distribuída com erasure coding.

Regra de ouro do projeto: **compatibilidade de protocolo é o produto**. Um servidor 100% rápido e 80% compatível é inútil — os clientes (aws-cli, rclone, Terraform, s3fs) falham de formas silenciosas e destrutivas. Um servidor com 70% da velocidade e 99% de compatibilidade é um produto.

Nome: usar **"S3-compatible"**, nunca "S3". A API em si é reimplementável (MinIO, Ceph e Garage fazem isso abertamente), mas "S3" é marca registrada da AWS.

---

## 2. Superfície da API — o que "igual ao S3" realmente significa

A API do S3 tem centenas de operações. O que faz clientes reais funcionarem é um subconjunto bem definido. Prioridade por impacto:

### P0 — sem isso nada funciona

| Operação | Rota |
|---|---|
| ListBuckets | `GET /` |
| CreateBucket / DeleteBucket / HeadBucket | `PUT` / `DELETE` / `HEAD` `/{bucket}` |
| ListObjectsV2 | `GET /{bucket}?list-type=2` |
| PutObject | `PUT /{bucket}/{key}` |
| GetObject | `GET /{bucket}/{key}` |
| HeadObject | `HEAD /{bucket}/{key}` |
| DeleteObject | `DELETE /{bucket}/{key}` |
| GetBucketLocation | `GET /{bucket}?location` |

Meta: `aws s3 ls` e `aws s3 cp` funcionam.

### P1 — sem isso ferramentas reais quebram

- **Multipart completo**: `POST ?uploads` (Create), `PUT ?partNumber=N&uploadId=X` (UploadPart), `POST ?uploadId=X` (Complete), `DELETE ?uploadId=X` (Abort), `GET /{bucket}?uploads` (List), `GET ?uploadId=X` (ListParts). Todo upload maior que 8 MiB do aws-cli usa isso.
- **DeleteObjects** em lote: `POST /{bucket}?delete` (máx. 1000 chaves).
- **CopyObject** via header `x-amz-copy-source`, e **UploadPartCopy**.
- **Range GET** (`Range: bytes=`) e headers condicionais (`If-Match`, `If-None-Match`, `If-Modified-Since`, `If-Unmodified-Since`).
- **ListObjects V1** (`GET /{bucket}` sem `list-type`, paginação por `marker`) — rclone e ferramentas antigas ainda usam.
- **Presigned URLs** (SigV4 via query string).

Meta: `rclone sync` e `mc mirror` passam.

### P2 — o que separa brinquedo de produto

Versionamento (`?versioning`, `?versions`, `versionId`), bucket policy + subconjunto de IAM, `?cors`, `?lifecycle`, `?tagging`, `?acl`, POST form upload (upload direto do browser com policy assinada), SSE-C / SSE-S3, notificações de evento (webhook), `GetObjectAttributes`.

### Fora de escopo (declarar explicitamente)

Object Lock/WORM compliance, Replication cross-region, Glacier/tiering, S3 Select, Access Points, Requester Pays, SigV4a.

---

## 3. Engenharia reversa — a metodologia

Esta é a parte operacional. Não adivinhe o formato do wire; **observe-o**.

1. **Captura de tráfego real.** Rodar `aws-cli`, `@aws-sdk/client-s3`, `boto3`, `rclone` e `mc` contra um servidor de referência (fork `pgsty/minio`, SeaweedFS, ou a AWS real) através do `mitmproxy`. Salvar pares request/response como *golden fixtures* e transformá-los em testes de replay. Esta é a fonte de verdade — mais confiável que a documentação.

2. **`aws --debug` como debugger de assinatura.** O aws-cli imprime o `CanonicalRequest` e o `StringToSign` que ele calculou. Fazer o servidor logar os seus e diffar as duas strings. Isso reduz um bug de SigV4 de horas para minutos — é o loop de debug mais valioso do projeto. Construir isso na semana 1.

3. **Ceph `s3-tests` como métrica objetiva.** É a suíte de conformância S3 de facto (boto3/pytest), usada por MinIO, Ceph e Garage. **A KPI principal do projeto deve ser "% de s3-tests passando"**, medida em CI a cada commit. Sem essa métrica, "compatibilidade" vira opinião.

4. **Matriz de interoperabilidade em CI.** Containers rodando: `aws-cli`, `@aws-sdk/client-s3` (versão mais nova, **não** pinada), `boto3`, `rclone`, `mc`, `s5cmd`, backend S3 do Terraform, `s3fs-fuse`. Cada um com um cenário de smoke test.

5. **Teste diferencial.** Mesma requisição enviada ao seu servidor e a um servidor de referência; diffar status, headers e corpo XML. Pega divergências que nenhuma suíte cobre.

---

## 4. Armadilhas de protocolo — onde 90% das implementações falham

Estas não são detalhes. Cada uma delas causa **corrupção silenciosa de dados** ou incompatibilidade total.

### 4.1 `aws-chunked` — a armadilha nº 1

O aws-cli, por padrão, **não envia o corpo do objeto cru**. Envia com framing de assinatura por chunk:

```
<tamanho-em-hex>;chunk-signature=<64 hex chars>\r\n
<dados-do-chunk>\r\n
...
0;chunk-signature=<sig-final>\r\n\r\n
```

Se o servidor gravar o corpo direto no disco, **grava o framing junto com os dados e corrompe todo objeto enviado pelo CLI** — sem nenhum erro. Sinalizadores:

- `x-amz-content-sha256: STREAMING-AWS4-HMAC-SHA256-PAYLOAD` (chunks assinados) ou `STREAMING-UNSIGNED-PAYLOAD-TRAILER` (chunks sem assinatura, checksum no trailer).
- `Content-Encoding: aws-chunked`.
- **`Content-Length` é o tamanho *codificado*.** O tamanho real do objeto vem em `x-amz-decoded-content-length` — usar este para o metadado de tamanho.
- As assinaturas de chunk formam uma **cadeia**: a de cada chunk é calculada sobre a anterior, com a assinatura do header como semente.

### 4.2 Checksums CRC32 padrão — armadilha nova e ativa

A partir do **`@aws-sdk/client-s3` v3.729.0** (jan/2025), o SDK calcula um **CRC32 automaticamente** em uploads quando nenhum checksum é fornecido, e o envia via `x-amz-trailer: x-amz-checksum-crc32`. Servidores que não implementam isso respondem `NotImplemented: Header 'x-amz-checksum-crc32' not implemented` — **isso quebrou o Cloudflare R2** e vários outros serviços compatíveis.

Implicação: suportar trailers e a família `x-amz-checksum-*` (CRC32, CRC32C, SHA1, SHA256) **não é opcional em 2026**. Testar sempre contra a versão mais recente do SDK, nunca pinada.

### 4.3 ETag

- PUT simples: `"<md5-hex-do-conteúdo>"`.
- Multipart: `"<md5-hex-da-concatenação-binária-dos-MD5-de-cada-parte>-<N>"`, onde N é o número de partes.

`rclone` e `aws s3 sync` **validam isso** para decidir se um arquivo mudou. ETag errado = sync infinito ou, pior, arquivos considerados idênticos quando não são. MD5 é criptograficamente morto mas é contrato de wire — obrigatório.

### 4.4 Ordenação de chaves

`ListObjectsV2` deve ordenar por **bytes UTF-8**, não por code units UTF-16. Comparação de string em JavaScript (`<`, `sort()`, `localeCompare`) diverge da ordem de bytes em surrogate pairs (emoji, CJK estendido). Comparar `Buffer`s, ou delegar a ordenação ao SQLite armazenando a chave como `BLOB` (comparação `memcmp` = ordem de bytes).

### 4.5 Codificação de URL na assinatura

Na assinatura SigV4, o S3 é a **exceção** entre os serviços AWS: a URI canônica é codificada **uma vez**, não duas. Espaço vira `%20` (nunca `+`), `/` permanece literal, e `!'()*` precisam ser percent-encoded (`encodeURIComponent` não faz isso). Errar aqui = todo objeto com espaço ou acento no nome falha com `SignatureDoesNotMatch`.

### 4.6 Header `Host`

O SigV4 assina o header `Host`. Um reverse proxy que reescreve `Host` (ou termina TLS mudando o hostname) **quebra todas as assinaturas**. Resolver bucket a partir de `Host` primeiro (virtual-host style: `bucket.dominio/key`), com fallback para path style (`dominio/bucket/key`). Documentar explicitamente a configuração de proxy e o tratamento de `X-Forwarded-Host`.

### 4.7 Códigos de erro XML

```xml
<Error><Code>NoSuchKey</Code><Message>...</Message><Resource>...</Resource><RequestId>...</RequestId></Error>
```

Os SDKs fazem dispatch em `<Code>` e a **lógica de retry depende dele**: `SlowDown`, `InternalError` e `RequestTimeout` são retentáveis; `NoSuchKey` e `AccessDenied` não. Código errado faz o cliente ou desistir cedo demais ou entrar em retry infinito.

### 4.8 Formatos menores que quebram clientes

- `Last-Modified`: RFC 1123. No XML: ISO 8601 com milissegundos (`2009-10-12T17:50:30.000Z`).
- Namespace XML: `http://s3.amazonaws.com/doc/2006-03-01/`.
- `x-amz-request-id` e `x-amz-id-2` em **toda** resposta.
- `Expect: 100-continue`: o aws-cli envia. Registrar o handler `checkContinue` do `node:http` para **autenticar antes do corpo** — senão o cliente sobe 5 GB antes de receber 403.
- `encoding-type=url`, `CommonPrefixes` com `delimiter`, `continuation-token` opaco.

---

## 5. Pontos fortes do Node

1. **Streams com backpressure de primeira classe.** `pipeline(req, hashers, fs.createWriteStream())` propaga erro e limpa recursos corretamente. Mover bytes entre socket e disco é exatamente o que o libuv faz bem.
2. **Alta concorrência com pouca memória por conexão.** Object storage é workload de I/O; milhares de conexões lentas em paralelo é o cenário ideal do event loop.
3. **`node:crypto` é OpenSSL nativo.** MD5, SHA-256, HMAC e AES-GCM rodam em C, não em JS.
4. **Node 24 traz `node:sqlite` embutido** (`DatabaseSync`, `StatementSync`, `Session`, `backup`) — banco de metadados transacional com **zero dependências**. Verificado neste ambiente (Node v24.18.0).
5. **Embarcabilidade — a vantagem real.** `npm i s3node` e subir um servidor no mesmo processo do teste, sem baixar binário Go/Rust, sem Docker. Nenhum concorrente oferece isso hoje (o `s3rver` oferecia e morreu).
6. **Programabilidade — o diferencial de produto.** Hooks JS por requisição: transformação de objeto no upload, autenticação customizada, eventos, roteamento por tenant. "Object storage programável" é algo que MinIO e Garage não fazem bem, e é natural em Node.
7. **Iteração rápida em conformância.** Como compatibilidade é o produto, velocidade de correção importa mais que velocidade de execução.

---

## 6. Pontos fracos — estruturais, não contornáveis

1. **Sem `sendfile` / zero-copy.** Verificado: o módulo `fs` do Node não expõe `sendfile`. Todo GET faz kernel → userspace → kernel, com duas cópias extras e pressão de GC nos buffers. Go (`http.ServeContent`) e Rust usam `sendfile` direto. **Este é um teto estrutural de throughput.** Mitigações: `highWaterMark` grande (1 MiB), offload de leituras quentes para nginx via `X-Accel-Redirect`, ou addon nativo.

2. **Hashing consome CPU do event loop.** `hash.update()` é síncrono na thread principal. MD5 + SHA-256 + CRC32 sobre cada byte satura um core bem antes de saturar um NVMe. Mitigação: calcular **apenas** os digests que a requisição realmente exige, e mover para worker threads acima de um limiar de tamanho.

3. **Single-thread.** Usar todos os cores exige `cluster` com `SO_REUSEPORT` — o que reabre o problema do banco de metadados compartilhado (WAL do SQLite com múltiplos escritores gera `SQLITE_BUSY`). Alternativa: um processo/worker único de metadados com RPC.

4. **Erasure coding é inviável.** Reed-Solomon em JS puro ou WASM é lento demais. Isso **elimina** a estratégia de durabilidade do MinIO. Durabilidade fica dependente de RAID/ZFS embaixo, ou de replicação simples (mais cara em disco).

5. **Cauda de latência por GC.** Pausas de GC sob alto throughput geram picos de p99. Inimigo: churn de alocação. Evitar `Buffer.concat` e manipulação de string no caminho quente.

6. **Sem consenso distribuído prático.** Raft em JS existe, mas nenhuma implementação é battle-tested. Multi-node com consistência forte é território de Go/Rust.

**Leitura honesta do teto:** com clustering, o Node deve sustentar workloads de 10–25 GbE confortavelmente. A 100 GbE ou saturando NVMe, o Node vira o gargalo antes do hardware. Esses números são estimativas de ordem de grandeza — **precisam ser medidos, não assumidos** (ver seção 10).

---

## 7. Pontos críticos de segurança

Este é um serviço que guarda credenciais, é exposto à internet e controla acesso a dados. Os itens abaixo não são melhorias incrementais — cada um é uma falha que vaza ou destrói dados.

- **Path traversal em chaves.** Uma chave de objeto pode conter `../`. **Nunca** mapear a chave diretamente para um caminho de filesystem. O armazenamento content-addressed (seção 8) elimina essa classe inteira de bug por construção — este é um dos principais motivos para adotá-lo.

- **XXE e billion-laughs no parsing XML.** Os corpos de `CompleteMultipartUpload`, `Delete` e bucket policy são XML controlado pelo atacante. Desabilitar DTD e expansão de entidades (`fast-xml-parser` com `processEntities: false`), limitar o tamanho do corpo (ex.: 1 MiB) e a profundidade de aninhamento.

- **Limites de lote.** `DeleteObjects` tem máximo de 1000 chaves por especificação. Validar no servidor — não confiar no cliente.

- **Comparação de assinatura.** Usar `crypto.timingSafeEqual`, nunca `===`. Comparação de string vaza a assinatura por timing.

- **Janela de replay.** Rejeitar requisições com skew de relógio maior que 15 minutos. Presigned URLs: validar `X-Amz-Expires` contra o máximo de 7 dias e contra o relógio do servidor.

- **Credenciais em repouso.** O SigV4 exige o secret key em texto claro no servidor para recomputar o HMAC — não há como armazenar apenas um hash. Portanto o credential store é ativo de valor máximo: cifrar em repouso com uma master key, permissões restritas de arquivo, e nunca logar.

- **Avaliação de bucket policy / ACL.** Um bug aqui é vazamento público de dados. Default-deny; deny explícito sempre vence allow; testar a matriz de decisão exaustivamente.

- **Exaustão de recursos.** Limites de tamanho de objeto, de conexões por IP e rate limiting. Sem isso, um cliente enche o disco.

- **Integridade do header `Host`.** Ver 4.6 — além de quebrar assinaturas, a resolução de bucket via `Host` é superfície de injeção se confiar cegamente em `X-Forwarded-Host`.

---

## 8. Arquitetura recomendada

### Camada HTTP

`node:http` direto com router customizado. O roteamento do S3 é atípico — subrecursos vêm da query string (`?uploads`, `?acl`, `?delete`, `?versioning`), o que se encaixa mal em routers convencionais. Fastify é opção, mas exige desabilitar todo body parsing (corpos S3 são bytes crus) e o ganho fica pequeno. **Nunca bufferizar corpos** — `req` é stream, vai direto para o disco.

### Metadados — SQLite via `node:sqlite`

Zero dependências, transacional, WAL mode. Tabela `objects` com PK `(bucket, key BLOB, version_id)`.

**Por que banco e não filesystem para listagem:** `ListObjectsV2` com prefixo e paginação é uma *range scan ordenada*. Em SQLite: `WHERE bucket=? AND key > ? AND key < <limite-superior-do-prefixo> ORDER BY key LIMIT n` — custo O(log n + k) por índice. Com filesystem, é `readdir` sobre o bucket inteiro, sem ordem garantida: um bucket com 10M objetos torna a listagem inviável. Bônus: `BLOB` resolve a ordenação por bytes da seção 4.4 de graça.

Escape hatch se a contenção de escrita do SQLite doer: `lmdb` (escritas em batch, muito rápido).

### Dados — blobs content-addressed

Blobs em `data/<aa>/<bb>/<nome>` com fanout de 2 níveis (256×256 diretórios, evita diretórios gigantes). Nome do blob desacoplado da chave do objeto — mata path traversal e conflitos de nome (chave `a/b` e `a/b/c` coexistindo, limite de 255 bytes por componente, filesystems case-insensitive no macOS/Windows, nomes reservados do Windows).

Começar com blobs nomeados por UUID. **Deduplicação por SHA-256 vem depois** — exige refcounting e é fonte fértil de bugs de perda de dados no início.

### Caminho de escrita durável

A ordem desta sequência é crítica para correção. Executar exatamente assim:

1. Stream do corpo para `tmp/<uuid>`, **no mesmo filesystem** do destino final (senão `rename` não é atômico).
2. Calcular os hashes necessários em passagem única, via Transform stream.
3. Validar `Content-MD5`, `x-amz-content-sha256` e trailers `x-amz-checksum-*`.
4. `fsync` no arquivo, depois fechar.
5. `rename()` de tmp para o caminho final do blob.
6. `fsync` no **diretório pai** — sem isso o rename pode não sobreviver a queda de energia.
7. **Só então** commitar a linha de metadados na transação SQLite.

Um crash entre os passos 6 e 7 deixa um blob órfão — inofensivo, o GC varre depois. **Inverter a ordem** (metadados antes do blob) produz metadados apontando para blob inexistente = perda de dados observável pelo cliente.

### Multipart

Cada parte é um blob próprio; `Complete` grava um **manifesto**, sem concatenar fisicamente. Concatenar reescreveria o objeto inteiro no Complete (custo altíssimo) e destruiria a eficiência de Range GET e de `partNumber`. Contrapartida: a leitura precisa de concatenação virtual (stream sobre múltiplos arquivos) e o GC fica mais complexo.

Regras a respeitar: partes fora de ordem, em paralelo, e reenviadas (última escrita vence por `partNumber`); mínimo 5 MiB exceto a última; máximo 10.000 partes; uploads abandonados precisam de GC por lifecycle; `CompleteMultipartUpload` concorrente no mesmo `uploadId` precisa ser serializado/idempotente.

### SigV4

Cadeia de derivação da signing key:

```
kDate    = HMAC("AWS4" + secret, yyyymmdd)
kRegion  = HMAC(kDate, region)
kService = HMAC(kRegion, "s3")
kSigning = HMAC(kService, "aws4_request")
```

`kSigning` muda apenas diariamente — **cachear por `(accessKey, date, region)`** é um ganho de CPU relevante no caminho quente.

Quatro modos de payload a suportar: `UNSIGNED-PAYLOAD`, SHA-256 hex literal, `STREAMING-AWS4-HMAC-SHA256-PAYLOAD` e `STREAMING-UNSIGNED-PAYLOAD-TRAILER`.

### Dependências

Manter mínimo — a história de "embarcável" depende disso.

| Função | Escolha |
|---|---|
| HTTP | `node:http` |
| Metadados | `node:sqlite` (builtin) |
| Hashes | `node:crypto` (builtin) |
| CRC32/CRC32C | `@aws-crypto/crc32` ou WASM (não há builtin) |
| XML saída | serializer próprio (caminho quente, XML do S3 é simples) |
| XML entrada | `fast-xml-parser` com entidades desabilitadas |
| Testes | `node:test` + Ceph s3-tests + clientes reais em CI |

---

## 9. Roadmap

**P0 — Fundação. ✅ Implementado.** Esqueleto HTTP, SigV4 completo (os 4 modos de payload, incluindo decodificação `aws-chunked` e trailers), CRUD de bucket, Put/Get/Head/Delete de objeto, ListObjectsV2, XML de erro. O logger emite o CanonicalRequest e o StringToSign calculados quando uma assinatura falha, para o diff da seção 3.2.

**P1 — Ferramentas reais. ✅ Implementado.** Multipart completo, DeleteObjects, CopyObject, Range GET, headers condicionais, ListObjects V1, presigned URLs.
**Portão pendente:** validar contra `rclone sync` e `mc mirror` — nenhum dos dois está disponível neste ambiente. O que foi validado: **23/23 no `@aws-sdk/client-s3` v3.1095.0 real**, incluindo `aws-chunked` com trailer CRC32 padrão, multipart de 12 MiB via `lib-storage`, presigned GET/PUT e range cruzando fronteira de parte (`npm run test:interop`).

**P2 — Produto (a fazer).** Versionamento, bucket policy + subconjunto de IAM, CORS, lifecycle, tagging, POST form upload, SSE-C/SSE-S3, notificações de evento. Hoje esses subrecursos respondem `NotImplemented` em vez de fingir sucesso.
**Portão:** ≥ 80% do Ceph s3-tests — ainda não executado.

**P3 — Escala vertical (depois).** `cluster` com `SO_REUSEPORT`, metadados em worker thread, offload de leitura, backends de gateway (proxy para outro S3/Azure/GCS). Replicação assíncrona para réplica quente/backup — **não** como estratégia de consistência distribuída, que está fora de escopo.

---

## 10. Como validar (e critérios de abandono)

**Medir, não assumir.** Antes do P2, produzir números reais:

- Throughput de GET de objeto grande (single e multi-core), comparado a SeaweedFS no mesmo hardware. Se a diferença for maior que 5×, o teto do Node é pior que o estimado e o posicionamento precisa mudar.
- QPS de objeto pequeno — provavelmente limitado pelo banco de metadados, não pelo HTTP. Confirmar quem é o gargalo antes de otimizar.
- p99 de latência sob carga sustentada, para quantificar as pausas de GC.
- Teste de crash: matar o processo com `kill -9` durante uploads e verificar que nenhum metadado aponta para blob ausente.

**Critérios de abandono, definidos agora enquanto o julgamento é frio:**

- Se o Ceph s3-tests não chegar a 60% até o fim do P1, o custo de conformância foi subestimado.
- Se o throughput de GET single-node ficar abaixo de 1 GB/s por core, a proposta de valor precisa recuar para "ferramenta de dev/teste" em vez de "servidor de produção".

---

## 11. Posicionamento

Não é "MinIO em Node". É o **servidor S3-compatible embarcável e programável** — `npm i`, sobe no processo, hooks em JavaScript.

| Concorrente | Situação (2026) |
|---|---|
| MinIO | Repo arquivado em fev/2026, community edition morta |
| SeaweedFS | Apache 2.0, ~31,7k stars, virou padrão do Kubeflow Pipelines |
| Garage | Rust, foco em geo-distribuído leve |
| RustFS | Rust, ~4k stars, mira drop-in do MinIO, imaturo |
| Ceph RGW | Pesado, só faz sentido se já roda Ceph |
| Zenko CloudServer | Node, mantido, mas documenta Node 10.x + yarn 1.17; foco enterprise |
| s3rver | Node, parado há 5 anos, auto-declarado test-only |

O nicho está vazio e é defensável: nenhum dos concorrentes em Go/Rust pode rodar dentro do seu processo Node, e nenhum expõe middleware em JavaScript.

**Licença:** Apache 2.0 ou MIT. AGPL foi exatamente o caminho que corroeu a confiança da comunidade no MinIO.

---

## 12. Notas de implementação

- O campo `devEngines.packageManager: pnpm` do `package.json` original fazia `npx`/`npm` falharem com `EBADDEVENGINES` dentro do repositório. Foi removido, e `engines.node` passou a `>=22.5.0` (requisito do `node:sqlite`).
- Zero dependências de runtime. O parser de XML de entrada é próprio e minúsculo: não processa DTD, declaração de entidade nem CDATA, o que torna XXE e billion-laughs impossíveis por construção em vez de por configuração — mais forte que desabilitar essas opções no `fast-xml-parser`.
- CRC32 e CRC32C são table-driven in-tree, pelo mesmo motivo.
- **Bug encontrado pelo SDK real, não pelos testes próprios:** o servidor devolvia o `x-amz-checksum-crc32` do objeto inteiro numa resposta 206 de range. O SDK valida o checksum contra os bytes que recebeu e falhava corretamente. Correção: omitir os headers `x-amz-checksum-*` em respostas parciais. É exatamente o tipo de divergência que só teste contra cliente de verdade pega — e a justificativa concreta para a metodologia da seção 3.

---

## 13. Fontes

- [MinIO Community Edition arquivada (fev/2026)](https://thecloudsupportengineer.com/the-end-of-an-era-minio-community-edition-is-archived-whats-next/) · [MinIO Is Dead, Long Live MinIO](https://blog.vonng.com/en/db/minio-resurrect/) · [MinIO encerra desenvolvimento community](https://faun.dev/co/news/devopslinks/minio-ends-community-development-positions-aistor-as-the-future/)
- [Anúncio da mudança de integridade padrão no S3 — aws-sdk-js-v3 #6810](https://github.com/aws/aws-sdk-js-v3/issues/6810) · [v3.729.0 quebra compatibilidade S3 do R2](https://community.cloudflare.com/t/aws-sdk-client-s3-v3-729-0-breaks-uploadpart-and-putobject-r2-s3-api-compatibility/758637) · [Data Integrity Protections for Amazon S3](https://docs.aws.amazon.com/sdkref/latest/guide/feature-dataintegrity.html)
- [Alternativas ao MinIO em 2026](https://akmatori.com/blog/minio-alternatives-2026-comparison) · [Self-hosted S3 depois do MinIO](https://productimpossible.com/articles/self-hosted-s3-after-minio/)
- [Zenko CloudServer (Scality)](https://github.com/scality/cloudserver) · [s3rver](https://www.npmjs.com/package/s3rver)
- [Ceph s3-tests como suíte de conformância](https://medium.com/@peeyushjhorar/s3-compatibility-tests-using-ceph-s3-library-54b048ade135)
