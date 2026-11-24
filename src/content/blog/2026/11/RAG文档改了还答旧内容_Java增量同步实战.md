---
title: "RAG文档改了还答旧内容？Java增量同步实战"
date: 2026-11-16T20:00:00+08:00
category: "AI"
tags: ["rag"]
---

> 文档在后台改了，用户提问，AI 还在念三天前的旧条款。你把文件删了，它照样能"回忆"出那段内容。你怀疑模型记性太好，其实是你的向量库里那份拷贝从来没被更新过。这篇讲清楚一件事：RAG 的知识库不是数据库表，改源文件它不会自动变。下面用 LangChain4j 加 PGVector，把"哪些 chunk 变了、怎么只重算这些"这套账算明白，代码可以直接抄。

## 一、这个问题到底是什么

### 三个症状，同一个病根

做知识库问答的项目，几乎都会撞上这三种情况：

- **改了没用**：文档更新完，AI 回答还是旧版本，客服被用户当场打脸
- **删了还在**：源文件已经下线，检索还能命中，模型照着"幽灵条款"回答
- **不敢改**：一更新就跑全量重建，几万次 embedding 调用，账单和耗时都受不了

三个症状看着不一样，病根是同一个：**向量库里存的是快照，不是引用。**

RAG 的工作方式说白了就是"开卷考试"——模型答题前，你先把可能相关的资料页撕下来塞给它。撕下来的那几张纸是复印件。原件改了、烧了，复印件一动不动。

所以 RAG 的知识库维护，本质是个**数据同步问题**，不是 AI 问题。它跟"MySQL 到数仓的增量同步"是同一类活儿，只不过同步的产物是向量。

### 为什么大家第一反应都是全量重建

因为全量重建最省心：清空、重新切、重新算、重新写。逻辑简单，天然幂等，出错重跑一遍就完事。

代价也很直接。一千篇文档、每篇切 40 块，就是 4 万块。全量重建意味着 4 万次 embedding 请求。按每百万 token 几分钱到几毛钱算，"每天全量一次"这种玩法，钱是小事，**时间**才是大事——4 万次调用跑完，文档又变了一轮。

### 真正的难点不是"怎么重建"，是"怎么知道什么没变"

这才是增量同步的命门。

你觉得可以对比文件修改时间？不行，文件系统的 mtime 在各种同步工具、容器挂载、Git checkout 下都不靠谱。对比文件内容哈希？可以，但那只到文档级别——一篇 50 页的文档改了一个字，你也得把整篇的 40 个 chunk 全部重算。

再往下想一层你会发现更麻烦的事：**切出来的 chunk 根本没有稳定身份。** 文档第一段加了一句话，后面每一块的内容都往前挪了，第 3 块和第 4 块的内容全变了——明明只是插了一句话，却触发了整篇重算。

这篇文章就是来解决这个的：给 chunk 一个能判断"变没变"的身份，然后只算变了的那些。

## 二、底层原理到底怎么回事

### 向量库里到底存了什么

一条记录，四个字段：

| 字段 | 作用 |
| --- | --- |
| id | 唯一标识，删除时要用 |
| vector | 浮点数组，检索只认它 |
| text | 原始文本，塞给模型看的 |
| metadata | 键值对，用来过滤、追溯来源 |

检索的时候，库把 query 也变成一个向量，算相似度，排前几名的 text 返回。**注意：向量是从 text 算出来的，两者必须对应。** text 改了向量不重算，检索就会按旧语义把新文本捞出来，答非所问。

这也是为什么"更新"这件事，在向量库里没有 update 语义。绝大多数向量库（PGVector、Milvus、Redis 都是）只支持 add 和 delete。所谓更新 = 删旧行 + 插新行。

一句话记住原理：**RAG 更新 = 找到失效的行，删掉，补上新的。找不准，就只能全删。**

### 给 chunk 造一个稳定身份

关键设计就一条：把 chunk 的身份拆成"位置"和"内容"两部分。

