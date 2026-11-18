---
title: "Redis 向量搜索：Java RAG 一个库搞定"
date: 2026-10-11T20:00:00+08:00
category: "AI"
tags: ["AI", "rag", "redis"]
---

> 做 RAG，最容易被忽略的一步是「向量存哪儿」。很多团队一听向量数据库，就去申请 Milvus、Pinecone 的资源和预算，可项目里早就在跑 Redis——缓存、分布式锁、排行榜都指着它。Redis 8 已经把向量检索内置进主线，建索引、相似度搜索、按标签过滤一套齐全。你不需要再引一个新中间件，也不用多养一套运维。这篇把「Redis 当向量库」讲透：原理、Spring AI 集成代码、踩坑和选型，照着做能跑起来。

## 一、这个问题到底是什么

先给结论：向量数据库不神秘，它就是「存向量 + 按相似度找出最近的几个」这一层索引。Redis 从 8 开始把查询引擎（Query Engine，早期叫 RediSearch）并进主发行版，你手里那个存缓存的 Redis，顺带就能存向量、做相似度检索。

RAG（检索增强生成）里，向量库只干一件很具体的活：文档切块、转成向量存进去；用户提问时把问题也转成向量，找出最接近的几块原文，交给大模型。它不参与生成，只负责「翻资料」。

真正卡住人的不是原理，是选型。很多人的默认假设是「向量数据库听着就专业，得单独部署一套」。可项目里的真实约束往往相反：

- **运维成本。** 多一个中间件，就多一套监控、备份、扩容和故障预案。
- **数据一致性。** 向量和业务数据分家，更新、删除要跨库对齐，漏一处就是脏数据。
- **预算。** 独立向量库大多按节点或内存收费，小团队光是「先跑起来」就要算一笔账。

Redis 恰好在这三点上占便宜：它大概率已经在你架构里了。同一份实例存向量，省掉一个组件，也省掉跨库同步那堆麻烦。代价是它的向量能力不如专用库那么深，边界在哪，第五节讲清楚。

这篇文章解决的问题很具体：**在 Spring Boot 项目里用 Spring AI 接 Redis 向量库，写一套能跑的 RAG 检索服务**。你只要会 Java 和 Spring Boot，向量搜索的原理现场讲。

## 二、底层原理到底怎么回事

### 向量检索到底在检索什么

Embedding 模型把一段文字变成一串浮点数（比如 1536 个 float）。这串数字就是这段文字在「语义空间」里的坐标：意思越近，坐标越近。「怎么退款」和「申请退货的流程」字面完全不同，坐标却挨得很近。

于是「找相关资料」就变成一道数学题：给定问题的坐标，在库里找离它最近的几个坐标。距离怎么算，有三种主流度量：

- **COSINE（余弦相似度）**：只看方向、不看长度，文本检索最常用，也是 Spring AI Redis 向量库的默认值。
- **L2（欧氏距离）**：算两点之间的直线距离，对数值的绝对值敏感，图像检索常用。
- **IP（内积）**：算点积，向量归一化之后结果和余弦很接近。

一条铁律：**入库和查询必须用同一个 Embedding 模型**。换模型等于换了整套坐标系，检索结果全乱，而且它不报错，只是答案莫名其妙地不准。这个坑最阴。

### 为什么是「近似搜索」：HNSW

如果老老实实把问题向量和库里每一百万条向量逐一算距离，这叫暴力搜索（FLAT），最准但太慢。生产环境用的是近似最近邻（ANN），Redis 默认走 HNSW。

HNSW 是分层可导航小世界图（Hierarchical Navigable Small World）的缩写。打个比方：你要在一座城市里找离某个点最近的咖啡馆，不会挨家挨户量距离——先看城市级地图锁定大区域，再看街区地图缩小范围，最后在几条街里精确找。HNSW 就是一张多层「导航图」：上层节点稀少、跨度大，负责快速跳到目标附近；越往下节点越密，负责精确收敛。查询复杂度从线性降到近似对数级，代价是「近似」——极少数情况下会漏掉真正的最近邻。

三个参数决定它的脾气，Spring AI 都暴露成了配置：

- `hnsw-m`：每个节点最多连几条边。越大召回越高、内存也越高，默认 16。
- `hnsw-ef-construction`：建索引时候选范围开多大，越大索引质量越好、建得越慢，默认 200。
- `hnsw-ef-runtime`：查询时搜索开多宽，越大越准越慢，默认 10。**这是日常最该调的旋钮**，召回不够先动它。

### Redis 里向量是怎么存的

Redis 不是把向量当普通字符串塞进去。它用哈希（Hash）或 JSON 文档保存「向量 + 元数据」，再在这层结构上建索引。索引里声明：向量字段、维度、距离算法、HNSW 参数，以及哪些元数据字段允许过滤。

