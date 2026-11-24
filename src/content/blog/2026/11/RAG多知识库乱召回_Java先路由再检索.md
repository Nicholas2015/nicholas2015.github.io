---
title: RAG多知识库乱召回，Java先路由再检索
date: 2026-11-24 16:29:44
tags: ["AI", "RAG", "LangChain4j", "Java"]
categories: ai
---

# RAG多知识库乱召回，Java先路由再检索

> 一个客服 RAG 上线两周，产品手册、售后政策、历史工单各建了一个向量库。用户问「X200 保修几年」，模型把工单里某位用户的抱怨当成了官方政策。团队把 topK 从 8 调到 3，又给相似度加阈值，答案越调越离谱。问题不在「搜得准不准」，在「搜错了地方」。这篇讲清楚：什么情况该先做查询路由，LangChain4j 里怎么落地，以及路由会踩哪些坑。

## 一、这个问题到底是什么

多知识库 RAG 最典型的故障，不是检索精度不够，而是一个问题被拿去搜了所有库。

先把场景摊开。客服系统里有三个库：

- 产品手册：X200 的参数、续航、接口、配件兼容性
- 售后政策：7 天无理由、整机保修 2 年、电池保修 1 年、发票规则
- 历史工单：真实用户对话和客服处理记录

用户问「X200 保修多久」。三个库都会命中：手册提到保修，政策写明 2 年，工单里有人抱怨「客服说电池只保 1 年」。三份片段一起塞进上下文，模型看到的是互相矛盾的信息，于是给出一个「整机 1 到 2 年，具体看情况」的四不像。

这就是串库。文档在语义空间里挤在一起——都在说产品、都在说保修——向量检索分不出哪份是权威口径。

### 为什么调 topK 和阈值没用

很多人第一反应是收紧参数。这条路基本走不通，原因有三个。

**分数尺度不一样。** 政策文档短、措辞规整，随便问一句相似度就 0.82 以上；工单是口语，0.7 已经算高了。同一个 minScore，对政策库是筛得太狠，对工单库是几乎不设防。

**topK 是全局的。** 工单库只需要一条脏数据就能污染答案，你把总条数压到 3，反而可能把政策原文挤掉。

**阈值一高，模型开始编。** 阈值提到 0.85，政策片段也进不来，上下文空了，模型照样给你一个听起来很确定的答案。这比检索错误更难发现。

### 换个思路：先分诊，再检索

查询路由（query routing）说的是：检索之前，先判断这个问题该由哪个库回答，然后只查那个库。

拿医院打比方。你去医院不会把内科、外科、骨科医生全叫来会诊，先过预检分诊台，分诊护士看一眼症状，告诉你挂哪个科。路由就是这道分诊。

三种常见的分诊手段，成本和适用面完全不同：

| 手段 | 判断依据 | 额外成本 | 适合场景 |
| --- | --- | --- | --- |
| 规则路由 | 正则、订单号、业务字段 | 几乎为零 | 意图有强特征词，比如「物流」「退款进度」 |
| 语义路由 | 问题向量和库描述向量的相似度 | 一次 embedding 调用 | 库多、问法散，但一次只需要选一个库 |
| LLM 路由 | 模型读问题和各库描述后判断 | 一次短对话调用 | 边界模糊、需要结合上下文理解 |

这三种不是互斥的。生产里我一般让规则先兜一层，剩下的交给 LLM，语义路由留给对延迟极敏感的场景。

## 二、底层原理到底怎么回事

LangChain4j 把「先路由再检索」做成了 RAG 管道里的标准插槽，接口叫 `QueryRouter`。

### RAG 管道长什么样

一次带检索的问答，内部走这么一条链：

```
用户问题
  → QueryTransformer（可选，改写/扩展问题）
  → QueryRouter（决定查哪几个库）
  → 1..N 个 ContentRetriever（真正去搜）
  → ContentAggregator（合并多库结果、去重、排序）
  → ContentInjector（把资料拼进 prompt）
  → 大模型
```