- `doc_id`：文档是谁，稳定
- `chunk_index`：在这篇文档里排第几块，切分参数不变时稳定
- `content_hash`：这块文本的 SHA-256，内容不变就不变

有了这三个，就能做判断了：

- 同一个 `(doc_id, chunk_index)`，`content_hash` 一样 → 这块没动，向量可以直接复用，**一次 embedding 都不用发**
- 一样的位置，hash 不一样 → 这块内容改了，重算
- 位置超出现有块数 → 文档变长了，新增
- 位置小于现有块数但文档变短了 → 删掉多余的

这个表就是你的"账本"。账本在 MySQL/Postgres 里，向量在向量库里，两边靠 `chunk_id` 对齐。

### 为什么不能用内容 hash 当主键

因为文档里有重复内容。免责声明、页脚、模板化的条款，切出来七八块一模一样。hash 相同，主键就撞了，后写的覆盖先写的，你丢数据还不报错。

所以 `content_hash` 只用来判断"要不要重算"，主键还是用随机 UUID。

### 切分漂移：增量同步最大的隐形杀手

这是所有增量方案落地后第一个撞上的坑。

用固定字数切分（比如 500 字一块、重叠 50 字），你在文档开头插一句话，后面所有块的内容都平移了，hash 全变。增量同步瞬间退化成全量重建——代码没 bug，效果为零。

两个缓解手段，我都建议一起上：

**第一，按结构切，不按字数切。** 优先用标题、段落、换行这些语义边界，实在超长再按字数硬切。这样插入一段话，只影响它所在的那一块。

**第二，给切分参数打版本。** 切分参数（块大小、重叠、分隔符）存在 `kb_document` 表里，参数一变，这篇文档整体重建，不要试图去 diff。参数变更本来就不是"内容变了"，硬 diff 只会得到一堆假变更。

### 可见性窗口：先删后写还是先写后删

同一篇文档要替换 40 块，删除和写入之间必然有个时间差，这个窗口里检索会看到什么？

- **先删后写**：窗口期内这篇文档等于不存在，召回变少，用户问"你们的退款政策"答"没有相关信息"
- **先写后删**：窗口期内新旧两份同时存在，同一段内容召回两次，浪费点 token，但**答案不会错**

我推荐先写后删。多花几十个 token，换掉"回答突然失忆"这种硬故障，划算。代价是检索侧必须做一次去重，按 `(doc_id, chunk_index)` 归一，同键保留分数高的那条。

### 幂等：中断了怎么办

同步跑一半挂了，重启后怎么继续？

不需要"断点续跑"这么复杂的东西。把 `content_hash` 的更新放在**向量写入成功之后**，那么挂掉的那篇文档，hash 还是旧的，下次同步自然会被判定为"需要更新"，重新走一遍。

这就是幂等的全部秘密：**用"数据已落地"作为完成标记，而不是用"我跑过一遍"作为标记。**

## 三、实战：手把手写代码

### 依赖

三个依赖：LangChain4j 本体、OpenAI 兼容的 embedding 客户端、PGVector 向量库适配。数据库驱动单独引。

```xml
<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
    <modelVersion>4.0.0</modelVersion>

    <parent>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-parent</artifactId>
        <version>4.1.2</version>
        <relativePath/>
    </parent>

    <groupId>com.example</groupId>
    <artifactId>rag-incremental-sync</artifactId>
    <version>1.0.0</version>

    <properties>
        <java.version>21</java.version>
        <langchain4j.version>1.23.0</langchain4j.version>
    </properties>

    <dependencies>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-jdbc</artifactId>
            <version>4.1.2</version>
        </dependency>

        <dependency>
            <groupId>dev.langchain4j</groupId>
            <artifactId>langchain4j</artifactId>
            <version>1.23.0</version>
        </dependency>

        <dependency>
            <groupId>dev.langchain4j</groupId>
            <artifactId>langchain4j-open-ai</artifactId>
            <version>1.23.0</version>
        </dependency>

        <dependency>
            <groupId>dev.langchain4j</groupId>
            <artifactId>langchain4j-pgvector</artifactId>
            <version>1.23.0-beta33</version>
        </dependency>

        <dependency>
            <groupId>org.postgresql</groupId>
            <artifactId>postgresql</artifactId>
            <version>42.7.14</version>
        </dependency>
    </dependencies>
</project>
```