这里有个必须记住的点：**想按元数据过滤，字段必须提前在索引里声明类型**（TAG / TEXT / NUMERIC），否则过滤直接报错。Spring AI 里对应 `metadataFields(...)`。

Spring AI 干的活，是把「建索引、写向量、查相似度」这些 Redis 命令封装成 `VectorStore` 接口：你调 `add(...)` 存、`similaritySearch(...)` 查，不用手写裸命令。

## 三、实战：手把手写代码

### 环境准备

- JDK 21
- 一个带查询引擎的 Redis，最快用官方镜像起：

```bash
docker run -d --name redis-vector -p 6379:6379 redis/redis-stack:latest
```

Redis 8 起查询引擎已并入主发行版，官方镜像同样够用。

### pom.xml

依赖全部写全版本号，照抄能跑：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
    <modelVersion>4.0.0</modelVersion>

    <parent>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-parent</artifactId>
        <version>4.1.1</version>
        <relativePath/>
    </parent>

    <groupId>com.example</groupId>
    <artifactId>redis-vector-rag</artifactId>
    <version>1.0.0</version>

    <properties>
        <java.version>21</java.version>
    </properties>

    <dependencyManagement>
        <dependencies>
            <dependency>
                <groupId>org.springframework.ai</groupId>
                <artifactId>spring-ai-bom</artifactId>
                <version>2.0.1</version>
                <type>pom</type>
                <scope>import</scope>
            </dependency>
        </dependencies>
    </dependencyManagement>

    <dependencies>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-web</artifactId>
            <version>4.1.1</version>
        </dependency>

        <!-- 提供 ChatModel 和 EmbeddingModel -->
        <dependency>
            <groupId>org.springframework.ai</groupId>
            <artifactId>spring-ai-starter-model-openai</artifactId>
            <version>2.0.1</version>
        </dependency>

        <!-- 提供 RedisVectorStore，内含 Jedis 和 spring-boot-starter-data-redis -->
        <dependency>
            <groupId>org.springframework.ai</groupId>
            <artifactId>spring-ai-starter-vector-store-redis</artifactId>
            <version>2.0.1</version>
        </dependency>

        <!-- 提供 QuestionAnswerAdvisor，把检索和对话串成一条链 -->
        <dependency>
            <groupId>org.springframework.ai</groupId>
            <artifactId>spring-ai-vector-store-advisor</artifactId>
            <version>2.0.1</version>
        </dependency>
    </dependencies>
</project>
```

### application.yml

只贴跟本文相关的部分。Redis 连接走 Spring Data Redis 的标准前缀，向量库自己的参数走 `spring.ai.vectorstore.redis`：

```yaml
spring:
  data:
    redis:
      host: localhost
      port: 6379
  ai:
    openai:
      api-key: ${OPENAI_API_KEY}
      embedding:
        options:
          model: text-embedding-3-small
    vectorstore:
      redis:
        initialize-schema: true
        index-name: knowledge-index
        prefix: "doc:"
        distance-metric: COSINE
        vector-algorithm: HNSW
        hnsw-ef-runtime: 20
```

`initialize-schema: true` 这行别省。Spring AI 现在不会自动建索引，你不开这个开关，第一次写入就会因为索引不存在而失败。

### 代码一：手工装配 RedisVectorStore

自动配置能覆盖大多数场景，但**只要你要用元数据过滤，就必须自己定义 bean**，因为可过滤字段得在 `metadataFields(...)` 里显式声明。自己声明 `RedisVectorStore` bean 后，自动配置会自动让位。

```java
package com.example.rag.config;

import org.springframework.ai.embedding.EmbeddingModel;
import org.springframework.ai.vectorstore.redis.RedisVectorStore;
import org.springframework.ai.vectorstore.redis.RedisVectorStore.MetadataField;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import redis.clients.jedis.RedisClient;

@Configuration
public class VectorStoreConfig {

    @Bean
    public RedisVectorStore vectorStore(EmbeddingModel embeddingModel) {
        RedisClient redisClient = RedisClient.builder()
                .hostAndPort("localhost", 6379)
                .build();

        return RedisVectorStore.builder(redisClient, embeddingModel)
                .indexName("knowledge-index")
                .prefix("doc:")
                .distanceMetric(RedisVectorStore.DistanceMetric.COSINE)
                .vectorAlgorithm(RedisVectorStore.Algorithm.HNSW)
                .hnswEfRuntime(20)
                .metadataFields(
                        MetadataField.tag("source"),
                        MetadataField.numeric("year"))
                .initializeSchema(true)
                .build();
    }
}
```

关键在这两行：`MetadataField.tag("source")` 和 `MetadataField.numeric("year")`。它们告诉 Redis「这两个元数据字段以后要用来过滤」，索引会按 TAG 和 NUMERIC 建好。没声明的字段，你在查询里过滤它，Redis 直接抛错。embedding 的维度不用手填，Spring AI 会从 `EmbeddingModel` 自动取。

### 代码二：把文档灌进知识库

```java
package com.example.rag.service;

