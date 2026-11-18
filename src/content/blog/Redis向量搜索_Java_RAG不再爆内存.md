---
title: "Redis 向量搜索：Java RAG 不再爆内存"
date: 2026-10-28T20:00:00+08:00
category: "AI"
tags: ["rag", "redis"]
---

> 内存向量库撑得过 demo，撑不过线上。服务一重启，向量没了；扩到两个实例，各存各的；几十万条文档压进堆里，GC 开始发抖。这篇讲怎么用 Spring AI 把向量搬进 Redis 向量搜索，让多个 Java 实例查同一份数据，顺便把索引、过滤、删除这些真上线才会撞上的事讲清楚，代码按顺序贴全，照抄能跑。

## 一、RAG 向量存内存，问题到底出在哪

内存向量库只适合单实例、数据可随时重建的场景。一旦你要求持久化、多实例一致、能扩容，它就会变成事故源。

先看一个很典型的客服知识库。2000 篇文档，每篇切 40 块，一共 8 万条 chunk。用 `text-embedding-3-small` 生成向量，维度 1536，每条向量是 1536 个 float，占 6 KB 左右。

8 万条 × 6 KB ≈ 480 MB，这还只是裸向量。JVM 里每个 `float[]` 有对象头，`Document` 对象要包一层，`metadata` 的 `Map` 又是一层，字符串再占一份。实际堆占用通常是裸数据的 1.5 到 2 倍，也就是 700 MB 到 1 GB。

一台 4C8G 的机器，堆给 4G，跑两个实例，再叠上模型客户端、HTTP 连接池、业务对象，OOM 只是时间问题。

比内存更难受的是另外两件事：

- **重启即失忆**。向量在堆里，进程一挂，全没了。下次启动要重新调 embedding 接口灌一遍，既慢又花钱。
- **多实例各存各的**。负载均衡把请求分到 A 实例，A 检索得到；分到 B 实例，B 的库里没有这批数据，回答直接变成"我不知道"。这不是模型的问题，是数据没共享。

内存向量库本来就不是为这些场景设计的。它的定位是跑通链路、写单元测试、做原型验证。真上线，向量得挪到进程外面去。

Redis 做这件事有几个现成的好处：数据跟应用进程解耦，重启不丢；多个 Java 实例连同一个 Redis，看到的是同一份向量；主从、哨兵、RDB/AOF 备份这些运维手段，你们团队大概率已经在用了，不用为向量库再学一套。

代价也得说清楚：每次检索多一次网络往返，写入要序列化，索引得自己建、自己维护。下面把这些细节一个个拆开。

本文讲的 Redis 向量搜索，指的是 Redis 自带的查询引擎（Redis Query Engine，命令是 `FT.CREATE`、`FT.SEARCH` 那一套），不是"把 float 数组转成字符串塞进 String，取出来自己算余弦相似度"那种土办法。后者没有索引，每次全量扫描，数据量一上来就废。

## 二、Redis 向量搜索的底层原理

### 2.1 一条文档进 Redis 之后长什么样

Spring AI 往 Redis 写一条文档，写的是一个 JSON，key 是"前缀 + 文档 ID"。

配置里写 `prefix: "kb:"`，文档 ID 是 `kb-1001`，那 Redis 里的 key 就是 `kb:kb-1001`。值大概长这样：

```json
{
  "content": "订单支付成功后 48 小时内发货，偏远地区顺延 1 到 2 天。",
  "embedding": [0.0123, -0.0456, 0.0789, "..."],
  "category": "logistics",
  "year": 2025,
  "tenant": "acme"
}
```

三个部分各司其职：

- `content` 是原文，检索命中后要拼进 prompt 给大模型看。
- `embedding` 是向量，只用来算相似度，人看不懂也不用看懂。
- 其余字段是元数据，用来做过滤，比如"只查 acme 租户 2024 年以后的资料"。

注意 `embedding` 字段直接躺在 JSON 顶层，跟 `content` 平级，没有嵌套在某个 `metadata` 对象里。这是 Spring AI 的实现方式，你在 `redis-cli` 里用 `JSON.GET` 一眼就能看到。想确认的话：

```bash
redis-cli JSON.GET kb:kb-1001
```

### 2.2 索引和 key 是两套东西