### 两张账本表

向量表由 PGVector 自动建（`createTable(true)`），这两张表是你自己维护的账本。`kb_document` 记文档级状态，`kb_chunk` 记每块的身份和它在向量库里的 id。

```sql
CREATE TABLE kb_document (
    doc_id        VARCHAR(64)  PRIMARY KEY,
    source_uri    TEXT         NOT NULL,
    content_hash  CHAR(64)     NOT NULL,
    chunk_version INT          NOT NULL DEFAULT 1,
    version       BIGINT       NOT NULL DEFAULT 1,
    deleted       BOOLEAN      NOT NULL DEFAULT FALSE,
    synced_at     TIMESTAMP    NOT NULL DEFAULT now()
);

CREATE TABLE kb_chunk (
    chunk_id     UUID        PRIMARY KEY,
    doc_id       VARCHAR(64) NOT NULL,
    chunk_index  INT         NOT NULL,
    content_hash CHAR(64)    NOT NULL,
    synced_at    TIMESTAMP   NOT NULL DEFAULT now(),
    CONSTRAINT uk_chunk_pos UNIQUE (doc_id, chunk_index)
);

CREATE INDEX idx_kb_chunk_doc ON kb_chunk (doc_id);
```

`chunk_version` 存切分参数版本，`version` 存文档第几次修订，`uk_chunk_pos` 保证同一位置只有一条记录——这个唯一约束是防止并发同步写出两份数据的最后一道保险。

### 配置：模型和向量库

PGVector 的维度必须和 embedding 模型输出维度一致，这里统一用 1536。换模型意味着换维度，必须整库重建，没有捷径。

```java
package com.example.rag.config;

import dev.langchain4j.data.segment.TextSegment;
import dev.langchain4j.model.embedding.EmbeddingModel;
import dev.langchain4j.model.openai.OpenAiEmbeddingModel;
import dev.langchain4j.store.embedding.EmbeddingStore;
import dev.langchain4j.store.embedding.pgvector.PgVectorEmbeddingStore;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class RagVectorConfig {

    @Bean
    public EmbeddingModel embeddingModel(
            @Value("${rag.embedding.base-url}") String baseUrl,
            @Value("${rag.embedding.api-key}") String apiKey,
            @Value("${rag.embedding.model}") String modelName,
            @Value("${rag.embedding.dimensions}") Integer dimensions) {
        return OpenAiEmbeddingModel.builder()
                .baseUrl(baseUrl)
                .apiKey(apiKey)
                .modelName(modelName)
                .dimensions(dimensions)
                .maxRetries(3)
                .build();
    }

    @Bean
    public EmbeddingStore<TextSegment> embeddingStore(
            @Value("${rag.pgvector.host}") String host,
            @Value("${rag.pgvector.port}") Integer port,
            @Value("${rag.pgvector.database}") String database,
            @Value("${rag.pgvector.user}") String user,
            @Value("${rag.pgvector.password}") String password,
            @Value("${rag.pgvector.table}") String table,
            @Value("${rag.embedding.dimensions}") Integer dimensions) {
        return PgVectorEmbeddingStore.builder()
                .host(host)
                .port(port)
                .database(database)
                .user(user)
                .password(password)
                .table(table)
                .dimension(dimensions)
                .createTable(true)
                .build();
    }
}
```

对应的 `application.yml`：

```yaml
rag:
  embedding:
    base-url: https://api.openai.com/v1
    api-key: ${OPENAI_API_KEY}
    model: text-embedding-3-small
    dimensions: 1536
  pgvector:
    host: localhost
    port: 5432
    database: rag
    user: postgres
    password: postgres
    table: rag_chunk
```

