---
title: "LangChain4j元数据过滤：RAG别再召回别人的数据"
date: 2026-10-15T20:00:00+08:00
category: "AI"
tags: ["langchain4j", "rag"]
---

**摘要：** RAG 只比相似度，不认数据归属，多租户知识库很容易把客户 B 的文档塞进客户 A 的上下文。本文用 LangChain4j 的元数据过滤，把「只看该看的数据」落到检索这一层，讲清过滤发生在链路的哪一步、动态过滤怎么接 InvocationParameters，附三个完整可运行示例和踩坑清单。

> 先讲个事故。一套向量库服务三家客户，文档全堆在一起。客户 A 的员工问「退款多久到账」，检索按相似度捞回三条，其中两条是客户 B 的合同条款。模型不知道谁是谁，照着材料答，答得还挺像真的。问题不在模型，在检索这一层没有边界。而堵住它，靠的不是在提示词里写「不要泄露数据」——数据都已经进上下文了。正确的做法是把不属于这个人的数据，在检索发生之前就排除掉。LangChain4j 留的开关叫元数据过滤（Metadata Filter）。

## 一、这个问题到底是什么

元数据过滤解决一件事：让向量检索只在「这个用户有权看的那部分数据」里找答案。RAG 项目里最常见的三个落点：

- **多租户**：一个 SaaS 平台，几十家客户共用一套向量库，谁都不能看到别人的文档。
- **权限**：同一家公司内部，销售能查报价单，财务文档只有财务能看。
- **业务范围**：只查某个产品线、只查最近半年的数据、只查中文资料。

先说清楚向量检索在干什么。它只做一件事：把问题转成向量，跟库里已有的向量比相似度，取最像的前 K 条。这个过程里，它不认「这条是谁的」。元数据就是挂在每个文本片段上的标签，一堆键值对：

```text
tenantId = t-001
dept     = finance
year     = 2026
```

标签跟着文本片段一起存进向量库。检索时带上条件，向量库就只在那部分数据里找。

两种做法的差别很大：

| 做法 | 什么时候筛 | 后果 |
| --- | --- | --- |
| 检索后在 Java 里筛 | 拿到 topK 之后 | topK 名额已经被别人家的数据占满，筛完可能一条不剩 |
| 检索前带条件筛 | 数据出库之前 | 没有额外代价，这是正解 |

第一种像什么？像图书馆让你随便抱十本书回来，你一看七本不该拿，再挨个还回去。第二种是进门就查借阅权限，只让你抱该抱的。

还有一点要写清楚：权限判断不能交给模型。模型的判断不可靠，也能被提示词绕过。过滤条件由后端根据登录态算出来，交给检索层执行，这条链路上模型插不上手。

## 二、底层原理到底怎么回事

一句话结论：过滤条件不是 LangChain4j 在应用层做的，它会被塞进检索请求里，下发给你用的向量库去执行。

### 一次 RAG 检索的完整链路

1. 用户提问，Embedding 模型把问题转成一个向量。
2. LangChain4j 组装检索请求：查询向量 + `maxResults`（取几条）+ `minScore`（相似度下限）+ `filter`（过滤条件）。
3. 向量库执行搜索，返回命中的文本片段。
4. 片段拼进提示词，一起发给大模型。

前两步到第三步都不需要模型参与。过滤条件在第二步就进了请求体。

`EmbeddingStoreContentRetriever` 的 `retrieve` 方法写得很直白：它把 `filterProvider.apply(query)` 的结果塞进 `EmbeddingSearchRequest`，然后调用 `embeddingStore.search(request)`。所以，**过滤是向量库干的活，LangChain4j 只负责把条件传下去**。

### 元数据怎么一路走到向量库

```text
Document（原始文档，带 Metadata）
   ↓ DocumentSplitter 切成片段
TextSegment（整份复制文档的元数据，另外加一个 index 标记位置）
   ↓ EmbeddingModel 转成向量
向量 + 文本片段 + 元数据，一起写进向量库
```

关键在第二行：切分文档时，元数据是整份复制到每个片段上的，不是只挂在大文档上。所以入库时给文档打的 `tenantId`，检索时能按它筛。

### 静态过滤和动态过滤

两种写法，用途完全不同。

**静态过滤**在 builder 里写死：

```java
ContentRetriever retriever = EmbeddingStoreContentRetriever.builder()
        .embeddingStore(store)
        .embeddingModel(embeddingModel)
        .filter(metadataKey("lang").isEqualTo("zh"))
        .build();
```

所有请求都带同一个条件。适合「只查中文资料」这类跟人无关的固定范围。

