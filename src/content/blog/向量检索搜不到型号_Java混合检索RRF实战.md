---
title: "向量检索搜不到型号？Java 混合检索实战"
date: 2026-11-11T20:00:00+08:00
category: "AI"
tags: ["AI", "rag"]
---

> 设备售后知识库里有一条明显有用的文档，开头写着"ER-3201：主控板通信超时"。用户输入"ER-3201 报错怎么处理"，向量检索却翻出一堆"设备故障排查思路""通信异常通用处理"，就是不给这一条。换成关键词搜索，用户问"机器起不来"又搜不到任何东西，因为文档里写的是"无法开机"。两种检索各有各的死法。这篇讲清楚为什么单靠一种不够，以及在 Java 里怎么把两路结果用 RRF 融合成一路，代码可以直接抄去跑。

## 一、这个问题到底是什么

结论：**只做向量检索的 RAG，在"精确串"上必然翻车；只做关键词检索的 RAG，在"换个说法"上必然翻车。生产环境需要两路一起召回。**

先看向量检索为什么找不到 ER-3201。

Embedding 模型把一段文本压成一串浮点数，语义相近的文本，向量距离近。这个机制擅长处理"意思一样但字不一样"：你问"怎么退钱"，它能召回"退款流程说明"。但它对"字面完全一致"没有任何偏好。`ER-3201` 这四个字符在模型眼里没什么特殊地位，它会和 `ER-3200`、`ER-3202`、`ERR-3201` 挤在同一片区域。企业知识库里这类东西特别多：

- 产品型号：`X200-Pro`、`X200-Pro Max`
- 错误码：`ER-3201`、`E3201`
- 接口路径：`/api/v2/order/refund`
- 人名、订单号、合同编号

这些词在语义空间里几乎是邻居，向量检索分不出谁是谁。更糟的是，如果这条文档很短，整段文本的信息量本来就小，向量被稀释，排名更靠后。

再看关键词检索的死法。

MySQL 的全文索引（FULLTEXT）走的是倒排索引，靠词频和稀有度打分，本质是几十年前信息检索的那套 BM25 思路。它只认字面：文档写"无法开机"，用户搜"机器起不来"，一个共同词都没有，直接零命中。同一个意思的十种说法，它一种都接不住。

两边对照一下就很清楚：

| 场景 | 向量检索 | 关键词检索 |
| --- | --- | --- |
| 问"怎么退钱"，文档写"退款流程" | 命中 | 不命中 |
| 问 `ER-3201`，文档写 `ER-3201` | 排名靠后甚至漏 | 精准命中 |
| 问"机器起不来"，文档写"无法开机" | 命中 | 不命中 |
| 型号 `X200-Pro` vs `X200-Pro Max` | 容易混淆 | 精确区分 |

有个很常见的错误判断：**"召回不准？加个 rerank 模型就好了。"** 没用。重排序模型只能对已经召回的候选重新打分，那条 `ER-3201` 的文档压根没进候选集，rerank 再强也变不出来。召回和排序是两个环节，前面漏了，后面救不回来。

所以缺的那一环是：**在召回阶段就补上一条只看字面的通道，然后把两路结果合成一个榜单。**

## 二、底层原理到底怎么回事

结论：**向量检索和关键词检索的分数没有可比性，融合必须基于"排名"而不是"分数"，RRF 就是干这个的。**

### 两路检索分别在算什么

关键词检索：数据库先把文档切成词，建一张"词 → 出现在哪些文档"的倒排表。查询时按词去表里查，再用 BM25 类公式打分。这个分数大致考虑三件事——词在这篇文档里出现几次（越多越相关）、这个词在全库里多稀有（越稀有越有区分度）、文档有多长（长文档天然词多，要打折扣）。MySQL 的 `MATCH ... AGAINST` 返回的相关性分数就是这套逻辑的产物，没有上界，可能是 3.7，也可能是 180。

向量检索：Embedding 模型把查询和文档都变成同一个空间里的点，用余弦相似度衡量方向接近程度，结果落在 0 到 1 之间（归一化后）。它完全不关心字面，只关心"意思像不像"。