`dimensions` 显式传，是因为 `text-embedding-3-small` 原生长度 1536，但同系列模型支持降维。显式声明比依赖默认值安全，至少维度不一致时你会立刻发现，而不是建表之后才发现向量长度对不上。

### 两个约定类型

同步逻辑要拿到"文档 id + 来源地址 + 正文"这三样，用一个 record 装；源头从哪读（OSS、CMS、Git 仓库）属于你业务自己的事，抽一个接口出来。

```java
package com.example.rag.sync;

/** 源头读出来的一篇文档 */
public record SourceDocument(String docId, String sourceUri, String text) {
}
```

```java
package com.example.rag.sync;

import java.util.List;

/** 源头读取器：文件系统、OSS、CMS、Git 都实现这个接口 */
public interface SourceLoader {

    List<SourceDocument> loadAll();
}
```

### 增量同步的核心类

这段是全文的重点。逻辑按顺序：算文档 hash → 查账本 → 判断能不能跳过 → 切分 → 逐块比对 → 只对变化的块发请求 → 写新块 → 删旧块。

```java
package com.example.rag.sync;

import dev.langchain4j.data.document.Document;
import dev.langchain4j.data.document.DocumentSplitter;
import dev.langchain4j.data.document.Metadata;
import dev.langchain4j.data.document.splitter.DocumentSplitters;
import dev.langchain4j.data.segment.TextSegment;
import dev.langchain4j.model.embedding.EmbeddingModel;
import dev.langchain4j.store.embedding.EmbeddingStore;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

@Service
public class KnowledgeSyncService {

    private static final Logger log = LoggerFactory.getLogger(KnowledgeSyncService.class);

    private static final int MAX_CHUNK_CHARS = 500;
    private static final int CHUNK_OVERLAP = 50;
    private static final int CHUNK_VERSION = 3;

    private final EmbeddingModel embeddingModel;
    private final EmbeddingStore<TextSegment> embeddingStore;
    private final JdbcTemplate jdbc;
    private final DocumentSplitter splitter =
            DocumentSplitters.recursive(MAX_CHUNK_CHARS, CHUNK_OVERLAP);

    public KnowledgeSyncService(EmbeddingModel embeddingModel,
                                EmbeddingStore<TextSegment> embeddingStore,
                                JdbcTemplate jdbc) {
        this.embeddingModel = embeddingModel;
        this.embeddingStore = embeddingStore;
        this.jdbc = jdbc;
    }

    /** 批量同步：单篇失败不影响其它文档，返回统计结果 */
    public SyncResult syncAll(List<SourceDocument> sourceDocs) {
        int added = 0, updated = 0, skipped = 0, failed = 0;
        for (SourceDocument doc : sourceDocs) {
            try {
                String action = syncOne(doc);
                switch (action) {
                    case "ADDED" -> added++;
                    case "UPDATED" -> updated++;
                    default -> skipped++;
                }
            } catch (Exception e) {
                failed++;
                log.error("同步失败 docId={} uri={}", doc.docId(), doc.sourceUri(), e);
            }
        }
        SyncResult result = new SyncResult(added, updated, skipped, failed);
        log.info("同步完成 {}", result);
        return result;
    }

    private String syncOne(SourceDocument doc) {
        String docHash = sha256(doc.text());
        Map<String, Object> row = queryDocRow(doc.docId());

        boolean unchanged = row != null
                && docHash.equals(row.get("content_hash"))
                && !Boolean.TRUE.equals(row.get("deleted"))
                && CHUNK_VERSION == (Integer) row.get("chunk_version");
        if (unchanged) {
            return "SKIPPED";
        }

        List<TextSegment> segments = splitter.split(Document.from(doc.text()));
        Map<Integer, ChunkRow> oldChunks = loadChunks(doc.docId());
        boolean isNew = row == null;

        // 第一轮：逐块算 hash，只挑出内容变了的
        List<String> newHashes = new ArrayList<>(segments.size());
        List<Integer> dirtyIndexes = new ArrayList<>();
        for (int i = 0; i < segments.size(); i++) {
            String h = sha256(segments.get(i).text());
            newHashes.add(h);
            ChunkRow old = oldChunks.get(i);
            if (old == null || !old.contentHash().equals(h)) {
                dirtyIndexes.add(i);
            }
        }

        // 第二轮：只对变了的块调 embedding，写新行（先写）
        int embedded = 0;
        for (int idx : dirtyIndexes) {
            String text = segments.get(idx).text();
            Metadata metadata = new Metadata();
            metadata.put("doc_id", doc.docId());
            metadata.put("source_uri", doc.sourceUri());
            metadata.put("chunk_index", idx);
            metadata.put("content_hash", newHashes.get(idx));

            String embeddingId = embeddingStore.add(
                    embeddingModel.embed(text).content(),
                    TextSegment.from(text, metadata));
            embedded++;

            jdbc.update("""
                    INSERT INTO kb_chunk (chunk_id, doc_id, chunk_index, content_hash)
                    VALUES (?, ?, ?, ?)
                    ON CONFLICT (doc_id, chunk_index) DO UPDATE
                    SET chunk_id = EXCLUDED.chunk_id,
                        content_hash = EXCLUDED.content_hash,
                        synced_at = now()
                    """, UUID.fromString(embeddingId), doc.docId(), idx, newHashes.get(idx));
        }

        // 第三轮：删除过期块（后删）——位置超界的，和内容已变但还留着旧行的
        List<String> staleIds = new ArrayList<>();
        for (Map.Entry<Integer, ChunkRow> entry : oldChunks.entrySet()) {
            int idx = entry.getKey();
            boolean outOfRange = idx >= segments.size();
            boolean contentChanged = !outOfRange && !entry.getValue().contentHash().equals(newHashes.get(idx));
            if (outOfRange || contentChanged) {
                staleIds.add(entry.getValue().chunkId());
            }
        }
        if (!staleIds.isEmpty()) {
            embeddingStore.removeAll(staleIds);
            for (String id : staleIds) {
                jdbc.update("DELETE FROM kb_chunk WHERE chunk_id = ?", UUID.fromString(id));
            }
        }

        // 最后更新文档账本：这一步成功 = 本次同步完成
        jdbc.update("""
                INSERT INTO kb_document (doc_id, source_uri, content_hash, chunk_version)
                VALUES (?, ?, ?, ?)
                ON CONFLICT (doc_id) DO UPDATE
                SET source_uri = EXCLUDED.source_uri,
                    content_hash = EXCLUDED.content_hash,
                    chunk_version = EXCLUDED.chunk_version,
                    version = kb_document.version + 1,
                    deleted = FALSE,
                    synced_at = now()
                """, doc.docId(), doc.sourceUri(), docHash, CHUNK_VERSION);

        log.info("文档同步完成 docId={} 总块数={} 重算={} 删除={}",
                doc.docId(), segments.size(), embedded, staleIds.size());
        return isNew ? "ADDED" : "UPDATED";
    }

    /** 清理源里已经不存在的文档：软删账本 + 硬删向量 */
    public int purgeMissing(Set<String> aliveDocIds) {
        List<String> known = jdbc.queryForList(
                "SELECT doc_id FROM kb_document WHERE deleted = FALSE", String.class);
        int removed = 0;
        for (String docId : known) {
            if (aliveDocIds.contains(docId)) {
                continue;
            }
            List<String> ids = jdbc.queryForList(
                    "SELECT chunk_id::text FROM kb_chunk WHERE doc_id = ?", String.class, docId);
            if (!ids.isEmpty()) {
                embeddingStore.removeAll(ids);
            }
            jdbc.update("DELETE FROM kb_chunk WHERE doc_id = ?", docId);
            jdbc.update("""
                    UPDATE kb_document
                    SET deleted = TRUE, version = version + 1, synced_at = now()
                    WHERE doc_id = ?
                    """, docId);
            removed++;
        }
        return removed;
    }

    private Map<String, Object> queryDocRow(String docId) {
        List<Map<String, Object>> rows = jdbc.queryForList(
                "SELECT doc_id, content_hash, chunk_version, deleted FROM kb_document WHERE doc_id = ?",
                docId);
        return rows.isEmpty() ? null : rows.get(0);
    }

    private Map<Integer, ChunkRow> loadChunks(String docId) {
        List<ChunkRow> rows = jdbc.query("""
                SELECT chunk_id::text AS chunk_id, chunk_index, content_hash
                FROM kb_chunk WHERE doc_id = ?
                """, (rs, rowNum) -> new ChunkRow(
                rs.getString("chunk_id"),
                rs.getInt("chunk_index"),
                rs.getString("content_hash")), docId);

        Map<Integer, ChunkRow> map = new HashMap<>();
        for (ChunkRow row : rows) {
            map.put(row.chunkIndex(), row);
        }
        return map;
    }

    private String sha256(String text) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] bytes = digest.digest(text.getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(bytes);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 不可用", e);
        }
    }

    public record ChunkRow(String chunkId, int chunkIndex, String contentHash) {
    }

    public record SyncResult(int added, int updated, int skipped, int failed) {
    }
}
```