import org.springframework.ai.document.Document;
import org.springframework.ai.vectorstore.VectorStore;
import org.springframework.stereotype.Service;

import java.util.List;
import java.util.Map;

@Service
public class KnowledgeIngestService {

    private final VectorStore vectorStore;

    public KnowledgeIngestService(VectorStore vectorStore) {
        this.vectorStore = vectorStore;
    }

    public int ingest() {
        List<Document> documents = List.of(
                new Document(
                        "退款申请需在订单签收后 7 天内提交，客服审核通过后 3 个工作日到账。",
                        Map.of("source", "售后手册", "year", 2026)),
                new Document(
                        "会员积分每消费 1 元累积 1 分，积分可在结算页抵扣，100 分抵 1 元。",
                        Map.of("source", "会员规则", "year", 2026)),
                new Document(
                        "发票支持电子发票与纸质发票，电子发票在订单完成后 24 小时内开出。",
                        Map.of("source", "财务说明", "year", 2025))
        );

        vectorStore.add(documents);
        return documents.size();
    }
}
```

`document` 的第二个参数就是元数据，键名必须和前面 `metadataFields` 里声明的一致。`year` 传的是 `int`，因为索引里它是 NUMERIC 类型，传字符串会导致过滤匹配不上。真实场景里这一步一般接 ETL：用 `TokenTextSplitter` 把长文档切成块，再逐块入库；这里直接用手写文档，方便你一眼看懂数据长什么样。

### 代码三：检索 + 生成，一条链串起来

```java
package com.example.rag.service;

import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.client.advisor.vectorstore.QuestionAnswerAdvisor;
import org.springframework.ai.chat.model.ChatModel;
import org.springframework.ai.vectorstore.SearchRequest;
import org.springframework.ai.vectorstore.VectorStore;
import org.springframework.stereotype.Service;

import java.util.Map;

@Service
public class RagService {

    private final ChatClient chatClient;
    private final VectorStore vectorStore;

    public RagService(ChatModel chatModel, VectorStore vectorStore) {
        this.vectorStore = vectorStore;
        this.chatClient = ChatClient.builder(chatModel)
                .defaultSystem("你是一个客服助手，只根据提供的资料回答问题；资料里没有的，直接说不知道。")
                .build();
    }

    /**
     * 全库检索后回答，最简单的一种。
     */
    public String ask(String question) {
        QuestionAnswerAdvisor advisor = QuestionAnswerAdvisor.builder(vectorStore)
                .searchRequest(SearchRequest.builder()
                        .similarityThreshold(0.7d)
                        .topK(4)
                        .build())
                .build();

        return chatClient.prompt()
                .user(question)
                .advisors(advisor)
                .call()
                .content();
    }

    /**
     * 带元数据过滤：只在「售后手册」里找，并且限定年份。
     * 过滤条件用 advisor 的上下文参数传，不用为每种过滤重建 advisor。
     */
    public String askAfterSale(String question) {
        QuestionAnswerAdvisor advisor = QuestionAnswerAdvisor.builder(vectorStore)
                .searchRequest(SearchRequest.builder().topK(4).build())
                .build();

        return chatClient.prompt()
                .user(question)
                .advisors(a -> a.param(
                        QuestionAnswerAdvisor.FILTER_EXPRESSION,
                        "source == '售后手册' && year >= 2026"))
                .advisors(advisor)
                .call()
                .content();
    }