路由只负责「选谁去搜」，它自己不做检索。

### QueryRouter 的契约

接口短得有点意外：

```java
public interface QueryRouter {
    Collection<ContentRetriever> route(Query query);
}
```

注意返回值。它返回的是**检索器集合**，不是文档集合。这个设计很关键：路由可以搭配任何检索器——向量库、Web 搜索、数据库查询——而合并、去重、注入这些脏活统一交给 `DefaultRetrievalAugmentor`。

返回 `Collection` 而不是单个对象，是为了支持多意图。用户说「我买的 X200 坏了，保修怎么走」，这句话同时需要产品库确认型号、政策库给出保修流程。允许返回两个检索器，两个库的结果一起进上下文。

### LanguageModelQueryRouter 内部做了什么

LangChain4j 自带一个基于大模型的路由器，源码不长，三步：

1. 构造时把你传的 `Map<ContentRetriever, String>` 转成编号清单：`1: 产品手册：型号参数…`、`2: 售后政策：…`。
2. 运行时把清单和用户问题塞进一个 prompt，要求模型「只回数字，多个用逗号分隔」。
3. 解析返回的 `"1"` 或 `"1,3"`，映射回检索器对象。

模型返回了不存在的编号、返回了带句号的 `"1."`、或者干脆调用失败，都会走 fallback。fallback 有三档，选错了会很难受：

- `DO_NOT_ROUTE`（默认）：一个库都不查，模型裸答。风险是答得理直气壮，你还以为检索生效了。
- `ROUTE_TO_ALL`：全查，退化成老方案。至少有依据，代价是延迟和噪音回到从前。
- `FAIL`：直接抛异常。路由成了单点故障，一次解析失败整个请求 500。

我的选择是生产环境用 `ROUTE_TO_ALL`，同时对 fallback 次数打点。fallback 比例高，说明库描述写得含糊，或者路由用了太小的模型。

### 描述写得好不好，决定路由上限

模型没读过你的知识库，它对你的库的全部认知，就是你写的那一句描述。

对比一下：

- 差：`"政策库"`
- 好：`"售后政策：退换货条件、整机与电池保修期限、发票开具规则"`

后者模型才能把「保修」这个词对上号。描述该写「这个库能回答哪些问题」，不是「这个库叫什么名字」。工单库的描述尤其要写清楚「不代表官方政策」，这句话会直接影响模型在政策类问题上的选择。

### 路由和元数据过滤不是一回事

元数据过滤是同一个库里按字段筛，比如 `tenant_id = 42`、`dept = "finance"`，解决的是「别看到别人的数据」。

路由是跨库选，解决的是「别去错的库找」。

两者能叠加：先用路由缩到 2 个库，再在每个库里用 `dynamicFilter` 按租户筛。顺序别搞反，先过滤再路由等于让模型对着一堆空库做选择题。

### 语义路由为什么便宜

语义路由提前把每个库的描述 embed 成向量，运行时只 embed 一次问题，算余弦相似度取最高的那个。

一次 embedding 的价格，大概是 gpt-4o-mini 一次短对话的几十分之一，延迟也低一个量级。代价是它只能做「选一个最像的」，处理不了「这问题同时属于两个库」这种需要推理的判断，也读不懂「刚才那个」这种依赖上下文的指代。

## 三、实战：手把手写代码

下面这套代码可以直接跑。三个类：建库和主流程、规则优先路由、语义路由。用内存向量库，省掉外部依赖，换成 Redis 或 Milvus 只需要改 `EmbeddingStore` 那一行。

### 依赖

