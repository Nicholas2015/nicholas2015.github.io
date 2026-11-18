---
title: "RAG 权限过滤：Java 里别搜完再筛"
date: 2026-11-10T20:00:00+08:00
category: "AI"
tags: ["AI", "rag"]
---

> 客服系统接了知识库，上线第二天就出事：A 公司的员工问退款政策，大模型把 B 公司的合同条款原样念了出来。查代码才发现，检索用的是一段很顺手的写法——先从向量库拿 5 条最像的，再在 Java 里 `filter` 掉没权限的。问题是这 5 条里可能 4 条都是别人的，剩下的那 1 条还不够回答问题。这篇讲清楚权限过滤该放在哪一步、为什么放错位置不是"少几条"而是"查不到"，以及 Spring AI 里怎么把权限条件下推到向量库。

## 一、这个问题到底是什么

结论先说：RAG 里的权限过滤，必须做成向量检索的一部分，而不能挂在检索结果后面。

绝大多数 Java 项目第一次写 RAG，代码长这样：

```java
// 反面教材
List<Document> docs = vectorStore.similaritySearch(
        SearchRequest.builder().query(question).topK(5).build());
List<Document> allowed = docs.stream()
        .filter(d -> d.getMetadata().get("tenant_id").equals(user.getTenantId()))
        .toList();
```

这段代码在单租户 demo 里永远正确，因为过滤条件永远成立，`filter` 一行都筛不掉。上了多租户就原形毕露。

原因很简单：`topK=5` 是**向量库返回的总条数**，不是"过滤之后还剩 5 条"。你在 Java 里筛，筛的是已经限量过的 5 条。全库有 10 个租户、均匀分布的话，这 5 条里自己租户的期望值只有 0.5 条。

我用随机向量跑了一遍模拟感受一下这个塌陷有多狠：10 个租户、每个 200 条文档、查询向量随机，跑 200 次取平均。

| topK | 过滤后平均剩几条 | 一条都不剩的比例 |
| --- | --- | --- |
| 5 | 0.65 | 50% |
| 10 | 0.99 | 32% |
| 20 | 1.96 | 8% |
| 50 | 5.16 | 0% |

看第二列。topK=5 的时候，一半的查询拿回来的全是别人的文档，过滤完是空列表。用户看到的现象不是"答案质量下降"，而是"它说不知道"——这种 bug 最难查，因为日志里一切正常。

更糟的是它不只是漏答。如果业务代码对空列表做了兜底，比如"没检索到就放开限制让模型自己回答"，那就直接变成数据泄露。很多事故就是这么来的：过滤逻辑本身没写错，是错误处理把闸门打开了。

还有一种更隐蔽的写法：

```java
// 同样是反面教材，只是把过滤藏进了循环
List<Document> result = new ArrayList<>();
for (int k = 5; k <= 200 && result.size() < 5; k *= 2) {
    List<Document> docs = vectorStore.similaritySearch(
            SearchRequest.builder().query(q).topK(k).build());
    result = docs.stream().filter(this::canRead).limit(5).toList();
}
```

这个"逐步放大 topK"的思路方向是对的，但代价很大：最坏情况你要把全库拉回来，网络传输、反序列化、分数排序全在应用侧做，延迟随数据量线性上涨。数据量上到十万级，单次查询就能拖到几秒。

真正的解法只有一个方向：把 `tenant_id`、部门、密级这些条件交给向量库，让它**只在你有权限的那部分数据里做相似度搜索**。这样 topK 的含义才回到"我能看的文档里最像的 5 条"。

## 二、底层原理到底怎么回事

要理解为什么"下推"很重要，得先知道向量检索在索引层是怎么跑的。

### 向量检索不是遍历，是在图里找路

主流向量库默认用 HNSW（分层可导航小世界图）建索引。它的工作方式是：把每个向量当成图上的一个点，相近的点之间连边，查询时从某个入口点出发，每跳一次就往"离查询向量更近"的方向走，走若干步后停在附近的点上。

这个结构天生只回答一个问题：**离这个向量最近的 K 个点是谁**。它内部没有 B+ 树那种"按字段定位到某个区间"的能力，因为它压根不是按字段组织的。