这是最容易搞混的一点：数据写进 Redis，不等于能被检索到。

数据是 JSON，索引是另一份结构。索引里存的是"哪些 key 有哪个字段、字段值是什么、向量在图的哪个位置"。检索的时候，Redis 查的是索引，不会去扫所有 key。

索引用 `FT.CREATE` 建，大致长这样：

```
FT.CREATE kb-index ON JSON PREFIX 1 "kb:" SCHEMA
  $.content AS content TEXT
  $.embedding AS embedding VECTOR HNSW 6 TYPE FLOAT32 DIM 1536 DISTANCE_METRIC COSINE
  $.category AS category TAG
  $.year AS year NUMERIC
```

几个关键点：

- `PREFIX 1 "kb:"` 表示只索引这个前缀开头的 key。同一个 Redis 里放多个业务的数据，靠前缀隔离。
- `DIM 1536` 是向量维度，建索引时写死。后面换 embedding 模型导致维度变了，这个索引就废了。
- `TAG` 和 `NUMERIC` 是给过滤用的字段类型。字符串枚举用 TAG，数字范围用 NUMERIC。
- `HNSW` 是索引算法，下一节讲。

索引建好之前写进去的数据不会丢。Redis 建索引时会扫描一遍匹配前缀的已有 key，把它们补进索引。所以"先写数据还是先建索引"不影响最终结果，但索引不存在的时候去检索，会直接报 `Unknown Index Name`。

真正坑的是另一件事：**索引已经存在时，改 schema 不会生效**。Spring AI 启动时看到索引名已存在，就直接跳过创建。你新加了 `tenant` 过滤字段，代码里也声明了，但 Redis 里那个索引还是老的，一过滤就报字段不存在。只能手动删索引重建，这个后面踩坑部分细说。

### 2.3 HNSW 为什么快

朴素做法是暴力比对：来一个查询向量，跟库里 8 万个向量逐个算余弦相似度，排序取前 5。这叫 FLAT，结果绝对准，复杂度是 O(n)。8 万条还能忍，800 万条就是灾难。

HNSW 全称 Hierarchical Navigable Small World，分层可导航小世界图。名字唬人，思路不复杂。

想象你要在一个陌生城市找一家评分最高的面馆。你不会挨家挨户敲门，你会先看城市地图，锁定几个大区域；再进区域看街区图，缩小到几条街；最后在街上逐家对比。HNSW 就是给向量建了这么一套多层地图：

- 上层节点少、连接跨度大，负责快速跳到目标附近。
- 下层节点密、连接细，负责在附近精挑细选。
- 查询从最上层进入，逐层下降，每层都往"离查询向量更近"的邻居走。

结果就是不用比完所有向量，只走一条近似最短路径，召回率还能保持在很高的水平。代价是内存：每个节点要存邻居列表，图本身要占空间。

三个旋钮决定它准不准、快不快、占多少内存：

| 参数 | 作用 | 调大之后 |
| --- | --- | --- |
| `M` | 每个节点最多连多少个邻居 | 召回更高，内存和建索引时间上升 |
| `efConstruction` | 建索引时每层候选队列长度 | 图质量更好，建索引更慢 |
| `efRuntime` | 查询时候选队列长度 | 结果更准，单次查询更慢 |

`M=16`、`efConstruction=200`、`efRuntime=40` 是个挺稳的起点。数据量大、对召回敏感，把 `efRuntime` 往上抬；内存紧张，先降 `M`。

### 2.4 过滤为什么必须写进索引

RAG 里很少"全库检索"。更常见的是"只在这个租户的资料里找""只要 2024 年之后的制度"。

如果先按向量召回 topK，再在 Java 里用 `if` 过滤，会出两个问题：召回 10 条，过滤完剩 1 条，甚至 0 条；真正相关的那条可能排在第 50 名，根本没进候选。

正确做法是把过滤条件下推进 Redis，让它在索引层面先缩小范围，再在剩下的集合里做向量比较。这就是为什么 `category`、`year`、`tenant` 这些字段必须提前写进 `FT.CREATE` 的 schema，并且在 Spring AI 的 `metadataFields(...)` 里声明。

还有个容易忽略的行为：**检索结果里只会带回你声明过的元数据字段**。没声明的字段虽然存在 JSON 里，但 `Document.getMetadata()` 里拿不到。所以别指望"先随便写，用的时候再取"。