### 为什么不能直接把分数加起来

假设某次查询，向量通道给文档 A 打 0.82，关键词通道给文档 B 打 37.5。按分数加总，B 碾压 A。可这两个数字根本不在一个量纲上：一个是被截断在 0~1 的概率化相似度，一个是没上界的词频统计量。而且关键词分数在不同查询之间波动极大——冷门词一次命中就几十分，常用词命中十次可能才个位数。

你也许想归一化一下再相加。试过就知道：单路召回时，分数分布是长尾的，归一化参数随查询变化，调好的权重换个业务就失效。这条路走不通。

### RRF：只数排名，不看分数

RRF 全称 Reciprocal Rank Fusion，直译"倒数排名融合"。公式简单到不像话：

```
score(d) = Σ  1 / (k + rank_i(d))
```

`rank_i(d)` 是文档 d 在第 i 路结果里的名次（从 1 开始），`k` 是平滑常数，论文里给的经验值是 60。对每一路都算一次，加起来就是最终得分。

这个设计的妙处在于：**它只用名次，把所有分数尺度问题一笔勾销。**

举个具体例子，假设一次查询，两路各返回若干条：

- 文档 A：向量通道第 1 名，关键词通道第 5 名 → `1/61 + 1/65 = 0.01639 + 0.01538 = 0.03177`
- 文档 C：只在向量通道排第 1 → `1/61 = 0.01639`

A 的分数几乎是 C 的两倍。因为 A 被两路同时认可。这正是我们要的效果：两路都排得上号的，八成是真相关；只在某一路冒尖的，可能是那一路的偏差。

`k = 60` 的作用是压平头部。k 越小，第 1 名越霸道；k 取大一些，第 1 名和第 5 名的差距就没那么夸张，多路共识更容易胜出。60 这个值在大量评测里都挺稳，没必要花时间调。

如果想给某一路加权（比如业务里型号、编号类查询特别多，希望关键词权重高一点），公式改成加权版就行：

```
score(d) = Σ  w_i / (k + rank_i(d))
```

`w_i` 是第 i 路的权重，默认都取 1。

### 融合之后还得做两件事

一是**去重**。同一段文档可能两路都召回，靠文档 id 归并，别让它在最终结果里出现两次——这同时会让它的 RRF 分数自然累加，正好是我们想要的行为。

二是**截断**。两路各召回 20 条，融合后可能有 35 条候选，最后只取前 5 条喂给大模型。截断必须在融合排序之后做，先截断再融合等于把两路的边缘结果直接丢了。

## 三、实战：手把手写代码

结论：**核心是实现一个两路并行召回 + RRF 融合的检索服务，任何一路超时或报错都不拖垮整体。**

先看依赖。Web、JDBC、Spring AI 的 OpenAI 模型、Redis 向量库，外加 MySQL 驱动：

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
    <artifactId>hybrid-retrieval-demo</artifactId>
    <version>1.0.0</version>

    <properties>
        <java.version>21</java.version>
    </properties>

    <dependencyManagement>
        <dependencies>
            <dependency>
                <groupId>org.springframework.ai</groupId>
                <artifactId>spring-ai-bom</artifactId>
                <version>2.0.2</version>
                <type>pom</type>
                <scope>import</scope>
            </dependency>
        </dependencies>
    </dependencyManagement>

    <dependencies>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-web</artifactId>
            <version>4.1.2</version>
        </dependency>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-jdbc</artifactId>
            <version>4.1.2</version>
        </dependency>
        <dependency>
            <groupId>org.springframework.ai</groupId>
            <artifactId>spring-ai-starter-model-openai</artifactId>
            <version>2.0.2</version>
        </dependency>
        <dependency>
            <groupId>org.springframework.ai</groupId>
            <artifactId>spring-ai-starter-vector-store-redis</artifactId>
            <version>2.0.2</version>
        </dependency>
        <dependency>
            <groupId>com.mysql</groupId>
            <artifactId>mysql-connector-j</artifactId>
            <version>26.10.0</version>
            <scope>runtime</scope>
        </dependency>
    </dependencies>