这就是矛盾的根源。你的过滤条件是 `tenant_id == 't_acme'`，索引里没有"tenant_id 的索引段"这种东西，它只有一张相似度图。

### 两种执行顺序，差别巨大

于是就有了两种做法。

**先搜后筛**（post-filter）：先让 HNSW 走出 topK 个最近邻，再拿这些点的 metadata 一条条判断。实现简单，但正如上一节的表，过滤越严，剩的越少。类比一下：你让图书管理员"按主题帮我找 10 本书"，他把整座馆里最对题的 10 本抱过来，你再看借书证——其中 9 本在封闭书库，你借不了。你想要的是"在我能进的书库里找 10 本"。

**先筛后搜**（pre-filter）：先按条件圈出候选集合，再在候选集合里算距离。问题是候选集合可能很大，如果圈出 8 万条再逐条算余弦相似度，HNSW 索引就白建了，退化成暴力扫描。

所以工程上的答案是第三条路：**让过滤条件被索引吸收**。

### 生产级向量库怎么"吸收"过滤条件

各家做法不同，但套路一致——为 metadata 建立独立的数据结构，先用它快速圈定候选，再在这批候选上做图搜索。举两个典型：

**Redis（RediSearch / Redis Query Engine）** 把 tag 字段建成倒排索引，numeric 字段建成数值索引。Spring AI 的过滤表达式最终会被翻译成 Redis 自己的查询语法，和 KNN 拼进同一条 `FT.SEARCH` 里。官方文档给的例子很直观：

```text
country in ['UK', 'NL'] && year >= 2020
```

会被转成：

```text
@country:{UK | NL} @year:[2020 inf]
```

这两段是**同一次查询**的一部分，不是查完再筛。Redis 先按 tag 倒排拿到候选 id 集合，再在集合内跑向量排序。

**pgvector** 走的是另一条路。它把过滤条件交给 PostgreSQL 的规划器，可以用部分索引（partial index）把"某租户的数据"单独建一个 HNSW 索引，也可以按条件过滤后走索引。早期版本有个坑：过滤条件很严时，规划器会先过滤再暴力算，或者反过来先取 topK 导致召回不足。pgvector 0.8.0 引入了 iterative index scans，允许索引在结果不够时继续往下扫，缓解了这个问题。

**Milvus** 这类专用向量库则是标量字段单独建索引，查询时先把过滤条件编译成一个 bitset，再在 bitset 允许的范围内做图搜索。

不管哪家，本质都是同一句话：**过滤条件必须在算相似度之前生效，而且要由索引来执行**。

### 为什么"阈值"会让问题更严重

还有一个常被忽略的乘数：`similarityThreshold`。

很多人会同时设置 `topK=5` 和 `similarityThreshold=0.75`。这意味着向量库先按相似度砍掉一批，再取前 5 条。如果这 5 条恰好都是别的租户的，你在 Java 侧过滤完就是 0 条。

而且阈值本身就存在"误杀"：真正能回答问题的文档，相似度可能只有 0.6。你设 0.75，它在你过滤之前就被丢了。这类问题在 demo 里看不出来，因为 demo 的文档和问题几乎是同一句话。

结论很干脆：阈值可以留，但它只能用来挡掉明显不相关的垃圾，不能承担"缩小范围"的职责。缩小范围是过滤条件的活。

## 三、实战：手把手写代码

下面这套代码可以直接跑，需要三样东西：JDK 21、一个 OpenAI 兼容的 API Key、一个 Redis Stack 实例（`docker run -d -p 6379:6379 redis/redis-stack:latest`）。

### 第一步：依赖

`pom.xml`：

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
    <artifactId>rag-permission-demo</artifactId>
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
            <groupId>org.springframework.ai</groupId>
            <artifactId>spring-ai-starter-model-openai</artifactId>
            <version>2.0.2</version>
        </dependency>
        <dependency>
            <groupId>org.springframework.ai</groupId>
            <artifactId>spring-ai-starter-vector-store-redis</artifactId>
            <version>2.0.2</version>
        </dependency>
    </dependencies>
</project>
```

`application.yml`：

```yaml
spring:
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
  data:
    redis:
      host: localhost
      port: 6379