```xml
<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
    <modelVersion>4.0.0</modelVersion>

    <groupId>com.example</groupId>
    <artifactId>rag-router-demo</artifactId>
    <version>1.0.0</version>

    <properties>
        <maven.compiler.source>21</maven.compiler.source>
        <maven.compiler.target>21</maven.compiler.target>
        <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
    </properties>

    <dependencies>
        <dependency>
            <groupId>dev.langchain4j</groupId>
            <artifactId>langchain4j</artifactId>
            <version>1.24.0</version>
        </dependency>
        <dependency>
            <groupId>dev.langchain4j</groupId>
            <artifactId>langchain4j-open-ai</artifactId>
            <version>1.24.0</version>
        </dependency>
        <dependency>
            <groupId>org.slf4j</groupId>
            <artifactId>slf4j-simple</artifactId>
            <version>2.0.20</version>
        </dependency>
    </dependencies>
</project>
```

### 示例一：三个库，一个路由器，完整跑通

这段代码把三个库建起来，写好描述，交给 LLM 路由器，然后用三个问题验证路由是否生效。

```java
package com.example.ragrouter;

import dev.langchain4j.data.document.Document;
import dev.langchain4j.data.document.Metadata;
import dev.langchain4j.data.document.splitter.DocumentSplitters;
import dev.langchain4j.data.segment.TextSegment;
import dev.langchain4j.model.chat.ChatModel;
import dev.langchain4j.model.embedding.EmbeddingModel;
import dev.langchain4j.model.openai.OpenAiChatModel;
import dev.langchain4j.model.openai.OpenAiEmbeddingModel;
import dev.langchain4j.rag.DefaultRetrievalAugmentor;
import dev.langchain4j.rag.RetrievalAugmentor;
import dev.langchain4j.rag.content.retriever.ContentRetriever;
import dev.langchain4j.rag.content.retriever.EmbeddingStoreContentRetriever;
import dev.langchain4j.rag.query.router.LanguageModelQueryRouter;
import dev.langchain4j.rag.query.router.QueryRouter;
import dev.langchain4j.service.AiServices;
import dev.langchain4j.service.SystemMessage;
import dev.langchain4j.service.UserMessage;
import dev.langchain4j.store.embedding.EmbeddingStore;
import dev.langchain4j.store.embedding.EmbeddingStoreIngestor;
import dev.langchain4j.store.embedding.inmemory.InMemoryEmbeddingStore;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public class Demo {

    public static void main(String[] args) {
        String apiKey = System.getenv("OPENAI_API_KEY");

        ChatModel chatModel = OpenAiChatModel.builder()
                .apiKey(apiKey)
                .modelName("gpt-4o-mini")
                .temperature(0.0)
                .build();

        EmbeddingModel embeddingModel = OpenAiEmbeddingModel.builder()
                .apiKey(apiKey)
                .modelName("text-embedding-3-small")
                .build();

        InMemoryEmbeddingStore<TextSegment> productStore = new InMemoryEmbeddingStore<>();
        InMemoryEmbeddingStore<TextSegment> policyStore = new InMemoryEmbeddingStore<>();
        InMemoryEmbeddingStore<TextSegment> ticketStore = new InMemoryEmbeddingStore<>();

        ingest(productStore, embeddingModel, "product", """
                X200 智能音箱：蓝牙 5.3，续航 12 小时，支持两台设备串联。
                充电口为 USB-C，标配 18W 充电器，1.5 小时充满。
                支持固件在线升级，升级过程中指示灯为蓝色呼吸状态。
                """);

        ingest(policyStore, embeddingModel, "policy", """
                X200 整机保修 2 年，电池属于易损件，单独保修 1 年。
                7 天无理由退货需保留原包装和全部配件。
                发票在订单完成后 24 小时内开具，可申请电子发票。
                """);

        ingest(ticketStore, embeddingModel, "ticket", """
                工单 20241103-17：用户反馈 X200 用了 3 个月电池就不耐用。
                客服回复电池保修 1 年，用户不接受，要求整机换新，已升级处理。
                工单 20241107-02：用户咨询 X200 能否连接两个手机，客服确认可以。
                """);

        ContentRetriever productRetriever = EmbeddingStoreContentRetriever.builder()
                .embeddingStore(productStore)
                .embeddingModel(embeddingModel)
                .maxResults(3)
                .minScore(0.6)
                .displayName("product")
                .build();

        ContentRetriever policyRetriever = EmbeddingStoreContentRetriever.builder()
                .embeddingStore(policyStore)
                .embeddingModel(embeddingModel)
                .maxResults(3)
                .minScore(0.6)
                .displayName("policy")
                .build();

        ContentRetriever ticketRetriever = EmbeddingStoreContentRetriever.builder()
                .embeddingStore(ticketStore)
                .embeddingModel(embeddingModel)
                .maxResults(2)
                .minScore(0.6)
                .displayName("ticket")
                .build();

        Map<ContentRetriever, String> catalog = new LinkedHashMap<>();
        catalog.put(productRetriever, "产品手册：型号参数、硬件规格、续航、配件兼容性");
        catalog.put(policyRetriever, "售后政策：退换货条件、整机与电池保修期限、发票开具规则");
        catalog.put(ticketRetriever, "历史工单：真实用户反馈与客服处理记录，不代表官方政策");

        QueryRouter router = LanguageModelQueryRouter.builder()
                .chatModel(chatModel)
                .retrieverToDescription(catalog)
                .fallbackStrategy(LanguageModelQueryRouter.FallbackStrategy.ROUTE_TO_ALL)
                .build();

        RetrievalAugmentor augmentor = DefaultRetrievalAugmentor.builder()
                .queryRouter(router)
                .build();

        Assistant assistant = AiServices.builder(Assistant.class)
                .chatModel(chatModel)
                .retrievalAugmentor(augmentor)
                .build();

        List<String> questions = List.of(
                "X200 保修多久？",
                "X200 续航多少小时？",
                "X200 电池坏了能免费换吗？"
        );

        for (String question : questions) {
            System.out.println("Q: " + question);
            System.out.println("A: " + assistant.answer(question));
            System.out.println("---");
        }
    }

    private static void ingest(EmbeddingStore<TextSegment> store,
                               EmbeddingModel embeddingModel,
                               String kbName,
                               String text) {
        Document document = Document.from(text, Metadata.from("kb", kbName));
        EmbeddingStoreIngestor.builder()
                .documentSplitter(DocumentSplitters.recursive(200, 20))
                .embeddingModel(embeddingModel)
                .embeddingStore(store)
                .build()
                .ingest(document);
    }

    interface Assistant {
        @SystemMessage("""
                你是客服助手。只根据提供的资料回答，资料里没有就说不知道，不要推测。
                工单内容是用户反馈，不能当作官方政策。回答控制在三句话以内。
                """)
        String answer(@UserMessage String question);
    }
}
```