## 三、实战：Spring AI 接入 Redis 向量搜索

### 3.1 起一个带查询引擎的 Redis

Redis 8 把查询引擎并进了主发行版，官方镜像直接能用：

```bash
docker run -d --name redis-vector \
  -p 6379:6379 \
  -v redis-vector-data:/data \
  redis:8 \
  redis-server --appendonly yes
```

起来之后确认模块在：

```bash
docker exec -it redis-vector redis-cli MODULE LIST
```

输出里应该能看到 `search` 和 `ReJSON`。如果 `FT.CREATE` 报 `unknown command`，说明你用的镜像不带查询引擎，换成 `redis/redis-stack-server` 镜像即可，代码一行不用改。

### 3.2 最小闭环：写入加检索

先看依赖。Spring Boot 4.1.2 做父工程，Spring AI 用 BOM 锁版本，Redis 向量存储和 OpenAI 各一个 starter：

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
    <artifactId>redis-vector-rag</artifactId>
    <version>0.0.1-SNAPSHOT</version>

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
            <groupId>org.springframework.ai</groupId>
            <artifactId>spring-ai-vector-store-advisor</artifactId>
            <version>2.0.2</version>
        </dependency>
        <dependency>
            <groupId>redis.clients</groupId>
            <artifactId>jedis</artifactId>
            <version>7.4.1</version>
        </dependency>
    </dependencies>

    <build>
        <plugins>
            <plugin>
                <groupId>org.springframework.boot</groupId>
                <artifactId>spring-boot-maven-plugin</artifactId>
                <version>4.1.2</version>
            </plugin>
        </plugins>
    </build>
</project>
```

配置文件里有两处必须写对：

```yaml
spring:
  data:
    redis:
      host: 127.0.0.1
      port: 6379
      # RedisVectorStore 需要 JedisConnectionFactory，这里必须显式指定 jedis
      client-type: jedis
  ai:
    openai:
      api-key: ${OPENAI_API_KEY}
      chat:
        options:
          model: gpt-4.1-mini
          temperature: 0.2
      embedding:
        options:
          model: text-embedding-3-small
    vectorstore:
      redis:
        initialize-schema: true
        index-name: kb-index
        prefix: "kb:"
        hnsw:
          m: 16
          ef-construction: 200
          ef-runtime: 40
```

`client-type: jedis` 是硬要求。Spring Boot 默认用 Lettuce 建连接工厂，而 `RedisVectorStore` 的自动配置要注入 `JedisConnectionFactory`。不写这一行，启动直接报找不到 bean。

主类没什么特别的：

```java
package com.example.redisrag;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class RedisVectorRagApplication {

    public static void main(String[] args) {
        SpringApplication.run(RedisVectorRagApplication.class, args);
    }
}
```

写入和检索封在一个服务里。注意 `Document` 的 `id` 自己指定，别用随机生成的——后面更新、删除都要靠它：

```java
package com.example.redisrag.service;

import org.springframework.ai.document.Document;
import org.springframework.ai.vectorstore.SearchRequest;
import org.springframework.ai.vectorstore.VectorStore;
import org.springframework.stereotype.Service;

import java.util.List;
import java.util.Map;

@Service
public class KnowledgeBaseService {

    private final VectorStore vectorStore;

    public KnowledgeBaseService(VectorStore vectorStore) {
        this.vectorStore = vectorStore;
    }

    public void loadSampleData() {
        List<Document> documents = List.of(
                Document.builder()
                        .id("kb-1001")
                        .text("订单支付成功后 48 小时内发货，偏远地区顺延 1 到 2 天。")
                        .metadata(Map.of("category", "logistics", "year", 2025, "tenant", "acme"))
                        .build(),
                Document.builder()
                        .id("kb-1002")
                        .text("签收后 7 天内支持无理由退款，退款金额原路退回，到账时间 1 到 3 个工作日。")
                        .metadata(Map.of("category", "refund", "year", 2025, "tenant", "acme"))
                        .build(),
                Document.builder()
                        .id("kb-1003")
                        .text("电子发票在订单完成后 24 小时内开具，可在订单详情页下载。")
                        .metadata(Map.of("category", "invoice", "year", 2024, "tenant", "acme"))
                        .build()
        );

        this.vectorStore.add(documents);
    }