**动态过滤**每次调用现算：

```java
ContentRetriever retriever = EmbeddingStoreContentRetriever.builder()
        .embeddingStore(store)
        .embeddingModel(embeddingModel)
        .dynamicFilter(query -> {
            String tenantId = query.metadata().invocationParameters().get("tenantId");
            return metadataKey("tenantId").isEqualTo(tenantId);
        })
        .build();
```

多租户只能用这个。`query.metadata().invocationParameters()` 取的是本次调用的参数，来源是 AI Service 方法上多出来的那个 `InvocationParameters` 参数——调用方传 `tenantId`，模型看不见它，但检索层看得见。

### 过滤表达式能怎么写

`metadataKey("key")` 开头，后面接判断：

- 等于 / 不等于：`isEqualTo`、`isNotEqualTo`
- 集合：`isIn`、`isNotIn`
- 包含子串：`containsString`
- 数值比较：`isGreaterThan`、`isGreaterThanOrEqualTo`、`isLessThan`、`isLessThanOrEqualTo`

多个条件用 `Filter.and(...)`、`Filter.or(...)`、`Filter.not(...)` 组合：

```java
Filter filter = Filter.and(
        metadataKey("tenantId").isEqualTo("t-001"),
        metadataKey("year").isGreaterThanOrEqualTo(2026)
);
```

### 为什么「过滤时机」是要命的细节

向量库实现 topK 有两种方式：

- **预过滤**：只在符合条件的数据里算相似度、取前 K。
- **后过滤**：先在全库取前 K，再把不符合条件的丢掉。

后过滤遇上苛刻条件会出事。库里十万条，符合 `tenantId = t-001` 的只有三千条，向量库先在全库取了 top5，结果 5 条全是别人家的，筛完返回空。数据明明在库里，用户什么都搜不到。不是玄学，是取数顺序的问题。

所以：`maxResults` 要留余量，并且确认你用的向量库是哪种实现，别默认所有库都支持预过滤。

## 三、实战：手把手写代码

先给依赖，三个示例共用这一个 pom。

```xml
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
    <artifactId>rag-metadata-filter</artifactId>
    <version>1.0.0</version>

    <properties>
        <java.version>21</java.version>
        <langchain4j.version>1.22.0</langchain4j.version>
    </properties>

    <dependencies>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter</artifactId>
            <version>4.1.1</version>
        </dependency>
        <dependency>
            <groupId>dev.langchain4j</groupId>
            <artifactId>langchain4j</artifactId>
            <version>1.22.0</version>
        </dependency>
        <dependency>
            <groupId>dev.langchain4j</groupId>
            <artifactId>langchain4j-open-ai</artifactId>
            <version>1.22.0</version>
        </dependency>
    </dependencies>

</project>
```

三个示例都用 OpenAI 的模型，跑之前把 `OPENAI_API_KEY` 设进环境变量。示例一、示例三只用 embedding 模型，示例二会调聊天模型。用别的模型也行，把 `OpenAiEmbeddingModel` / `OpenAiChatModel` 换成对应实现就行，过滤的写法一个字都不用改。

### 示例一：灌数据 + 静态过滤，验证「只在自己的数据里搜」

这个类干三件事：造三条不同租户的文档、灌进内存向量库、带着 `tenantId` 过滤去检索，把命中的租户打印出来。