几个地方值得单独说。

`LinkedHashMap` 不是随手写的。路由器的编号顺序就是 Map 的迭代顺序，换成 `HashMap` 每次启动编号可能变，日志里对不上号，排查会很难受。

`displayName` 只影响日志。但它是排查路由问题时唯一能告诉你「这次查了哪个库」的线索，别省。

`temperature(0.0)` 给路由用，不给生成用。这里两者共用一个模型实例是为了省事，生产上建议拆开：路由用最便宜的小模型，生成用主模型。

`minScore(0.6)` 在三个库上取值一样，跑通 demo 够用。真实数据里每个库的分数分布不同，这个值要分开调，理由在第一节说过。

### 示例二：规则优先，模型兜底

订单号、物流状态这类问题，问法极其固定，没必要每次都花一次大模型调用。规则先兜一层，命中就直接走工单库。

```java
package com.example.ragrouter;

import dev.langchain4j.rag.content.retriever.ContentRetriever;
import dev.langchain4j.rag.query.Query;
import dev.langchain4j.rag.query.router.QueryRouter;

import java.util.Collection;
import java.util.List;
import java.util.regex.Pattern;

public class RuleFirstQueryRouter implements QueryRouter {

    private static final List<Pattern> TICKET_PATTERNS = List.of(
            Pattern.compile("订单号\\s*[:：]?\\s*\\d{6,}"),
            Pattern.compile("(物流|快递|发货|签收|退款进度|退到哪里)"),
            Pattern.compile("工单\\s*#?\\d+")
    );

    private final ContentRetriever ticketRetriever;
    private final QueryRouter delegate;

    public RuleFirstQueryRouter(ContentRetriever ticketRetriever, QueryRouter delegate) {
        this.ticketRetriever = ticketRetriever;
        this.delegate = delegate;
    }

    @Override
    public Collection<ContentRetriever> route(Query query) {
        String text = query.text();
        for (Pattern pattern : TICKET_PATTERNS) {
            if (pattern.matcher(text).find()) {
                return List.of(ticketRetriever);
            }
        }
        return delegate.route(query);
    }
}
```