```

`initialize-schema: true` 是必须的。Redis 不建索引的话，后面的过滤条件会直接报错，提示字段不是索引字段。

### 第二步：告诉 Redis 哪些字段要建索引

这一步最容易漏。metadata 里写进去的字段，Redis 默认只当普通 hash 字段存着，不能用来过滤。要显式声明类型：

```java
package com.example.rag.config;

import org.springframework.ai.vectorstore.redis.RedisVectorStore;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import java.util.List;

@Configuration
public class RedisVectorStoreConfig {

    /**
     * tag 用于等值和 IN 过滤，numeric 用于大小比较。
     * 字段名必须和 Document metadata 里的 key 完全一致。
     */
    @Bean
    public List<RedisVectorStore.MetadataField> metadataFields() {
        return List.of(
                RedisVectorStore.MetadataField.tag("tenant_id"),
                RedisVectorStore.MetadataField.tag("dept_id"),
                RedisVectorStore.MetadataField.numeric("level")
        );
    }
}
```

`tenant_id` 和 `dept_id` 用 tag：它们是字符串，查询方式只有等值和集合匹配。`level` 用 numeric：密级要比较大小，`level <= 3` 这种条件得走数值索引。

### 第三步：入库时把权限写进去

权限信息必须在写文档那一刻就跟着每一段落库。事后补写会漏，而且你永远不知道漏在哪一段。

```java
package com.example.rag.kb;

import org.springframework.ai.document.Document;
import org.springframework.ai.vectorstore.VectorStore;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

@Service
public class KnowledgeIngestService {

    private final VectorStore vectorStore;

    public KnowledgeIngestService(VectorStore vectorStore) {
        this.vectorStore = vectorStore;
    }

    /**
     * 文档切段入库，每一段都带完整的权限 metadata。
     * 不要指望切块器帮你保留元数据，自己拼最稳。
     */
    public void ingest(String docId, String tenantId, String deptId, int level, List<String> chunks) {
        List<Document> documents = new ArrayList<>(chunks.size());
        for (int i = 0; i < chunks.size(); i++) {
            Map<String, Object> metadata = new HashMap<>();
            metadata.put("tenant_id", tenantId);
            metadata.put("dept_id", deptId);
            metadata.put("level", level);
            metadata.put("doc_id", docId);
            metadata.put("chunk_index", i);
            documents.add(new Document(docId + "-" + i, chunks.get(i), metadata));
        }
        vectorStore.add(documents);
    }

    /**
     * 文档下线必须连向量库一起删。只删业务库那一行，等于权限还在生效。
     */
    public void deleteByDoc(String docId) {
        vectorStore.delete("doc_id == '" + docId + "'");
    }
}
```

两个细节值得注意。文档 id 用 `docId + "-" + i`，这样同一篇文档的所有段落有共同前缀，排查时能一眼看出从哪来。`chunk_index` 留着，出问题时能还原上下文顺序。

### 第四步：查询时把权限下推

先把"谁能看什么"抽象出来，别在检索方法里塞一堆参数：

```java
package com.example.rag.kb;

import java.util.List;

public record Reader(String userId, String tenantId, List<String> deptIds, int maxLevel) {
}
```

然后写检索。核心只有一句：`filterExpression` 必须挂在 `SearchRequest` 上。

```java
package com.example.rag.kb;

import org.springframework.ai.document.Document;
import org.springframework.ai.vectorstore.SearchRequest;
import org.springframework.ai.vectorstore.VectorStore;
import org.springframework.ai.vectorstore.filter.Filter;
import org.springframework.ai.vectorstore.filter.FilterExpressionBuilder;
import org.springframework.stereotype.Service;

import java.util.List;

@Service
public class KnowledgeSearchService {

    private final VectorStore vectorStore;

    public KnowledgeSearchService(VectorStore vectorStore) {
        this.vectorStore = vectorStore;
    }