```java
package com.example.ragmetadata;

import dev.langchain4j.data.document.Document;
import dev.langchain4j.data.document.Metadata;
import dev.langchain4j.data.document.splitter.DocumentSplitters;
import dev.langchain4j.data.embedding.Embedding;
import dev.langchain4j.data.segment.TextSegment;
import dev.langchain4j.model.embedding.EmbeddingModel;
import dev.langchain4j.model.openai.OpenAiEmbeddingModel;
import dev.langchain4j.store.embedding.EmbeddingMatch;
import dev.langchain4j.store.embedding.EmbeddingSearchRequest;
import dev.langchain4j.store.embedding.EmbeddingSearchResult;
import dev.langchain4j.store.embedding.EmbeddingStore;
import dev.langchain4j.store.embedding.inmemory.InMemoryEmbeddingStore;
import dev.langchain4j.store.embedding.ingestor.EmbeddingStoreIngestor;

import java.util.List;

import static dev.langchain4j.store.embedding.filter.MetadataFilterBuilder.metadataKey;

public class StaticFilterDemo {

    public static void main(String[] args) {

        EmbeddingModel embeddingModel = OpenAiEmbeddingModel.builder()
                .apiKey(System.getenv("OPENAI_API_KEY"))
                .modelName("text-embedding-3-small")
                .build();

        EmbeddingStore<TextSegment> store = new InMemoryEmbeddingStore<>();

        List<Document> documents = List.of(
                Document.from("退款到账时间为 7 个工作日。", Metadata.from("tenantId", "t-001")),
                Document.from("企业客户专属折扣为 8 折。", Metadata.from("tenantId", "t-002")),
                Document.from("发票可以在订单页自助下载。", Metadata.from("tenantId", "t-001"))
        );

        EmbeddingStoreIngestor.builder()
                .embeddingStore(store)
                .embeddingModel(embeddingModel)
                .documentSplitter(DocumentSplitters.recursive(300, 30))
                .build()
                .ingest(documents);

        Embedding queryEmbedding = embeddingModel.embed("退款多久到账").content();

        EmbeddingSearchRequest request = EmbeddingSearchRequest.builder()
                .queryEmbedding(queryEmbedding)
                .maxResults(3)
                .filter(metadataKey("tenantId").isEqualTo("t-001"))
                .build();

        EmbeddingSearchResult<TextSegment> result = store.search(request);

        System.out.println("命中 " + result.matches().size() + " 条：");
        for (EmbeddingMatch<TextSegment> match : result.matches()) {
            System.out.printf("%.3f | tenant=%s | %s%n",
                    match.score(),
                    match.embedded().metadata().getString("tenantId"),
                    match.embedded().text());
        }
    }
}
```

跑完你会看到命中的全是 `tenantId=t-001`。把 `.filter(...)` 那一行注释掉再跑一次，`t-002` 的文档就出现在结果里了——那就是事故现场，也是这篇文章存在的理由。

### 示例二：多租户动态过滤，接到 AI Service 上

这个类把过滤条件改成「从每次调用传进来的参数里取」，同一个 Assistant 接口服务不同租户。

```java
package com.example.ragmetadata;

import dev.langchain4j.data.document.Document;
import dev.langchain4j.data.document.Metadata;
import dev.langchain4j.data.document.splitter.DocumentSplitters;
import dev.langchain4j.data.segment.TextSegment;
import dev.langchain4j.invocation.InvocationParameters;
import dev.langchain4j.model.chat.ChatModel;
import dev.langchain4j.model.embedding.EmbeddingModel;
import dev.langchain4j.model.openai.OpenAiChatModel;
import dev.langchain4j.model.openai.OpenAiEmbeddingModel;
import dev.langchain4j.rag.content.retriever.ContentRetriever;
import dev.langchain4j.rag.content.retriever.EmbeddingStoreContentRetriever;
import dev.langchain4j.service.AiServices;
import dev.langchain4j.service.UserMessage;
import dev.langchain4j.store.embedding.EmbeddingStore;
import dev.langchain4j.store.embedding.inmemory.InMemoryEmbeddingStore;
import dev.langchain4j.store.embedding.ingestor.EmbeddingStoreIngestor;

import java.util.List;

import static dev.langchain4j.store.embedding.filter.MetadataFilterBuilder.metadataKey;

public class MultiTenantRagDemo {

    interface Assistant {
        String chat(@UserMessage String question, InvocationParameters parameters);
    }

    public static void main(String[] args) {

        String apiKey = System.getenv("OPENAI_API_KEY");

        EmbeddingModel embeddingModel = OpenAiEmbeddingModel.builder()
                .apiKey(apiKey)
                .modelName("text-embedding-3-small")
                .build();

        ChatModel chatModel = OpenAiChatModel.builder()
                .apiKey(apiKey)
                .modelName("gpt-4o-mini")
                .build();

        EmbeddingStore<TextSegment> store = new InMemoryEmbeddingStore<>();

        EmbeddingStoreIngestor.builder()
                .embeddingStore(store)
                .embeddingModel(embeddingModel)
                .documentSplitter(DocumentSplitters.recursive(300, 30))
                .build()
                .ingest(List.of(
                        Document.from("退款到账时间为 7 个工作日。", Metadata.from("tenantId", "t-001")),
                        Document.from("企业客户专属折扣为 8 折。", Metadata.from("tenantId", "t-002")),
                        Document.from("发票可以在订单页自助下载。", Metadata.from("tenantId", "t-001"))
                ));

        ContentRetriever retriever = EmbeddingStoreContentRetriever.builder()
                .embeddingStore(store)
                .embeddingModel(embeddingModel)
                .maxResults(3)
                .dynamicFilter(query -> {
                    String tenantId = query.metadata().invocationParameters().get("tenantId");
                    return metadataKey("tenantId").isEqualTo(tenantId);
                })
                .build();

        Assistant assistant = AiServices.builder(Assistant.class)
                .chatModel(chatModel)
                .contentRetriever(retriever)
                .build();

        InvocationParameters tenantA = InvocationParameters.from("tenantId", "t-001");
        InvocationParameters tenantB = InvocationParameters.from("tenantId", "t-002");

        System.out.println("[t-001] " + assistant.chat("退款多久能到账？", tenantA));
        System.out.println("[t-002] " + assistant.chat("退款多久能到账？", tenantB));
    }
}
```