接进管道只改一行：

```java
QueryRouter router = new RuleFirstQueryRouter(ticketRetriever, llmRouter);
```

注意 `delegate` 是接口类型，不是 `LanguageModelQueryRouter`。这样规则层可以和语义路由组合，也可以套两层规则，不用改实现。

正则别写太宽。单写一个「退款」会把「退款政策是什么」这种该走政策库的问题也劫持到工单库。规则层越贪，模型层的价值越小。

### 示例三：语义路由，一次 embedding 定去留

库多到十几个、又对延迟敏感时，用向量比对代替大模型判断。

```java
package com.example.ragrouter;

import dev.langchain4j.data.embedding.Embedding;
import dev.langchain4j.model.embedding.EmbeddingModel;
import dev.langchain4j.rag.content.retriever.ContentRetriever;
import dev.langchain4j.rag.query.Query;
import dev.langchain4j.rag.query.router.QueryRouter;
import dev.langchain4j.store.embedding.CosineSimilarity;

import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public class SemanticRouter implements QueryRouter {

    private final EmbeddingModel embeddingModel;
    private final Map<ContentRetriever, Embedding> catalogEmbeddings = new LinkedHashMap<>();
    private final double minScore;

    public SemanticRouter(EmbeddingModel embeddingModel,
                          Map<ContentRetriever, String> catalog,
                          double minScore) {
        this.embeddingModel = embeddingModel;
        this.minScore = minScore;
        for (Map.Entry<ContentRetriever, String> entry : catalog.entrySet()) {
            Embedding descriptionEmbedding = embeddingModel.embed(entry.getValue()).content();
            this.catalogEmbeddings.put(entry.getKey(), descriptionEmbedding);
        }
    }

    @Override
    public Collection<ContentRetriever> route(Query query) {
        Embedding queryEmbedding = embeddingModel.embed(query.text()).content();

        ContentRetriever best = null;
        double bestScore = -1.0;
        for (Map.Entry<ContentRetriever, Embedding> entry : catalogEmbeddings.entrySet()) {
            double score = CosineSimilarity.between(queryEmbedding, entry.getValue());
            if (score > bestScore) {
                bestScore = score;
                best = entry.getKey();
            }
        }

        if (best == null || bestScore < minScore) {
            return List.of();
        }
        return List.of(best);
    }
}
```

库描述的向量在构造时算好，运行时每个请求只花一次 embedding。这是它比 LLM 路由便宜的全部原因。

`minScore` 从 0.55 起步，把每次的 `bestScore` 和选中的库打进日志，看一两天真实流量再调。分数达不到阈值返回空集合，等于不检索——这个行为要显式处理，否则用户会收到一个没有依据的答案，你还以为是检索没命中。

## 四、踩坑经验和最佳实践

**描述写成了库名。** 这是最高频的错。`"docs"`、`"kb2"`、`"内部资料"` 这种描述，模型只能瞎猜。判断标准很简单：把你写的描述给一个不了解项目的人看，他能不能说出「什么问题该来这里查」。说不出就重写。

**fallback 用了 FAIL。** 模型偶尔会返回 `"1."` 或者 `"第一个"`，`Integer.parseInt` 直接抛异常，整个请求 500。路由是辅助环节，不该成为单点。用 `ROUTE_TO_ALL`，然后把解析失败率打点。