    public List<Document> search(String question) {
        SearchRequest request = SearchRequest.builder()
                .query(question)
                .topK(3)
                .similarityThreshold(0.5)
                .build();

        return this.vectorStore.similaritySearch(request);
    }

    public void deleteById(String id) {
        this.vectorStore.delete(List.of(id));
    }
}
```

`similarityThreshold(0.5)` 是相似度下限，低于它的结果直接扔掉。不同 embedding 模型的分值分布不一样，这个值要拿真实问题试，别照抄。

写个 `CommandLineRunner` 跑一遍：

```java
package com.example.redisrag;

import com.example.redisrag.service.KnowledgeBaseService;
import org.springframework.ai.document.Document;
import org.springframework.boot.CommandLineRunner;
import org.springframework.stereotype.Component;

import java.util.List;

@Component
public class DemoRunner implements CommandLineRunner {

    private final KnowledgeBaseService knowledgeBaseService;

    public DemoRunner(KnowledgeBaseService knowledgeBaseService) {
        this.knowledgeBaseService = knowledgeBaseService;
    }

    @Override
    public void run(String... args) {
        this.knowledgeBaseService.loadSampleData();

        List<Document> hits = this.knowledgeBaseService.search("退款多久能到账");
        for (Document hit : hits) {
            System.out.printf("score=%.4f id=%s text=%s%n",
                    hit.getScore(), hit.getId(), hit.getText());
        }
    }
}
```

启动后控制台会打出命中的文档和分值。`getScore()` 返回的是 0 到 1 的相似度，越大越像。这时候去 Redis 里看，`FT._LIST` 能看到 `kb-index`，`JSON.GET kb:kb-1002` 能看到那条 JSON，连 `embedding` 数组都在。

### 3.3 加元数据过滤，顺便学会删除

自动配置不会帮你声明元数据字段。要做过滤，得自己定义 `RedisVectorStore` 这个 bean：

```java
package com.example.redisrag.config;

import org.springframework.ai.embedding.EmbeddingModel;
import org.springframework.ai.vectorstore.redis.RedisVectorStore;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import redis.clients.jedis.RedisClient;

@Configuration
public class RedisVectorStoreConfig {

    @Bean(destroyMethod = "close")
    public RedisClient redisClient(@Value("${spring.data.redis.host}") String host,
                                   @Value("${spring.data.redis.port}") int port) {
        return RedisClient.create("redis://" + host + ":" + port);
    }

    @Bean
    public RedisVectorStore vectorStore(RedisClient redisClient, EmbeddingModel embeddingModel) {
        return RedisVectorStore.builder(redisClient, embeddingModel)
                .indexName("kb-index")
                .prefix("kb:")
                .initializeSchema(true)
                .metadataFields(
                        RedisVectorStore.MetadataField.tag("category"),
                        RedisVectorStore.MetadataField.numeric("year"),
                        RedisVectorStore.MetadataField.tag("tenant"))
                .hnswM(16)
                .hnswEfConstruction(200)
                .hnswEfRuntime(40)
                .build();
    }
}
```

`MetadataField.tag(...)` 给字符串枚举，`numeric(...)` 给数字范围。字段名必须和 `Document.metadata` 的 key 完全一致，大小写也算。

**如果你已经跑过上一节的代码，先删索引再启动**，否则新 schema 不生效：

```bash
redis-cli FT.DROPINDEX kb-index DD
```

`DD` 表示连数据一起删。不加 `DD` 只删索引，JSON 还在，重建索引时会重新扫进去。

过滤查询这么写。`FilterExpressionBuilder` 拼出来的是表达式树，最终会被翻译成 Redis 的过滤语法：

```java
package com.example.redisrag.service;

import org.springframework.ai.document.Document;
import org.springframework.ai.vectorstore.SearchRequest;
import org.springframework.ai.vectorstore.VectorStore;
import org.springframework.ai.vectorstore.filter.Filter;
import org.springframework.ai.vectorstore.filter.FilterExpressionBuilder;
import org.springframework.stereotype.Service;

import java.util.List;

@Service
public class FilteredSearchService {

    private final VectorStore vectorStore;