关键就三行：接口方法上多了 `InvocationParameters parameters`；`dynamicFilter` 从 `query.metadata().invocationParameters().get("tenantId")` 取值；`tenantId` 全程不进提示词，模型看不见它，它只影响检索范围。

生产环境里这个 `tenantId` 从登录态的 SecurityContext 里取，不要从请求参数里直接读。

### 示例三：组合过滤，租户 + 年份 + 语言一起上

单一条件不够用时，把条件拼起来。这个示例顺手演示了元数据的多字段写入，以及数值范围查询。

```java
package com.example.ragmetadata;

import dev.langchain4j.data.document.Document;
import dev.langchain4j.data.document.Metadata;
import dev.langchain4j.data.document.splitter.DocumentSplitters;
import dev.langchain4j.data.segment.TextSegment;
import dev.langchain4j.model.embedding.EmbeddingModel;
import dev.langchain4j.model.openai.OpenAiEmbeddingModel;
import dev.langchain4j.store.embedding.EmbeddingMatch;
import dev.langchain4j.store.embedding.EmbeddingSearchRequest;
import dev.langchain4j.store.embedding.EmbeddingSearchResult;
import dev.langchain4j.store.embedding.EmbeddingStore;
import dev.langchain4j.store.embedding.filter.Filter;
import dev.langchain4j.store.embedding.inmemory.InMemoryEmbeddingStore;
import dev.langchain4j.store.embedding.ingestor.EmbeddingStoreIngestor;

import java.util.List;

import static dev.langchain4j.store.embedding.filter.MetadataFilterBuilder.metadataKey;

public class CombinedFilterDemo {

    public static void main(String[] args) {

        EmbeddingModel embeddingModel = OpenAiEmbeddingModel.builder()
                .apiKey(System.getenv("OPENAI_API_KEY"))
                .modelName("text-embedding-3-small")
                .build();

        EmbeddingStore<TextSegment> store = new InMemoryEmbeddingStore<>();

        Metadata tenantA2026Zh = Metadata.from("tenantId", "t-001").put("year", 2026).put("lang", "zh");
        Metadata tenantA2025Zh = Metadata.from("tenantId", "t-001").put("year", 2025).put("lang", "zh");
        Metadata tenantA2026En = Metadata.from("tenantId", "t-001").put("year", 2026).put("lang", "en");
        Metadata tenantB2026Zh = Metadata.from("tenantId", "t-002").put("year", 2026).put("lang", "zh");

        EmbeddingStoreIngestor.builder()
                .embeddingStore(store)
                .embeddingModel(embeddingModel)
                .documentSplitter(DocumentSplitters.recursive(300, 30))
                .build()
                .ingest(List.of(
                        Document.from("2026 年新退款政策：7 个工作日到账。", tenantA2026Zh),
                        Document.from("2025 年退款政策：15 个工作日到账。", tenantA2025Zh),
                        Document.from("Refund takes 7 business days.", tenantA2026En),
                        Document.from("另一个租户的政策说明。", tenantB2026Zh)
                ));

        Filter filter = Filter.and(
                metadataKey("tenantId").isEqualTo("t-001"),
                metadataKey("year").isGreaterThanOrEqualTo(2026),
                metadataKey("lang").isIn(List.of("zh", "en"))
        );

        EmbeddingSearchRequest request = EmbeddingSearchRequest.builder()
                .queryEmbedding(embeddingModel.embed("退款多久到账").content())
                .maxResults(10)
                .minScore(0.5)
                .filter(filter)
                .build();

        EmbeddingSearchResult<TextSegment> result = store.search(request);

        System.out.println("命中 " + result.matches().size() + " 条：");
        for (EmbeddingMatch<TextSegment> match : result.matches()) {
            System.out.printf("%.3f | tenant=%s year=%s lang=%s | %s%n",
                    match.score(),
                    match.embedded().metadata().toMap().get("tenantId"),
                    match.embedded().metadata().toMap().get("year"),
                    match.embedded().metadata().toMap().get("lang"),
                    match.embedded().text());
        }
    }
}
```