    /**
     * 只做检索，不生成，方便调试召回质量。
     */
    public void debugSearch(String question) {
        SearchRequest request = SearchRequest.builder()
                .query(question)
                .topK(4)
                .similarityThreshold(0.0d)
                .build();

        vectorStore.similaritySearch(request)
                .forEach(doc -> System.out.println(
                        doc.getScore() + " | " + doc.getMetadata() + " | " + doc.getText()));
    }
}
```

`QuestionAnswerAdvisor` 做的事情很直白：拿到用户问题 → 在向量库里检索 → 把检索到的原文拼进 system prompt 的 `{question_answer_context}` 占位符 → 调模型。你不用自己拼提示词，也不用自己管上下文长度。

注意 `ask(...)` 里那个 `similarityThreshold(0.7)`。它是「相关度门槛」，低于这个分数的结果会被丢掉。设太低，会把不相关的段落喂给模型，答案开始跑偏；设太高，可能一条都检索不到，模型只能干瞪眼。0.6 到 0.8 之间通常是个好起点。

过滤表达式用的是可移植语法：`source == '售后手册' && year >= 2026`。Spring AI 会把它翻译成 Redis 自己的过滤格式，所以同一套代码换到别的向量库也基本能用。

## 四、踩坑经验和最佳实践

**第一坑：索引没建，写入就炸。** Spring AI 现在默认不建索引（这是个 breaking change），`initialize-schema` 不给 `true`，第一次 `add(...)` 会报索引不存在。生产环境的正确姿势是关掉它，改由 DBA 或运维用脚本统一建索引，避免多实例并发建同一份索引。

**第二坑：过滤字段没声明类型。** 前面已经强调过，`metadataFields` 里没声明的字段，一旦出现在过滤条件里就报错。常见翻车是写完索引才发现要加一个 `tenant_id` 过滤，这时候得删索引重建。

**第三坑：维度对不上。** 索引一旦建好，向量维度就锁死了。换一个不同维度的 Embedding 模型（比如从 1536 维换到 1024 维），必须删索引重建，否则写入直接失败。换模型前先确认维度。

**第四坑：把 Redis 向量库当搜索引擎用。** Redis 也能做全文检索（`text-scorer` 支持 BM25），但要论复杂的分词、高亮、聚合，它不如 Elasticsearch。它最擅长的是「向量相似度 + 简单标签过滤」这个组合。

几个实践建议：

- **切块大小别拍脑袋。** 块太大，一个块混好几个主题，向量变模糊；块太小，语义不完整。中文场景 300 到 500 字一块是个稳妥起点，块之间留 10% 到 20% 重叠，避免一句话被从中间劈开。
- **写入要带元数据。** 至少留 `source`（来源文件）和 `updated_at`，出问题时能定位，也方便做增量更新。
- **更新文档别只 add。** 同一份文档改了，要先把旧向量删掉再写新的，否则同一个问题会召回新旧两个版本。用文档 ID 做去重是最省事的做法。
- **召回用 topK 4 到 6。** 喂太多段落会挤爆上下文、也稀释重点；太少又容易漏。这个区间对大多数问答场景够用。
- **上线前一定要看召回。** 别只盯着最终答案，用上面那个 `debugSearch` 打印分数和原文，先确认「检索出来的东西是对的」，再谈生成质量。

## 五、性能对比和技术选型

| 维度 | Redis | Milvus | pgvector | Elasticsearch |
| --- | --- | --- | --- | --- |
| 部署成本 | 极低，多数项目已有 | 高，独立集群 | 低，跟着 PG 走 | 中，需独立集群 |
| 向量规模 | 百万级以内舒服 | 十亿级 | 千万级 | 千万级 |
| 过滤能力 | TAG/TEXT/NUMERIC | 强 | 强（SQL） | 极强 |
| 全文检索 | 够用 | 一般 | 一般 | 最强 |
| 运维熟悉度 | 团队基本都熟 | 需专精 | DBA 熟悉 | 需专精 |

怎么选，一句话版本：

- **已经在用 Redis，向量规模在百万级以内**：就用 Redis，省事压倒一切。
- **向量上亿、要做大规模离线训练式检索**：上 Milvus。
- **业务主库就是 PostgreSQL，向量规模不大**：pgvector 最省心，不用引入新组件。
- **检索场景混合了复杂全文搜索 + 向量**：Elasticsearch 或 OpenSearch。

性能上，Redis 的强项是延迟——内存操作，毫秒级返回，做在线问答的实时检索非常合适。它的弱项是成本和规模：数据全放内存，量一大内存账单难看，而且集群化后的向量检索能力不如专用库成熟。**它不是要取代 Milvus，而是让你在「够用」的场景里少引一个组件。**

## 六、总结

Redis 做向量库不是什么黑科技，核心就三句话：把文字变成坐标、用 HNSW 快速找最近的坐标、按标签过滤缩小范围。Spring AI 把这一套封成了 `VectorStore` 和 `QuestionAnswerAdvisor`，代码量比你想象的小得多。

真正决定 RAG 效果好坏的不是选哪个库，而是切块策略、Embedding 模型和召回质量。库只是地基。地基选 Redis 最大的好处是：你不用再为它开一次方案评审。

动手顺序建议：先把 Docker 里的 Redis 起起来，跑通上面三段代码，用 `debugSearch` 看一眼召回结果，再决定要不要上更重的方案。别一上来就堆架构。

文 / 会编程的吕洞宾

## 参考资料

- [Spring AI — Redis Vector Store](https://docs.spring.io/spring-ai/reference/api/vectordbs/redis.html)
- [Spring AI — Retrieval Augmented Generation](https://docs.spring.io/spring-ai/reference/api/retrieval-augmented-generation.html)
- [Redis — Vector search concepts](https://redis.io/docs/latest/develop/ai/search-and-query/vectors/)
- [Redis 8 is now GA](https://redis.io/blog/redis-8-ga/)
- [Efficient and robust approximate nearest neighbor search using Hierarchical Navigable Small World graphs](https://arxiv.org/abs/1603.09320)