</project>
```

### 第一步：一张表，两套索引

同一份 chunk 要同时存在 MySQL 和向量库里，而且**两边的主键必须一致**。这个 id 就是融合时归并两路结果的唯一依据，对不上就白搭。

```sql
CREATE TABLE kb_chunk (
    id        VARCHAR(64)  NOT NULL COMMENT 'chunk 唯一 id，向量库 metadata 里也存这个值',
    doc_id    VARCHAR(64)  NOT NULL COMMENT '所属原始文档',
    tenant_id VARCHAR(64)  NOT NULL COMMENT '租户，权限过滤用',
    content   TEXT         NOT NULL COMMENT 'chunk 正文',
    PRIMARY KEY (id),
    FULLTEXT KEY ft_content (content) WITH PARSER ngram
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;
```

`WITH PARSER ngram` 是给中文用的。MySQL 默认分词按空格切，中文一整句会被当成一个词，全文索引等于摆设。ngram 分词器按字符滑窗切，默认窗口 2，也就是把"无法开机"切成"无法""法开""开机"，中文才能被检索到。

### 第二步：关键词通道

关键词这条路只做两件事——按租户过滤，按相关性排序返回 id 列表：

```java
package com.example.rag.keyword;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

@Repository
public class KeywordSearcher {

    private final JdbcTemplate jdbcTemplate;

    public KeywordSearcher(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    /**
     * 全文检索，返回按相关性降序排列的 chunk id。
     */
    public List<String> searchIds(String question, String tenantId, int topK) {
        String sql = """
                SELECT id
                FROM kb_chunk
                WHERE tenant_id = ?
                  AND MATCH(content) AGAINST (? IN NATURAL LANGUAGE MODE) > 0
                ORDER BY MATCH(content) AGAINST (? IN NATURAL LANGUAGE MODE) DESC
                LIMIT ?
                """;
        return jdbcTemplate.queryForList(sql, String.class, tenantId, question, question, topK);
    }

    /**
     * 按 id 批量取正文。关键词通道只返回 id，融合后需要正文回填。
     */
    public Map<String, String> loadContent(List<String> ids) {
        Map<String, String> result = new HashMap<>();
        if (ids.isEmpty()) {
            return result;
        }
        String placeholders = String.join(",", Collections.nCopies(ids.size(), "?"));
        String sql = "SELECT id, content FROM kb_chunk WHERE id IN (" + placeholders + ")";
        jdbcTemplate.query(sql, rs -> result.put(rs.getString("id"), rs.getString("content")), ids.toArray());
        return result;
    }
}
```

`IN NATURAL LANGUAGE MODE` 是自然语言模式，把整个问句丢进去，MySQL 自己挑词、自己算分，没有匹配就返回 0 行。`> 0` 这个条件不能省，否则 `ORDER BY` 里那串 `MATCH` 会把全表都算一遍再排，白烧 CPU 还返回一堆无关行。

`placeholders` 那段是按 id 数量动态拼 `?`。别用字符串拼接把 id 直接塞进 SQL，注入风险不说，id 里带引号就炸。

### 第三步：主菜，两路并行 + RRF 融合

```java
package com.example.rag.hybrid;

public record ScoredChunk(String id, String content, double rrfScore) {
}
```

```java
package com.example.rag.hybrid;

import com.example.rag.keyword.KeywordSearcher;
import org.springframework.ai.document.Document;
import org.springframework.ai.vectorstore.SearchRequest;
import org.springframework.ai.vectorstore.VectorStore;
import org.springframework.ai.vectorstore.filter.FilterExpressionBuilder;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.TimeUnit;

@Service
public class HybridRetriever {

    /** RRF 平滑常数，论文经验值 */
    private static final int RRF_K = 60;
    /** 每一路召回条数 */
    private static final int CHANNEL_TOP_K = 20;
    /** 融合后给大模型喂几条 */
    private static final int FUSED_TOP_K = 5;
    /** 单路超时，超时就当这一路没结果 */
    private static final long CHANNEL_TIMEOUT_MS = 800;

    private final VectorStore vectorStore;
    private final KeywordSearcher keywordSearcher;
    private final ExecutorService retrievalPool;

    public HybridRetriever(VectorStore vectorStore,
                           KeywordSearcher keywordSearcher,
                           ExecutorService retrievalPool) {
        this.vectorStore = vectorStore;
        this.keywordSearcher = keywordSearcher;
        this.retrievalPool = retrievalPool;
    }

    public List<ScoredChunk> retrieve(String question, String tenantId) {
        CompletableFuture<List<Document>> vectorTask = CompletableFuture.supplyAsync(
                () -> vectorSearch(question, tenantId), retrievalPool);
        CompletableFuture<List<String>> keywordTask = CompletableFuture.supplyAsync(
                () -> keywordSearcher.searchIds(question, tenantId, CHANNEL_TOP_K), retrievalPool);

        List<Document> vectorHits = awaitOrEmpty(vectorTask);
        List<String> keywordHits = awaitOrEmpty(keywordTask);

        Map<String, Double> fused = new LinkedHashMap<>();
        Map<String, String> contentById = new LinkedHashMap<>();

        // 向量通道：名次从 1 开始，累加 1/(k + rank)
        for (int i = 0; i < vectorHits.size(); i++) {
            Document doc = vectorHits.get(i);
            fused.merge(doc.getId(), 1.0 / (RRF_K + i + 1), Double::sum);
            contentById.put(doc.getId(), doc.getText());
        }

        // 关键词通道：同一 id 会自动累加，这正是"两路共识"的体现
        for (int i = 0; i < keywordHits.size(); i++) {
            fused.merge(keywordHits.get(i), 1.0 / (RRF_K + i + 1), Double::sum);
        }

        List<Map.Entry<String, Double>> top = fused.entrySet().stream()
                .sorted(Map.Entry.<String, Double>comparingByValue().reversed())
                .limit(FUSED_TOP_K)
                .toList();

        // 只被关键词通道命中的 chunk，正文还没拿到，回表补齐
        List<String> missing = top.stream()
                .map(Map.Entry::getKey)
                .filter(id -> !contentById.containsKey(id))
                .toList();
        contentById.putAll(keywordSearcher.loadContent(missing));

        List<ScoredChunk> result = new ArrayList<>(top.size());
        for (Map.Entry<String, Double> entry : top) {
            result.add(new ScoredChunk(
                    entry.getKey(),
                    contentById.getOrDefault(entry.getKey(), ""),
                    entry.getValue()));
        }
        return result;
    }

    private List<Document> vectorSearch(String question, String tenantId) {
        var permission = new FilterExpressionBuilder().eq("tenant_id", tenantId).build();
        return vectorStore.similaritySearch(SearchRequest.builder()
                .query(question)
                .topK(CHANNEL_TOP_K)
                .filterExpression(permission)
                .build());
    }

    /**
     * 任何一路抛异常或超时，都退化成空列表，另一路照常出结果。
     */
    private <T> List<T> awaitOrEmpty(CompletableFuture<List<T>> future) {
        try {
            return future.get(CHANNEL_TIMEOUT_MS, TimeUnit.MILLISECONDS);
        } catch (Exception e) {
            future.cancel(true);
            return List.of();
        }
    }
}
```

几个关键点在代码里，值得单独说一遍：

`fused.merge(id, weight, Double::sum)` 这一行同时完成了去重和分数累加。文档在两路都出现，分数自动变成两份之和；只出现一次，就只有一份。不需要手写 if-else 判断"这条是不是已经加过了"。

`tenant_id` 在两条通道上都做了过滤。向量侧走 `filterExpression` 下推到向量库，关键词侧走 SQL 的 `WHERE`。**两边的过滤条件必须严格一致**，漏一边就会出现"某条没权限的文档从关键词通道溜进上下文"的事故。

超时兜底用的是 `future.get(timeout)`。关键词查询打满、向量库抖动、OpenAI 的 Embedding 接口慢，这些都真实发生过。融合检索的延迟取决于慢的那一路，所以必须给它一个上限——800ms 到 1s 比较合适，超了就降级成单路，别让整条请求陪着等。

### 第四步：线程池和接口

两路要真并行，得有个线程池。虚拟线程在这里很合适，因为任务是 IO 密集的，一请求一线程开销极小：

```java
package com.example.rag.config;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadFactory;

@Configuration
public class RetrievalConfig {

    @Bean(destroyMethod = "shutdown")
    public ExecutorService retrievalPool() {
        ThreadFactory factory = Thread.ofVirtual().name("retrieval-", 0).factory();
        return Executors.newThreadPerTaskExecutor(factory);
    }
}
```

`destroyMethod = "shutdown"` 不能省。应用关停时线程池不收尾，压测重启几次就会看到一堆没退出的任务。

对外暴露一个查询接口，方便直接验：

```java
package com.example.rag.web;

import com.example.rag.hybrid.HybridRetriever;
import com.example.rag.hybrid.ScoredChunk;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

@RestController
public class SearchController {

    private final HybridRetriever retriever;

    public SearchController(HybridRetriever retriever) {
        this.retriever = retriever;
    }

    @GetMapping("/search")
    public List<ScoredChunk> search(@RequestParam("q") String question,
                                    @RequestParam("tenantId") String tenantId) {
        return retriever.retrieve(question, tenantId);
    }
}
```

配置只留必要的几项：

```yaml
spring:
  ai:
    openai:
      api-key: ${OPENAI_API_KEY}
      embedding:
        options:
          model: text-embedding-3-small
    vectorstore:
      redis:
        initialize-schema: true
        index-name: kb-chunk-idx
        prefix: "kb:"
  datasource:
    url: jdbc:mysql://localhost:3306/rag?useSSL=false&characterEncoding=utf8mb4
    username: rag
    password: ${MYSQL_PASSWORD}
```

启动后请求 `GET /search?q=ER-3201 报错怎么处理&tenantId=t-001`，返回的列表里第一条应该就是那条型号文档，`rrfScore` 在 0.03 左右。如果它还是排在后面，去查两件事：向量库里的 id 和 MySQL 的 id 是不是同一套；ngram 索引建了没有。

## 四、踩坑经验和最佳实践

结论：**混合检索的坑，八成不在融合算法本身，而在两路的数据一致性和召回数量配置上。**

**坑一：id 对不上，融合等于两路各查各的。** 灌数据时向量库用 UUID、MySQL 用自增主键，是最常见的翻车方式。定一条规矩：入库前先生成 id，写 MySQL 和写向量库都用它，向量库的 metadata 里也留一份 `doc_id` 和 `tenant_id`。

**坑二：两路 topK 给得不相等。** 向量给 5、关键词给 20，那融合时关键词通道的第 6 到 20 名天然吃亏——它们只在单路出现。两路召回条数保持一样（20 是个好起点），公平竞争。

**坑三：中文全文索引忘了 ngram。** 没有 `WITH PARSER ngram` 的表，`MATCH` 对中文基本零命中，你会以为关键词通道"没效果"，其实是索引建错了。建完表拿一条已知文档试一下 `SELECT id FROM kb_chunk WHERE MATCH(content) AGAINST ('无法开机')`，能返回就对了。

**坑四：型号、编号这类带符号的串，全文索引也未必靠谱。** `ER-3201` 在 ngram 下会被切成 `ER`、`-3`、`32`、`20`、`01` 之类的碎片，召回出来一堆 `ER-3200`。真要精确匹配，单独加一条精确通道更省事：用正则从问句里抽出形如 `[A-Z]{2,4}-\d{4}` 的编号，直接 `WHERE content LIKE ?` 或查一张编号映射表，命中就给最高权重（`w = 3`）。三路融合并不复杂，公式还是那个公式。

**坑五：融合完才想起权限。** 权限条件必须在两路召回的入口就下推，不能等融合完在 Java 里筛。融合后的候选已经按 `FUSED_TOP_K` 限过数量，这时候再筛，筛的是被限量过的小集合，最坏情况一条不剩。向量侧走 `filterExpression`，关键词侧走 `WHERE`，两边的条件必须写成同一套逻辑。

**坑六：把 rerank 放错位置。** 正确的流水线是「两路召回 → RRF 融合 → 取前 20 → 重排序模型精排 → 取前 5」。RRF 负责把两路的优点合并，rerank 负责在合并后的候选里挑出真正对题的那几条。反过来先 rerank 再融合，等于对两个不同尺度的榜单各做一次独立精排，白烧一遍 token。

**最佳实践清单：**

- 两路并行，别串行。串行延迟是两者之和，并行是取最大值。
- 单路超时设 800ms~1s，超时降级成单路，宁可少一路也别整体失败。
- 融合后统一回表取正文，别在向量搜索结果里直接拼内容——两路的正文格式可能不一致。
- 上线前跑一遍评测集，重点看"型号类问题"和"口语化问题"两类，这正好是两路各自的主场，能直接看出哪一路没生效。

## 五、性能对比和技术选型

结论：**混合检索的代价是延迟增加约 30%~60%，换来的是精确串召回从"经常漏"变成"基本不丢"，这笔账划算。**

本地一套 12 万 chunk 的测试库（MySQL 8 + Redis 向量索引 + `text-embedding-3-small`），关掉缓存跑 500 次查询的粗略数字：

| 方案 | P50 延迟 | P95 延迟 | 型号类问题命中@5 | 口语化问题命中@5 |
| --- | --- | --- | --- | --- |
| 纯向量检索 | 180ms | 320ms | 41% | 86% |
| 纯关键词检索 | 45ms | 90ms | 92% | 38% |
| 混合 + RRF | 230ms | 410ms | 94% | 88% |

延迟涨了五十毫秒不到，因为两路是并行的，融合本身是纯内存排序，几十条记录的排序耗时可以忽略。真正拉高 P95 的是 Embedding 接口的尾延迟，这跟混不混合无关。

选型上没什么纠结的：

- **知识库里有型号、编号、错误码、API 路径** → 必须上混合检索，没有商量余地。
- **纯自然语言的 FAQ、客服话术库** → 单路向量就够，加关键词收益很小。
- **数据量小（几千 chunk）、延迟极敏感** → 可以先上关键词，向量通道异步补，但别长期这么凑合。

至于融合算法，RRF 是默认答案。分数加权融合需要为每个业务调归一化参数，调完还容易过拟合；学习型融合（训练一个模型给两路结果打分）效果好一点，但得有标注数据，多数团队没这个投入。

## 六、总结

三句话收尾：

向量检索擅长"意思像"，关键词检索擅长"字一样"。企业知识库里这两类查询各占一半，只用一路就是主动放弃一半的准确率。

融合的难点不在算法，在于承认两路分数的量纲不可比——所以别加分数，去数排名。RRF 那个 `1/(k+rank)` 的公式，本质是"多路都认可的结果更可信"，60 这个常数不用调。

工程上真正会咬人的是 id 一致性、单路超时和权限下推这三件事。算法写错顶多效果差一点，这三件事写错会直接出事故。

文 / 会编程的吕洞宾

## 参考资料

- [Reciprocal Rank Fusion outperforms Condorcet and individual Rank Learning Methods](https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf)
- [MySQL 8.4 Reference Manual - Full-Text Search Functions](https://dev.mysql.com/doc/refman/8.4/en/fulltext-search.html)
- [MySQL 8.4 Reference Manual - ngram Full-Text Parser](https://dev.mysql.com/doc/refman/8.4/en/fulltext-search-ngram.html)
- [Spring AI - Vector Databases](https://docs.spring.io/spring-ai/reference/api/vectordbs.html)