三段顺序不能乱。**先写新块，再删旧块，最后更新文档账本**——每一步失败，账本都停在"未完成"状态，下次同步自动重来。反过来的顺序（先删后写）一旦中间挂了，这篇文档就永久性缺块，而且账本显示"已同步"，你根本发现不了。

### 检索侧：必须去重

先写后删的代价就在这里。窗口期内同一位置可能有两份，按 `doc_id + chunk_index` 归并，保留分数高的。

```java
package com.example.rag.query;

import dev.langchain4j.data.embedding.Embedding;
import dev.langchain4j.data.segment.TextSegment;
import dev.langchain4j.model.embedding.EmbeddingModel;
import dev.langchain4j.store.embedding.EmbeddingMatch;
import dev.langchain4j.store.embedding.EmbeddingSearchRequest;
import dev.langchain4j.store.embedding.EmbeddingStore;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

@Service
public class RagQueryService {

    private final EmbeddingModel embeddingModel;
    private final EmbeddingStore<TextSegment> embeddingStore;

    public RagQueryService(EmbeddingModel embeddingModel,
                           EmbeddingStore<TextSegment> embeddingStore) {
        this.embeddingModel = embeddingModel;
        this.embeddingStore = embeddingStore;
    }

    /**
     * 检索并按 (doc_id, chunk_index) 去重。
     * 多召回一倍，去重后截断，避免同步窗口期的重复块挤掉别的有用内容。
     */
    public List<String> retrieve(String question, int topK) {
        Embedding queryEmbedding = embeddingModel.embed(question).content();

        EmbeddingSearchRequest request = EmbeddingSearchRequest.builder()
                .queryEmbedding(queryEmbedding)
                .maxResults(topK * 2)
                .minScore(0.55)
                .build();

        List<EmbeddingMatch<TextSegment>> matches = embeddingStore.search(request).matches();

        Map<String, EmbeddingMatch<TextSegment>> best = new LinkedHashMap<>();
        for (EmbeddingMatch<TextSegment> match : matches) {
            String docId = match.embedded().metadata().getString("doc_id");
            Integer chunkIndex = match.embedded().metadata().getInteger("chunk_index");
            String key = docId + "#" + chunkIndex;
            best.merge(key, match, (a, b) -> a.score() >= b.score() ? a : b);
        }

        List<EmbeddingMatch<TextSegment>> sorted = new ArrayList<>(best.values());
        sorted.sort((a, b) -> Double.compare(b.score(), a.score()));

        return sorted.stream()
                .limit(topK)
                .map(m -> m.embedded().text())
                .toList();
    }
}
```

