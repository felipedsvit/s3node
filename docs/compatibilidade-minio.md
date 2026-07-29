# Análise de compatibilidade e oportunidades — s3node vs MinIO

> **Aviso**: A análise abaixo foi corrigida após verificação aprofundada do código-fonte do s3node.
> A versão original deste documento continha **falsos positivos significativos**: várias funcionalidades
> já implementadas foram listadas como ausentes. Abaixo, o diagnóstico correto.
>
> Issues no GitHub são referenciadas como `#N` — fechadas (#1–#12) e abertas (#13–#17).

## Metodologia

- Inspecionada a estrutura `internal/` do minio/minio no GitHub (auth, handlers, http, lock, lifecycle, pubsub, kms, etc.)
- Lidos todos os arquivos-fonte do s3node em `src/`, `bin/`, `test/` e `docs/`
- Recomendações baseadas no que **realmente** falta no s3node em comparação ao MinIO

---

## Status real das funcionalidades no s3node

### Já implementado (itens que a versão anterior do documento apontou como ausentes)

| Funcionalidade | Issue | Arquivo(s) | Detalhes |
|---|---|---|---|
| Versioning + delete markers | [#1](https://github.com/felipedsvit/s3node/issues/1) | `src/storage/metadata.ts`, `objects.ts` | Metadata v2+, listVersions, delete com version-aware |
| Bucket policies (IAM) | [#2](https://github.com/felipedsvit/s3node/issues/2) | `src/features/policy.ts` | Allow/Deny com condition operators |
| CORS | [#3](https://github.com/felipedsvit/s3node/issues/3) | `src/features/cors.ts` | Parsing, rule matching, response headers |
| Lifecycle rules | [#4](https://github.com/felipedsvit/s3node/issues/4) | `src/features/lifecycle.ts` | Parsing XML + `runLifecycle()` sweep |
| Tagging | [#5](https://github.com/felipedsvit/s3node/issues/5) | `src/features/tagging.ts` | Bucket + object tags |
| SSE-C e SSE-S3 | [#6](https://github.com/felipedsvit/s3node/issues/6) | `src/features/encryption.ts` | AES-256-CTR para dados, AES-256-GCM para key wrap |
| Notificações webhook | [#7](https://github.com/felipedsvit/s3node/issues/7) | `src/features/notifications.ts` | `NotificationDispatcher` com `fetch()`, timeout 5s, matching por evento/prefixo/sufixo |
| UploadPartCopy | [#8](https://github.com/felipedsvit/s3node/issues/8) | `src/storage/multipart.ts` | Cópia com range entre buckets/objetos |
| POST com signed policy | [#9](https://github.com/felipedsvit/s3node/issues/9) | `src/features/postpolicy.ts` | Browser uploads |
| Object Lock / WORM | [#10](https://github.com/felipedsvit/s3node/issues/10) | `src/features/objectlock.ts`, `src/storage/objects.ts` | GOVERNANCE + COMPLIANCE + legal hold |
| Cluster mode + reusePort | [#11](https://github.com/felipedsvit/s3node/issues/11) | `src/cluster.ts`, `bin/s3node.ts` | Worker pool com supervisão, restart automático, lifecycle worker dedicado, flag `--cluster` |
| Console administrativo | [#12](https://github.com/felipedsvit/s3node/issues/12) | `src/console/` | HTTP Basic auth, JSON API + SPA inline |
| Metadata store SQLite | — | `src/storage/metadata.ts` | `node:sqlite` (`DatabaseSync`), WAL mode, `busy_timeout=5000`, LRU caches com TTL, schema versionado com migrações |
| Streaming zero-copy + hashing em fluxo | — | `src/auth/chunked.ts`, `src/util/hash.ts` | `ChunkedDecoder` (Transform), `HashingStream` (múltiplos digests em uma passada) |
| Escrita atômica de blobs | — | `src/storage/blobs.ts` | Temp file → fsync → rename atômico (com fallback EXDEV) |
| Multipart upload completo | — | `src/storage/multipart.ts` | create/upload/uploadPartCopy/complete/abort com limite de concorrência (SlowDown em 1000) |
| Presigned URLs | — | `src/auth/sigv4.ts` + `test/interop/aws-sdk.mjs` | GET e PUT (verificado via SDK real) |

---

## Oportunidades reais (o que de fato falta)

### Prioridade alta

#### 1) Pool de buffers (BufferPool) — [#13](https://github.com/felipedsvit/s3node/issues/13)

- **Por que**: uploads multipart alocam/copian buffers repetidamente, pressionando o GC.
- **Onde**: `src/storage/multipart.ts`, `src/storage/objects.ts` (putObject).
- **O que fazer**: Implementar `BufferPool` em `src/util/bufferPool.ts` com pré-alocação de buffers de tamanho fixo e reuso via rent/release.
- **Risco/Esforço**: baixo; cuidado com leaks (sempre devolver ao pool).
- **Benchmark**: Executar `test/upload-part-copy.test.js` antes e depois para medir redução de GC.

#### 2) Limite de concorrência global (semáforo) — [#14](https://github.com/felipedsvit/s3node/issues/14)

- **Por que**: sem proteção global, picos de concorrência podem saturar I/O e causar OOM.
- **Onde**: `src/storage/store.ts`, `src/storage/objects.ts`.
- **O que fazer**: Adicionar `Semaphore` global configurável (`maxConcurrentWrites`). O `MultipartService` já tem `maxConcurrentUploads` com `SlowDown` — estender para writes de objeto simples.
- **Risco/Esforço**: baixo.

#### 3) Métricas e health endpoints (Prometheus) — [#15](https://github.com/felipedsvit/s3node/issues/15)

- **Por que**: monitoramento essencial para operação em produção.
- **Onde**: Criar `src/metrics.ts`; expor em rota própria (não via S3 — `metrics` já está em `NOT_IMPLEMENTED_SUBRESOURCES`).
- **O que fazer**: Instrumentar contadores (requests, active uploads, bytes in/out, error rates, latência) via `prom-client`. Expor `/metrics` em porta separada ou endpoint administrativo.
- **Risco/Esforço**: baixo.

### Prioridade média

#### 4) Quotas por bucket e rate limiting — [#16](https://github.com/felipedsvit/s3node/issues/16)

- **Por que**: proteção multi-tenant.
- **Onde**: `src/features/policy.ts` (condition context), `src/storage/metadata.ts`.
- **O que fazer**: Adicionar `maxBucketSize` e `maxObjects` checks antes de writes. Rate limit por IP/credencial (leaky-bucket in-memory para single-node).
- **Risco/Esforço**: médio.

#### 5) Fila persistente para notificações — [#17](https://github.com/felipedsvit/s3node/issues/17)

- **Por que**: notificações atuais são fire-and-forget sem retry nem persistência.
- **Onde**: `src/features/notifications.ts`.
- **O que fazer**: Adicionar fila em disco (SQLite) com retry exponencial e dead-letter. Adaptadores webhook e SQS.
- **Risco/Esforço**: médio.

### Prioridade baixa / experimental

#### 6) Erasure coding / armazenamento distribuído

- **Por que**: alta durabilidade, inspirado no MinIO.
- **Onde**: core do storage; exige arquitetura distribuída.
- **Risco/Esforço**: muito alto — apenas se o objetivo for competir com MinIO.

#### 7) HTTP/2 experimental

- **Por que**: multiplexing; S3 clients usam HTTP/1.1, então é opcional.
- **Risco/Esforço**: médio-alto; compatibilidade.

---

## Higiene do código

O código já segue boas práticas:
- Operações fs assíncronas (`fs.promises`)
- Testes de integração com SDK real (`test/interop/aws-sdk.mjs` — 25 casos)
- Proteção path traversal, validação de XML (parser SAX próprio rejeita DOCTYPE, CDATA, billion-laughs)
- `timingSafeEqual` para comparação de assinaturas

Melhorias pontuais:
- Testes de carga (wrk/autocannon) para validar limites de concorrência
- Documentação de tuning (`maxConcurrentUploads`, `--cluster`, variáveis de ambiente)

---

### Módulos internos não listados na tabela principal

| Módulo | Arquivo | Função |
|---|---|---|
| GC de blobs órfãos | `src/storage/gc.ts` | Varre blobs sem metadado correspondente (temp files órfãos, partes de multipart abortado) |
| Particionamento de ranges | `src/storage/parts.ts` | Fatia `Range` em segmentos alinhados a partes de multipart |
| Gerenciamento de buckets | `src/storage/buckets.ts` | CRUD de bucket com validação de nome e conflitos |
| Limpeza de multipart | `src/storage/multipartCleanup.ts` | Aborta uploads incompletos além do prazo |

### Oportunidade não coberta: teste de crash

O `docs/plan.md` §10 lista como critério de validação: matar o processo com `kill -9` durante uploads e verificar que nenhum metadado aponta para blob ausente. s3node ainda não tem esse teste.

---

## Sugestões técnicas específicas

```ts
// src/util/bufferPool.ts (criar)
export class BufferPool {
  constructor(private size: number, private count: number) {}
  private pool: Buffer[] = []
  rent(): Buffer { return this.pool.pop() ?? Buffer.allocUnsafe(this.size) }
  release(buf: Buffer) { if (this.pool.length < this.count) this.pool.push(buf) }
}
```

```ts
// src/storage/store.ts — semáforo
import { Semaphore } from '../util/semaphore.js'
export class ObjectStore {
  private writeSemaphore = new Semaphore(options.maxConcurrentWrites ?? 100)
  async putObject(...) {
    using permit = await this.writeSemaphore.acquire()
    // ... escrita
  }
}
```

---

## Observações legais

- MinIO é AGPLv3. Use como inspiração arquitetural, não copie código. Reimplemente ideias em TypeScript/Node.js.
- s3node é MIT — mantenha compatibilidade de licença.