    public FilteredSearchService(VectorStore vectorStore) {
        this.vectorStore = vectorStore;
    }

    public List<Document> search(String question, String tenant, int fromYear) {
        FilterExpressionBuilder b = new FilterExpressionBuilder();
        Filter.Expression expression = b.and(
                b.eq("tenant", tenant),
                b.gte("year", fromYear)
        ).build();

        SearchRequest request = SearchRequest.builder()
                .query(question)
                .topK(5)
                .similarityThreshold(0.4)
                .filterExpression(expression)
                .build();

        return this.vectorStore.similaritySearch(request);
    }

    public void deleteTenantData(String tenant) {
        FilterExpressionBuilder b = new FilterExpressionBuilder();
        this.vectorStore.delete(b.eq("tenant", tenant).build());
    }
}
```

`b.eq("tenant", "acme")` 对应 TAG 字段的精确匹配，`b.gte("year", 2024)` 对应 NUMERIC 的范围比较。字符串过滤一定要走 TAG，不要声明成 TEXT——TEXT 是分词全文检索，`eq` 的语义会变得很奇怪。

按条件删除要留个心眼：Spring AI 的实现是先用过滤条件搜出所有匹配的 key，再分页逐条 `JSON.DEL`，每页 1000 条。数据量小没事，几十万条的时候这条命令会跑很久，别放在 HTTP 请求里同步执行。

### 3.4 接 ChatClient，变成能答话的 RAG

检索出来还得喂给大模型。`QuestionAnswerAdvisor` 把"检索 + 拼 prompt"这两步包好了：

```java
package com.example.redisrag.web;