**路由和生成共用一个贵模型。** 路由只需要做选择题，用最便宜的那档就够。拿主模型做路由，等于每个请求多付一次主模型的输入费用，延迟还翻倍。首字延迟从 800ms 变 1600ms，用户是能感觉到的。

**多库结果合并后撑爆上下文。** 三个库各取 10 条，合并后 30 段，光资料就吃掉几千 token。每个库的 `maxResults` 控制在 3 到 4，合并后总量才可控。augmentor 会去重，但去重救不了「三个库都返回了不同片段」的情况。

**把路由结果缓存到用户维度。** 按归一化后的 query 缓存路由决策是有效优化，但键里不能带用户 ID 之外的东西，也不能跨租户复用。缓存了「查哪个库」，别顺手把「查到什么」也缓存了。

**只选一个库，丢掉多意图问题。** 「X200 坏了，保修怎么走」这类问题，正确答案需要型号信息和政策条款。路由器允许多选，prompt 里也允许输出多个编号，别在业务代码里 `findFirst()` 截断。

**对路由做监控。** 至少记录三件事：选中了哪些库、fallback 有没有触发、路由耗时。上线一周你会看到明显的分布——80% 的问题只落到一个库，那说明另外两个库的描述要么重叠要么没用。

## 五、性能对比和技术选型

三种路由的取舍，我给的是工程判断，不是跑分数据。延迟和成本都是量级概念，具体数字取决于模型和网络。

| 维度 | 规则路由 | 语义路由 | LLM 路由 |
| --- | --- | --- | --- |
| 额外延迟 | 微秒级 | 几十毫秒（一次 embedding） | 数百毫秒（一次短对话） |
| 额外成本 | 0 | 极低 | 低，但按请求累计 |
| 准确率 | 特征明确时接近 100%，否则 0 | 中等，问法差异大时下降 | 高，能理解上下文和同义表达 |
| 多库返回 | 需要手写 | 需要额外逻辑 | 原生支持 |
| 维护成本 | 正则要跟着业务改 | 描述改了要重算向量 | 描述改了立即生效 |
| 可解释性 | 最好，命中哪条规则一目了然 | 一般，只有分数 | 差，只能看它选了谁 |

我推荐的组合顺序：

1. 有强特征词的业务，规则先兜，比如订单号、运单号、工单号。
2. 剩下的交给 LLM 路由，描述写细，fallback 设成 `ROUTE_TO_ALL`。
3. 只有当库数量超过 10 个、或者 P99 延迟卡得极死，才考虑语义路由。
4. 库数量少于 3 个、内容主题不重叠时，别折腾路由，直接全查更省事。

最后一条常被忽略。路由是为了解决「库之间互相污染」，如果你的三个库分别存代码规范、财务制度、人事流程，语义空间本来就不重叠，加路由只是给自己增加一个故障点。

## 六、总结

路由解决的是「搜错地方」，不是「搜得不准」。这两件事的解法完全不同：前者靠分流，后者靠切分、改写、重排。搞混了就会在 topK 和阈值上反复折腾，怎么调都不对。

落地路径很清楚：给每个库写一句能回答「什么问题来这里」的描述，用 `LanguageModelQueryRouter` 把描述变成选项，`DefaultRetrievalAugmentor` 负责合并结果，`AiServices` 里挂上去，代码量不到 50 行。

真正花时间的是描述和监控，不是代码。描述决定了路由的上限，监控决定了你能不能发现它偷偷失效。

文 / 会编程的吕洞宾

## 参考资料

- [LangChain4j RAG 官方文档（含 Query Routing 一节）](https://docs.langchain4j.dev/tutorials/rag/)
- [LangChain4j 源码仓库](https://github.com/langchain4j/langchain4j)
- [langchain4j 1.24.0 构件（Maven Central）](https://repo1.maven.org/maven2/dev/langchain4j/langchain4j/1.24.0/)