`minScore(0.55)` 不是随便写的。0.5 以下基本是"同一话题但答不上问题"的噪声，塞进去只会让模型跑偏；0.75 以上又会漏掉换过说法的正确内容。实际项目里这个值要拿你自己的评测集扫一遍，别抄。

### 跑起来：加锁、分页、定时

定时任务最怕两件事：上一次没跑完又起一次，两个实例同时扫同一批文档。一把 PostgreSQL 咨询锁就够，不用上分布式调度框架。

```java
package com.example.rag.sync;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.Set;
import java.util.stream.Collectors;

@Component
public class KnowledgeSyncJob implements ApplicationRunner {

    private static final Logger log = LoggerFactory.getLogger(KnowledgeSyncJob.class);
    private static final long LOCK_KEY = 2026111601L;

    private final KnowledgeSyncService syncService;
    private final SourceLoader sourceLoader;
    private final JdbcTemplate jdbc;

    public KnowledgeSyncJob(KnowledgeSyncService syncService,
                            SourceLoader sourceLoader,
                            JdbcTemplate jdbc) {
        this.syncService = syncService;
        this.sourceLoader = sourceLoader;
        this.jdbc = jdbc;
    }

    @Override
    public void run(ApplicationArguments args) {
        syncOnce();
    }

    @Scheduled(cron = "0 30 2 * * *", zone = "Asia/Shanghai")
    public void syncOnce() {
        Boolean locked = jdbc.queryForObject(
                "SELECT pg_try_advisory_lock(?)", Boolean.class, LOCK_KEY);
        if (!Boolean.TRUE.equals(locked)) {
            log.warn("已有同步任务在跑，本次跳过");
            return;
        }
        try {
            List<SourceDocument> docs = sourceLoader.loadAll();
            syncService.syncAll(docs);
            Set<String> alive = docs.stream()
                    .map(SourceDocument::docId)
                    .collect(Collectors.toSet());
            int removed = syncService.purgeMissing(alive);
            if (removed > 0) {
                log.info("清理已下线文档 {} 篇", removed);
            }
        } finally {
            jdbc.queryForObject("SELECT pg_advisory_unlock(?)", Boolean.class, LOCK_KEY);
        }
    }
}
```