import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.client.advisor.vectorstore.QuestionAnswerAdvisor;
import org.springframework.ai.vectorstore.SearchRequest;
import org.springframework.ai.vectorstore.VectorStore;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class RagController {

    private final ChatClient chatClient;

    public RagController(ChatClient.Builder builder, VectorStore vectorStore) {
        this.chatClient = builder
                .defaultSystem("你是客服助手。只根据检索到的资料回答，资料里没有的内容直接说不知道，不要自己编。回答控制在三句话内。")
                .defaultAdvisors(QuestionAnswerAdvisor.builder(vectorStore)
                        .searchRequest(SearchRequest.builder()
                                .topK(4)
                                .similarityThreshold(0.5)
                                .build())
                        .build())
                .build();
    }

    @GetMapping("/ask")
    public String ask(@RequestParam("q") String question) {
        return this.chatClient.prompt()
                .user(question)
                .call()
                .content();
    }
}
```

`QuestionAnswerAdvisor` 每次调用前拿用户问题去 `vectorStore` 检索，把命中的文本拼进系统提示，再发给模型。system prompt 里那句"资料里没有就说不知道"别省，它是防止模型自由发挥的最后一道闸。

`topK(4)` 是个经验值。给太少，上下文不够；给太多，无关内容会稀释注意力，还多烧 token。

## 四、Redis 向量搜索的踩坑经验和最佳实践

**启动报找不到 `JedisConnectionFactory`**。就是漏了 `spring.data.redis.client-type: jedis`。Spring Boot 默认用 Lettuce，而向量存储的自动配置只认 Jedis 的连接工厂。这个报错信息不会提示你去改 client-type，第一次撞上要查半天。

**加了过滤字段却不生效**。索引名已存在时，`initializeSchema(true)` 什么都不做，新字段进不了 schema。表现是查询报 `Unknown field` 或者永远返回空。改完 `metadataFields` 必须 `FT.DROPINDEX` 重建，线上环境要提前规划好字段，别频繁改。

**数字存成了字符串**。`Map.of("year", "2025")` 和 `Map.of("year", 2025)` 在 Java 里都合法，但写进 JSON 一个是字符串一个是数字。NUMERIC 字段只认数字，存成字符串会导致索引失败或者过滤永远不命中。元数据类型要跟 schema 对齐，这是纯手工活，编译器帮不了你。

**换了 embedding 模型，忘了重建索引**。索引的 `DIM` 是建索引时写死的。从 1536 维换到 3072 维，写入会报维度不匹配；就算维度一样，不同模型的向量空间也不通用，老数据等于噪声。换模型就得清库重灌，没有捷径。

**Redis 内存满了，向量被悄悄淘汰**。如果 `maxmemory-policy` 是 `allkeys-lru`，内存吃紧时 Redis 会按 LRU 删 key，你的向量就这么没了，而且不报错。向量库实例必须设 `maxmemory-policy noeviction`，再配内存告警。

**一条文档塞了整篇 PDF**。`text-embedding-3-small` 的输入上限是 8191 token，超了会被截断，向量只代表前半篇。而且单条 JSON 太大，网络传输和内存都不划算。按 300 到 500 字切块，块之间留一点重叠，这是 RAG 的通用做法。

**一次 `add` 十万条**。Spring AI 会按 token 数分批调 embedding 接口，但整个 `List<Document>` 还是在内存里，接口也可能超时。按 500 到 1000 条一批，自己控制节奏，失败了好重试。

**多个环境共用一个 Redis**。`index-name` 和 `prefix` 都要按环境隔离。两个服务用同一个索引名，第二个服务启动时看到索引存在就跳过创建，然后拿着自己的 schema 去查别人的数据，错得很隐蔽。

**topK 开太大拖慢整实例**。Redis 执行命令是单线程的，一次返回几千条结果、再叠上高 `efRuntime`，同实例上其他业务的命令都得排队。向量库最好独立实例，别和缓存混用。

## 五、向量数据库性能对比和技术选型

先给结论：**已经在用 Redis、数据量在几百万条以内，选 Redis 向量搜索最省事；上亿条或者要分布式水平扩展，选 Milvus；团队已有 PostgreSQL 且不想多一个组件，选 pgvector。**

| 方案 | 适合的数据量 | 优势 | 短板 |
| --- | --- | --- | --- |
| Redis 向量搜索 | 百万级 | 复用现有运维，读写延迟低，过滤能力强 | 分布式能力弱，内存成本高 |
| Milvus | 亿级 | 存算分离，多种索引，水平扩展 | 组件多，运维成本高 |
| pgvector | 千万级以内 | 和业务数据同库，事务一致 | 高并发和大数据量下性能衰减明显 |
| 内存向量库 | 测试用 | 零依赖，启动快 | 不持久化，多实例不共享 |

延迟方面给个量级参考：单机百万条、1536 维、`topK=5`、`efRuntime=40`，HNSW 查询通常在个位数毫秒。这个数字跟硬件、数据分布、过滤条件关系很大，上线前一定拿自己的数据压一遍，别信任何人的 benchmark。

内存怎么估：`条数 × 维度 × 4 字节` 是裸向量，再乘 1.3 到 1.5 的系数（JSON 原文、图结构、Redis 自身开销）。100 万条 1536 维，裸向量 6 GB，实际准备 8 到 9 GB 比较稳。

FLAT 和 HNSW 的选择也别纠结：数据量低于 1 万条，FLAT 的精确性更值钱，查询也够快；超过这个量级，无脑 HNSW。

## 六、总结

内存向量库的问题不在性能，在于它把数据和进程绑死了。进程一重启、实例一扩容，RAG 的底座就塌了。

Redis 向量搜索的思路很直接：JSON 存文档和向量，`FT.CREATE` 建索引，HNSW 负责快速找近邻，TAG/NUMERIC 字段把过滤下推到索引层。Spring AI 把这一套包成了 `VectorStore` 接口，写入、检索、删除都是几行代码的事。

真正花时间的不是写代码，是那几个不报错只出错的地方：`client-type` 没设、索引没重建、元数据类型不对、内存策略把向量淘汰了。这几条踩过一遍，后面就顺了。

要不要上 Redis，取决于你现在的数据量和运维现状。几百万条、团队已经在用 Redis，别犹豫；上亿条、要做多租户隔离和弹性扩缩容，老老实实上 Milvus。

## 参考资料

- [Redis vector search 官方文档](https://redis.io/docs/latest/develop/ai/search-and-query/vectors/)
- [Spring AI Reference: Redis Vector Store](https://docs.spring.io/spring-ai/reference/api/vectordbs/redis.html)
- [Redis 8 正式发布说明](https://redis.io/blog/redis-8-ga/)
- [Efficient and robust approximate nearest neighbor search using Hierarchical Navigable Small World graphs](https://arxiv.org/abs/1603.09320)

文 / 会编程的吕洞宾