把 `Filter.and(...)` 换成 `Filter.or(...)`，语义立刻变成「满足任意一条即可」。条件越多，越要留意上面说的后过滤问题——`maxResults` 给了 10 就是这个原因。

## 四、踩坑经验和最佳实践

**1. 元数据类型对不上，直接抛异常，不是静默失败。** 存进去是 `int`，过滤时传字符串 `"2026"`，会抛 `IllegalArgumentException: Type mismatch`。注意：数字之间是互相兼容的，数字和字符串之间不是。

```text
存 int  2026  →  metadataKey("year").isEqualTo(2026)         ✅
存 int  2026  →  metadataKey("year").isEqualTo("2026")       ❌ 抛异常
存 String "2026"  →  metadataKey("year").isGreaterThan(2025) ❌ 字符串做不了数值比较
```

结论：要做范围查询（大于/小于）的字段存数字，只做等值查询的字段存字符串。同一个字段别混着存。

**2. 检索返回空，优先怀疑取数顺序。** 排查顺序固定下来：先把 filter 去掉，看有没有结果。有结果、加上 filter 就没结果，那问题八成在过滤时机，不是数据不在。先把 `maxResults` 调大试试。

**3. 元数据是随片段存的，不是随库存的。** 想按某个字段筛，入库时每一条都得有。半路加字段最难受：老数据没这个字段，过滤直接把它们跳过，看起来像「数据丢了」。要么重新入库，要么给老数据补一个默认值再入。

**4. 不要自己拼过滤表达式字符串。** 有的向量库把过滤转成自己的查询语法，拼字符串等于开一个注入口子。用 `Filter` 对象，让 LangChain4j 去转。

**5. 权限参数从服务端取。** `tenantId`、`dept` 这类参数从登录态里读。前端传什么就信什么，等于把过滤条件交给了最不该信的一方。

**6. 过滤和 `minScore` 一起用。** 过滤缩小范围后命中质量会波动，`minScore` 兜底，避免把不相关的片段塞进提示词。

**7. 过滤字段建索引。** 生产向量库（Milvus、Elasticsearch 这类）对元数据字段有自己的索引机制，没建索引的字段做过滤会退化成全表扫描。

## 五、性能对比和技术选型

过滤本身不慢，慢的是「过滤后候选不够」。经验值：

| 场景 | 建议 |
| --- | --- |
| 条件命中率高（大部分数据都符合） | 正常 topK（3~5）就行 |
| 条件苛刻（命中率低于 10%） | `maxResults` 放大到 3~5 倍，或换成支持预过滤的库 |
| 每次都要按用户筛 | 动态过滤 + 给过滤字段建索引 |
| 单机验证 / 单元测试 | 内存向量库，支持过滤，零部署 |

选型一句话：**过滤能力是选向量库的硬指标**。查一下官方集成文档里的过滤能力对照表——Milvus、Elasticsearch 这类库明确支持元数据过滤，但支持程度不一样，有的只支持字段等于，有的支持范围查询和组合条件。别上线了才发现只能用等值查询。

内存向量库适合验证逻辑和写测试，不适合生产：它每次检索是线性扫描全库，数据量上万条以后就该换真库了。

## 六、总结

RAG 的召回质量，一半靠向量模型，一半靠「你有没有把不该找的数据排掉」。

- 元数据过滤把权限边界下沉到检索层，比在提示词里求模型「别乱说」靠谱得多。
- 过滤条件随检索请求下发给向量库执行，LangChain4j 负责传参，不负责执行。
- 多租户用 `dynamicFilter` + `InvocationParameters`，参数从服务端登录态取。
- 排查空结果：先去掉 filter 试。有条件就有结果，那问题在过滤时机，去调 `maxResults` 或换库。
- 元数据类型要么全数字、要么全字符串，混用必炸。

多租户 RAG 的安全底线就是这一层过滤。写代码之前花十分钟想清楚「哪些字段是边界」，比上线之后补一堆事后校验划算。

## 参考资料

- 【LangChain4j 官方文档 · Retrieval-Augmented Generation (RAG)】https://docs.langchain4j.dev/tutorials/rag/
- 【LangChain4j 官方文档 · Embedding Stores（含各向量库的元数据与过滤能力对照表）】https://docs.langchain4j.dev/integrations/embedding-stores/
- 【MetadataFilterBuilder Javadoc】https://javadoc.io/doc/dev.langchain4j/langchain4j-core/1.22.0/dev/langchain4j/store/embedding/filter/MetadataFilterBuilder.html

文 / 会编程的吕洞宾