`SourceLoader` 是你自己的源头读取器——从 OSS 拉文件、从 CMS 拉文章、从 Git 仓库读 Markdown 都行，只要产出 `List<SourceDocument>`。这里不展开，因为它跟 RAG 无关，属于你业务本身。

还有个小细节：`@Scheduled` 加 `ApplicationRunner` 双入口，是为了服务重启后能立刻补一次同步。重启往往发生在发布之后，而发布经常伴随文档更新，这时候等第二天凌晨两点太晚了。第一次全量扫会慢，但增量跑起来后只是查一圈 hash，几十毫秒的事。

## 四、踩坑经验和最佳实践

**只 hash 正文，不 hash metadata。** 这个坑最阴。你的 chunk 上可能挂 `access_level`、`tenant_id`、`effective_date` 这类字段，用于权限过滤和时效判断。这些字段改了，正文没改，hash 一样，同步直接跳过。结果是权限收紧了但向量库里还是旧标签，越权召回。解决办法：metadata 参与文档级 hash 计算，或者单独存一份 metadata 版本号。

**把 embedding 调用包进事务里。** 见过有人这么写：`@Transactional` 方法里循环调 embedding 再写库。一次同步几十秒，数据库连接占着不放，连接池直接打满。embedding 是网络调用，天然该在事务外算完再写。我的做法是整段不用声明式事务，靠"顺序 + 账本"保证一致性。

**并发同步同一篇文档。** 两个节点同时处理一篇文档，两边都判定"需更新"，都去写，`uk_chunk_pos` 唯一约束会报错，但向量可能已经双写进去了。除了咨询锁，文档级也要防：`SELECT ... FOR UPDATE` 锁住 `kb_document` 那一行，或者干脆按 `doc_id` 取模分片给不同节点。