    public List<Document> searchFor(Reader reader, String question, int topK) {
        FilterExpressionBuilder b = new FilterExpressionBuilder();
        Filter.Expression permission = b.and(
                b.eq("tenant_id", reader.tenantId()),
                b.in("dept_id", reader.deptIds().toArray()),
                b.lte("level", reader.maxLevel())
        ).build();

        SearchRequest request = SearchRequest.builder()
                .query(question)
                .topK(topK)
                .similarityThreshold(0.5)
                .filterExpression(permission)
                .build();

        return vectorStore.similaritySearch(request);
    }
}
```

`FilterExpressionBuilder` 的写法是链式的，`eq` 管等值，`in` 管集合，`lte` 管 `<=`，`and` 把它们串起来。这段表达式最终会被翻译成 Redis 的查询语法，和 KNN 一起下发，**一次往返搞定**。

同一个条件也可以用字符串表达式写，适合从配置中心读、或者权限规则动态拼接的场景：

```java
String filter = "tenant_id == 't_acme' && dept_id in ['d_finance', 'd_legal'] && level <= 3";

List<Document> docs = vectorStore.similaritySearch(
        SearchRequest.builder().query(question).topK(8).filterExpression(filter).build());
```

字符串版本要小心引号转义。租户 ID 如果来自用户输入，务必先做白名单校验或者用 DSL 版本，别直接拼字符串——这和 SQL 注入是同一类问题。

### 第五步：接上大模型，并给空结果一个正经出口

最后一段是完整问答。这里有个必须显式处理的点：过滤后条数为 0。

```java
package com.example.rag.answer;

import com.example.rag.kb.KnowledgeSearchService;
import com.example.rag.kb.Reader;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.document.Document;
import org.springframework.stereotype.Service;

import java.util.List;

@Service
public class RagAnswerService {

    private static final String SYSTEM = """
            你是企业知识库助手。只能依据用户提供的【资料】回答，不要使用资料以外的知识。
            每条结论后面用 [编号] 标注依据，例如 [3]。
            资料里没有的内容，直接回答「资料中没有相关信息」。
            """;

    private final ChatClient chatClient;
    private final KnowledgeSearchService searchService;

    public RagAnswerService(ChatClient.Builder builder, KnowledgeSearchService searchService) {
        this.chatClient = builder.defaultSystem(SYSTEM).build();
        this.searchService = searchService;
    }

    public String ask(Reader reader, String question) {
        List<Document> docs = searchService.searchFor(reader, question, 8);

        // 关键分支：权限内没有资料，就明确告诉用户，别退化成"让模型自由发挥"
        if (docs.isEmpty()) {
            return "没有找到你有权限查看的相关资料。可以换个问法，或者联系文档管理员确认权限。";
        }

        return chatClient.prompt()
                .user("【资料】\n" + buildContext(docs) + "\n\n【问题】\n" + question)
                .call()
                .content();
    }