**embedding 接口限流不处理。** 全量重建时 4 万个请求打过去，供应商的 RPM 限制会直接 429。必须分批（每批 64～128）+ 指数退避重试。LangChain4j 的模型 builder 上有 `maxRetries`，但它只处理单次失败，整体节奏还得你自己控。

**删除只删账本不删向量。** 我见过最离谱的一版：`DELETE FROM kb_document` 写得漂亮，向量表里 4 万行一动不动。半年后审计发现向量库比源文件多出三千篇已下线的文档。删除必须两边都动，而且向量先删——向量是脏数据的实际来源。

**换 embedding 模型不重建。** 维度不同直接报错还算好的，维度相同（比如都是 1536）才可怕：新旧向量混在一张表里，检索质量断崖式下降，还不报错。换模型必须换表，或者加 `model_version` 字段做全量重刷。

**切分参数一改就 diff。** 前面讲过，切分参数必须进账本。参数变了就整篇重建，别指望 hash 比对能识别出"这是参数变化不是内容变化"。

## 五、性能对比和技术选型

拿一个真实规模的场景算账：1000 篇文档，每篇平均 40 个 chunk，合计 4 万块。每天约 2% 的文档有更新（20 篇，涉及约 800 块）。

| 方案 | embedding 调用量 | 典型耗时 | 备份/回滚 | 适用规模 |
| --- | --- | --- | --- | --- |
| 每日全量重建 | 40000 次/天 | 40～90 分钟 | 无需 | 500 篇以内 |
| 增量同步（本文方案） | 800 次/天 + 20 篇重切 | 30～60 秒 | 需保留账本 | 1000～10 万篇 |
| 双表切换（蓝绿） | 全量 + 双份存储 | 与全量相同 | 秒级回滚 | 有合规要求的大库 |

成本差距接近 50 倍，耗时差距两个数量级。这个量级下，增量同步不是"优化"，是能不能每天更新的问题。

选型上给三条明确建议：

- **500 篇以内、每天一次**：别折腾增量，全量重建更省心。维护一套 diff 逻辑的隐性成本，比省下来的那点钱贵。
- **1000 篇以上、要求准实时**：必须增量。这是本文方案的甜区。
- **有合规/可回滚要求**：双表切换。写入新表，校验通过后改检索指向，出问题秒级切回。存储翻倍，但回滚能力值这个钱。

向量库选 PGVector 的理由很实在：账本表在 Postgres 里，向量表也在 Postgres 里，一个 `JOIN` 就能核对"账本说有哪些块、向量库里实际有哪些块"，对账天然免费。用 Milvus 之类独立向量库，这笔对账就得自己写代码，而增量同步最怕的就是两边对不上。

## 六、总结

增量同步的核心从来不是"少算几个向量"，而是**能明确判断出什么没变**。做不到这一点，所有优化都是空谈。

三句话记住整套设计：

- chunk 的身份由 `doc_id + chunk_index + content_hash` 三件套决定，位置管复用，hash 管重算
- 顺序是"先写新、后删旧、最后记完成"，账本最后更新，天然幂等
- 检索按 `(doc_id, chunk_index)` 去重，用几十个 token 换掉"更新时短暂失忆"的硬故障

还有一条容易被忽略的：这套东西本质是**数据管道**，不是 AI 功能。既然是管道，就该有对账、有幂等、有失败重试、有并发控制——这些老掉牙的工程要求，一个都不能少。RAG 项目翻车，十次里有七次不在模型，在这条管道上。

文 / 会编程的吕洞宾

## 参考资料

- [LangChain4j Documentation - Embedding Stores](https://docs.langchain4j.dev/tutorials/embedding-stores)
- [LangChain4j Documentation - RAG (Document Splitters)](https://docs.langchain4j.dev/tutorials/rag)
- [pgvector: Open-source vector similarity search for Postgres](https://github.com/pgvector/pgvector)
- [PostgreSQL Documentation - Explicit Locking (Advisory Locks)](https://www.postgresql.org/docs/current/explicit-locking.html#ADVISORY-LOCKS)