    private String buildContext(List<Document> docs) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < docs.size(); i++) {
            String text = docs.get(i).getText();
            sb.append("[").append(i + 1).append("] ")
              .append(text == null ? "" : text)
              .append("\n");
        }
        return sb.toString();
    }
}
```

提示词里要求模型标注 `[编号]`，是为了让答案可追溯——用户问"你这话哪来的"，你能对回具体段落。这个编号和 `buildContext` 里的序号是对齐的，别一边从 1 开始一边从 0 开始。

这里刻意用了字符串拼接，没用 `param()` 模板。原因写在下一节。

## 四、踩坑经验和最佳实践

**别再让模型兜底"没搜到"的情况。** 这是权限事故的头号来源。检索为空时正确做法是返回"没有权限内的资料"，而不是"那你随便答吧"。如果产品确实需要通用回答能力，那是另一条链路，跟知识库检索分开，且不能带上任何检索内容。

**metadata 字段没建索引，过滤条件会直接失败。** Redis 里没声明的字段不能用于 `filterExpression`，报错信息还不一定直观。测试环境能跑、生产不行，八成是 `initialize-schema` 没开或者索引名对不上。

**字段类型选错比不建索引更难查。** 把 `level` 建成 tag，`level <= 3` 会按字符串比较，`"10" <= "3"` 是成立的，你会得到一堆密级 10 的文档。数字字段就老老实实用 numeric。

**`in` 列表别太长。** 一个人如果挂在 300 个部门下，`dept_id in [...]` 拼出来的查询会很长，Redis 的查询解析都有开销。合理的做法是引入一个"权限组"概念，把几百个部门收敛成几个 group tag，检索时按 group 过滤。

**metadata 里没写的字段，会被静默排除。** 老数据如果没有 `tenant_id`，任何带租户条件的查询都搜不到它。做权限迁移时一定要回刷历史数据，并且跑一次"按条件 count"的核对。

**`param()` 模板会和资料内容打架。** `ChatClient` 的文本模板用 `{}` 占位，如果检索出来的文档里恰好有 `{` `}`（代码片段、JSON 示例里非常常见），渲染就会抛异常或者被替换成空。要么像上面那样直接拼字符串，要么手动把资料里的花括号转义。这个坑我踩过，报错信息指向模板引擎，完全看不出是文档内容的问题。

**权限变更要同步到向量库。** 员工调岗、文档降密，如果只改业务库，向量库里那份旧权限还在生效。删除用 `vectorStore.delete(filterExpression)` 按 `doc_id` 整批删，别一条条删。

**测试环境用 `SimpleVectorStore` 会骗你。** 它在内存里做暴力扫描 + 内存过滤，任何过滤条件都"支持"，指标还很好看。上线前必须用真实向量库跑一遍，重点测"过滤后结果条数"这个指标。

## 五、性能对比和技术选型

| 方案 | 过滤怎么执行 | 适用场景 | 主要代价 |
| --- | --- | --- | --- |
| Java 侧 `stream().filter()` | 应用内存过滤 | 单租户、或过滤条件恒定成立 | 召回塌陷，严格过滤下基本不可用 |
| 放大 topK 后过滤 | 应用内存过滤 | 数据量小（万级以下）、临时方案 | 延迟随数据量线性增长 |
| Redis + tag/numeric 索引 | 索引内过滤，与 KNN 同批 | 已有 Redis、数据量中小、需要低延迟 | 字段必须先声明；复杂嵌套条件表达力有限 |
| pgvector | 数据库规划器 + 部分索引 | 已有 PostgreSQL、要和业务表 join | 需要调规划器/索引策略，极端过滤需 0.8+ 的迭代扫描 |
| Milvus / Qdrant 等专用库 | 标量索引 + bitset | 千万级以上、多租户密集过滤 | 运维成本高，多一套组件 |

选型我给个直白的建议：**已经跑着 Redis 的团队直接用 Redis 向量库**，权限字段用 tag，省一套中间件，延迟也够。数据量奔着千万去、或者过滤条件特别复杂（嵌套 AND/OR、多值标签），再上 Milvus 这类专用库。

pgvector 适合"业务数据本来就在 PG 里、需要和权限表做关联"的场景，代价是你得懂 PG 的执行计划，不然容易遇到"过滤后召回不足"。

不建议的一条路：自己写一个"先查权限表拿到 doc_id 列表，再拼成超长 `in` 条件"的方案。几百个 id 还行，几万个直接爆。

## 六、总结

把这件事压缩成三句话：

权限过滤的位置，决定了它是"少几条"还是"查不到"。`topK` 是向量库返回的总数，你在应用层筛，筛的就是这个已经被限量的小集合。

正确做法是把 `tenant_id`、部门、密级这些条件放进 `SearchRequest.filterExpression`，让向量库在算相似度之前就缩小候选范围。Redis 用 tag/numeric 索引，pgvector 用部分索引，Milvus 用 bitset，路子不同，原则一样。

最后一句最要紧：检索结果为空时，返回"没有权限内的资料"，永远不要让模型自由发挥。过滤逻辑写得再对，一个错误的兜底分支就能把闸门全打开。

文 / 会编程的吕洞宾

## 参考资料

- [Spring AI - Vector Databases](https://docs.spring.io/spring-ai/reference/api/vectordbs.html)
- [Spring AI - Redis Vector Store](https://docs.spring.io/spring-ai/reference/api/vectordbs/redis.html)
- [pgvector: Open-source vector similarity search for Postgres](https://github.com/pgvector/pgvector)
- [Efficient and robust approximate nearest neighbor search using Hierarchical Navigable Small World graphs](https://arxiv.org/abs/1603.09320)
