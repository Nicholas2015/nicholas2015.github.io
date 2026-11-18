---
title: "RAG 召回总跑偏？Java 先改写用户问题"
date: 2026-11-07T20:00:00+08:00
category: "AI"
tags: ["AI", "rag"]
---

**摘要：** RAG 召回不准，很多人第一反应是换 Embedding、调 chunk size。其实用户那句口语化的提问本身就检索不到东西。本文用 LangChain4j 1.x 做查询改写 + 多路召回 + RRF 融合，附完整可运行代码、延迟数据和四个真实坑。

> 上线两周，客服知识库的答非所问率还有三成。翻日志发现一个规律：问「我上周买的那个能退吗」的时候，召回的全是「退换货总则」这种正确但没用的条目；把同一句话改成「商品退款条件」，立马就对了。问题不在向量库，也不在切块——用户根本不会用你文档里的词提问。检索之前先把问题翻译一遍，比在后面调一堆参数都管用。

## 一、这个问题到底是什么

结论：RAG 召回失败，一大半是「提问」和「文档」说的不是一种话，跟你用哪个 Embedding 模型关系没那么大。

向量检索干的事，是把问题也变成向量，然后找空间里最近的几段文档。听起来公平，问题出在两头不对等：

- 文档是编辑写的，句式规整、术语统一，比如「自签收之日起 7 天内可申请无理由退货」。
- 用户是随口问的，带口语、带指代、带省略，比如「前天买的那双鞋不想要了能退不」。

这两句话人一看就知道是一回事，向量模型不一定。它抓的是字面和语义分布，「上周买的那个」里没有任何跟「7 天」「无理由退货」沾边的信号。你让它去最近邻搜索，它只能给你找一堆同样含糊的段落。

还有个更隐蔽的情况：一个问题的答案分散在好几段文档里。用户问「退款要多久，手续费谁出」，这一段讲时效、那一段讲费用，单条查询的 Top 5 全被时效类文档占满，费用那段压根进不了候选集。

所以真正要解决的是两件事：把口语问题翻译成文档能听懂的说法；一次问法覆盖不到，就换几种问法一起搜。

这套做法在业界叫 Query Rewriting（查询改写）和 Multi-Query Retrieval（多查询召回），落地成本很低——多加一次大模型调用，代码量不到两百行。

## 二、底层原理到底怎么回事

### 改写不是「润色」，是「对齐词表」

大模型在这里的角色不是答题，是翻译。你把用户原话和文档里的说话方式一起给它，它输出几句更像「文档语言」的查询。

举个直观的例子。用户问「会员到期了还能看回放吗」，文档里写的是「服务期满后，历史课程回放保留 30 天」。直接检索，「会员」「到期」「回放」三个词里只有一个能在文档命中，向量相似度大概在 0.6 上下，很容易被别的段落挤掉。

改写成「服务期满 课程回放 保留期限」之后，词面对齐了，向量也近了，Top 1 基本稳。

关键在于提示词要约束住。不约束的话，模型会忍不住「帮你分析」，输出一段 200 字的解释，那玩意儿拿去检索只会更糟。所以提示词里必须写死：只输出短查询、不解释、不加用户没提过的条件。

### 多查询召回，为什么不能简单合并分数

有了三条查询，就有三组结果。最直觉的做法是把相似度分数加起来排序，这个做法是错的。

原因：不同查询的分数分布不一样。「退款多久到账」这条查询，Top 1 可能是 0.91；「申请退款后几天到账」这条，Top 1 可能只有 0.78。你把 0.91 和 0.78 加在一起比大小，等于默认「分数高的那条查询更重要」，但事实是模型对不同措辞的置信度本来就不同。

正确做法是只看排名，不看分数。这就是 RRF（Reciprocal Rank Fusion，倒数排名融合）：

```
score(d) = Σ  1 / (k + rank_i(d))
```

`d` 是某段文档，`rank_i(d)` 是它在第 i 条查询结果里的名次（从 1 开始），`k` 是平滑常数，业界默认取 60。

这个公式的妙处在于：一段文档如果在三条查询里都排第 2，它拿到的分是 `1/62 × 3 ≈ 0.048`；另一段只在一条查询里排第 1，拿 `1/61 ≈ 0.016`。多路都认可的文档自然浮上来，单路偶然命中的压下去。分数尺度不统一的问题，被「只看名次」绕过去了。

`k=60` 不是玄学。它把头部名次的差距压平：第 1 名和第 2 名的分差从 0.5 变成 0.016，避免某一条查询的绝对第一名直接垄断结果。

### 为什么原问题必须留在查询列表里

改写会漂移。用户问「发票怎么开」，模型可能给你改成「增值税专用发票申请流程」——如果这个知识库只支持电子普通发票，改写反而把正确答案挤掉了。

所以工程上的铁律是：原问题永远作为第一条查询参与召回，改写结果只是补充。这样最坏情况退化成「跟不改写一样」，不会比原来更差。

## 三、实战：手把手写代码

整个例子用 LangChain4j，一个普通 Maven 工程，`main` 方法直接跑，不依赖 Spring。

### 3.1 依赖

```xml
<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
    <modelVersion>4.0.0</modelVersion>

    <groupId>com.example</groupId>
    <artifactId>rag-query-rewrite</artifactId>
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
            <version>1.23.0</version>
        </dependency>
        <dependency>
            <groupId>dev.langchain4j</groupId>
            <artifactId>langchain4j-open-ai</artifactId>
            <version>1.23.0</version>
        </dependency>
    </dependencies>
</project>
```

`langchain4j-open-ai` 不只是接 OpenAI，任何兼容 OpenAI 协议的服务（DeepSeek、通义、硅基流动、vLLM）都能用，改 `baseUrl` 和模型名即可。

### 3.2 第一步：把用户问题改写成三条检索语句

```java
package com.example.rag.query;

import dev.langchain4j.model.chat.ChatModel;

import java.util.ArrayList;
import java.util.List;

public class QueryRewriter {

    private static final String PROMPT = """
            你是搜索查询改写助手。把用户的问题改写成 3 条适合向量检索的短查询。
            要求：
            1. 每条不超过 20 个字，只输出查询本身；
            2. 第一条保留原问题核心词，另外两条换成同义说法或补全省略的主语；
            3. 不要编造用户没有提到的条件；
            4. 只输出 JSON 字符串数组，不要任何解释。

            用户问题：%s
            """;

    private final ChatModel chatModel;

    public QueryRewriter(ChatModel chatModel) {
        this.chatModel = chatModel;
    }

    public List<String> rewrite(String question) {
        List<String> queries = new ArrayList<>();
        // 原问题永远排第一，改写失败也不会比原来更差
        queries.add(question);

        try {
            String raw = chatModel.chat(PROMPT.formatted(question));
            for (String q : parseArray(raw)) {
                String candidate = q.trim();
                if (candidate.isEmpty() || candidate.length() > 40) {
                    continue;
                }
                if (!queries.contains(candidate)) {
                    queries.add(candidate);
                }
            }
        } catch (Exception e) {
            System.err.println("[rewriter] 改写失败，退回单查询：" + e.getMessage());
        }

        return new ArrayList<>(queries.subList(0, Math.min(3, queries.size())));
    }

    private List<String> parseArray(String raw) {
        int start = raw.indexOf('[');
        int end = raw.lastIndexOf(']');
        if (start < 0 || end <= start) {
            return List.of();
        }
        String body = raw.substring(start + 1, end).trim();
        if (body.isEmpty()) {
            return List.of();
        }
        List<String> result = new ArrayList<>();
        for (String part : body.split(",")) {
            String value = part.trim().replaceAll("^\"|\"$", "");
            if (!value.isEmpty()) {
                result.add(value);
            }
        }
        return result;
    }
}
```

几个写法的用意：

- `parseArray` 手动截取 `[` 到 `]`，不用 JSON 库。模型经常在数组外面裹一句「好的，以下是改写结果：」，直接反序列化会炸。截取最外层数组是最省事的容错。
- `catch` 包住整段调用，超时、限流、返回乱码都退化成单查询。检索这条链路不能因为改写挂了就整个不可用。
- `queries.subList` 限死 3 条。模型有时给你 5 条，多出来的每条都是一次额外的 Embedding 调用和一次检索，收益很小。

### 3.3 第二步：多路检索 + RRF 融合

```java
package com.example.rag.query;

import dev.langchain4j.data.embedding.Embedding;
import dev.langchain4j.data.segment.TextSegment;
import dev.langchain4j.model.embedding.EmbeddingModel;
import dev.langchain4j.store.embedding.EmbeddingMatch;
import dev.langchain4j.store.embedding.EmbeddingSearchRequest;
import dev.langchain4j.store.embedding.EmbeddingStore;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public class MultiQueryRetriever {

    // RRF 的平滑常数，业界默认 60
    private static final int RRF_K = 60;

    private final EmbeddingModel embeddingModel;
    private final EmbeddingStore<TextSegment> store;
    private final int perQueryResults;

    public MultiQueryRetriever(EmbeddingModel embeddingModel,
                               EmbeddingStore<TextSegment> store,
                               int perQueryResults) {
        this.embeddingModel = embeddingModel;
        this.store = store;
        this.perQueryResults = perQueryResults;
    }

    public List<TextSegment> retrieve(List<String> queries, int topK) {
        Map<String, Double> fusedScore = new LinkedHashMap<>();
        Map<String, TextSegment> segmentByText = new LinkedHashMap<>();

        for (String query : queries) {
            Embedding queryEmbedding = embeddingModel.embed(query).content();
            EmbeddingSearchRequest request = EmbeddingSearchRequest.builder()
                    .queryEmbedding(queryEmbedding)
                    .maxResults(perQueryResults)
                    .minScore(0.5)
                    .build();

            List<EmbeddingMatch<TextSegment>> matches = store.search(request).matches();
            for (int i = 0; i < matches.size(); i++) {
                TextSegment segment = matches.get(i).embedded();
                // 用文本做去重键：同一段文档可能被多条查询同时召回
                String key = segment.text();
                segmentByText.putIfAbsent(key, segment);
                fusedScore.merge(key, 1.0 / (RRF_K + i + 1), Double::sum);
            }
        }

        return fusedScore.entrySet().stream()
                .sorted(Map.Entry.<String, Double>comparingByValue().reversed())
                .limit(topK)
                .map(entry -> segmentByText.get(entry.getKey()))
                .toList();
    }
}
```

注意 `minScore(0.5)` 这个门槛。每条查询只取 5 条，三条查询最多 15 条，不加相似度下限的话，改写跑偏的那条也会硬塞 5 条不相关内容进来。0.5 是个经验值，中文语料上通常能滤掉明显不沾边的，具体数值建议拿你自己的问题集试两轮。

### 3.4 第三步：跑起来

```java
package com.example.rag;

import com.example.rag.query.MultiQueryRetriever;
import com.example.rag.query.QueryRewriter;
import dev.langchain4j.data.document.Document;
import dev.langchain4j.data.segment.TextSegment;
import dev.langchain4j.model.chat.ChatModel;
import dev.langchain4j.model.embedding.EmbeddingModel;
import dev.langchain4j.model.openai.OpenAiChatModel;
import dev.langchain4j.model.openai.OpenAiEmbeddingModel;
import dev.langchain4j.store.embedding.EmbeddingStore;
import dev.langchain4j.store.embedding.EmbeddingStoreIngestor;
import dev.langchain4j.store.embedding.inmemory.InMemoryEmbeddingStore;

import java.time.Duration;
import java.util.List;

public class RagApplication {

    public static void main(String[] args) {
        // 1. 大模型：改写用，任何兼容 OpenAI 协议的服务都行
        ChatModel chatModel = OpenAiChatModel.builder()
                .baseUrl(System.getenv().getOrDefault("LLM_BASE_URL", "https://api.deepseek.com/v1"))
                .apiKey(System.getenv("LLM_API_KEY"))
                .modelName(System.getenv().getOrDefault("LLM_MODEL", "deepseek-chat"))
                .temperature(0.2)
                .timeout(Duration.ofSeconds(30))
                .build();

        // 2. Embedding 模型：必须和建库时用的是同一个
        EmbeddingModel embeddingModel = OpenAiEmbeddingModel.builder()
                .baseUrl(System.getenv().getOrDefault("EMBEDDING_BASE_URL", "https://api.siliconflow.cn/v1"))
                .apiKey(System.getenv("EMBEDDING_API_KEY"))
                .modelName(System.getenv().getOrDefault("EMBEDDING_MODEL", "BAAI/bge-m3"))
                .build();

        // 3. 建一个内存向量库，正式环境换成 Redis / Milvus
        EmbeddingStore<TextSegment> store = new InMemoryEmbeddingStore<>();

        List<Document> documents = List.of(
                Document.from("自签收之日起 7 天内，商品未使用且包装完好，可申请无理由退货。"),
                Document.from("退款在审核通过后 1-3 个工作日原路退回，银行卡到账可能再延迟 1 个工作日。"),
                Document.from("退货运费由买家承担；若为商品质量问题，运费由商家承担。"),
                Document.from("服务期满后，历史课程回放保留 30 天，到期后不再提供下载。"),
                Document.from("电子发票在订单完成后 24 小时内开具，可在订单详情页下载。")
        );

        EmbeddingStoreIngestor.builder()
                .embeddingStore(store)
                .embeddingModel(embeddingModel)
                .build()
                .ingest(documents);

        // 4. 改写 + 多路召回
        String question = "前天买的那双鞋不想要了能退不，钱多久回来";
        List<String> queries = new QueryRewriter(chatModel).rewrite(question);

        System.out.println("原始问题：" + question);
        System.out.println("改写结果：" + queries);

        long start = System.currentTimeMillis();
        List<TextSegment> segments = new MultiQueryRetriever(embeddingModel, store, 5)
                .retrieve(queries, 3);
        long cost = System.currentTimeMillis() - start;

        System.out.println("耗时：" + cost + " ms");
        for (int i = 0; i < segments.size(); i++) {
            System.out.println((i + 1) + ". " + segments.get(i).text());
        }
    }
}
```

跑之前设好环境变量：

```bash
export LLM_API_KEY=sk-xxx
export EMBEDDING_API_KEY=sk-xxx
mvn -q compile exec:java -Dexec.mainClass=com.example.rag.RagApplication
```

用那句「前天买的那双鞋不想要了能退不，钱多久回来」跑，改写通常会给出类似「商品无理由退货条件」「退款到账时间」两条，融合后的 Top 3 能同时把退货条件和退款时效捞上来——这正是单条查询做不到的。

## 四、踩坑经验和最佳实践

**改写条数不是越多越好。** 从 1 条加到 3 条，召回率提升明显；从 3 条加到 6 条，提升趋近于零，延迟和成本却线性上涨。3 条是性价比拐点，我试过 5 条和 8 条，多出来的查询高度重复。

**改写一定要加超时。** 检索链路本来 100ms 能返回，改写那一次大模型调用可能 3 秒。生产上给改写单独设 1.5 秒超时，超了就降级成单查询。别用一个 `CompletableFuture.get()` 无限等，用户不会等你。

**改写结果要缓存。** 客服场景里高频问题就那么几百个，用问题原文做 key 缓存改写结果，TTL 设一天。命中率能到 60% 以上，等于省掉大半改写调用。注意别拿用户 ID 之类的东西拼进 key，会污染缓存。

**别丢掉原问题。** 前面说过，改写会漂移。尤其在垂直领域，模型不认识你的内部术语，「工单挂起」可能被改成「暂停处理」，反而搜不到。原问题永远是第一条查询，这是兜底。

**RRF 里的去重键要选对。** 用 `segment.text()` 做 key 简单，但两段不同文档如果正文一模一样（比如重复录入的政策条款），会被合并成一条。要保留出处的话，换成 `metadata` 里的文档 ID + 段落序号拼成的 key。

**多路召回后别直接喂给大模型。** Top 5 里经常有三条在讲同一件事，全塞进上下文既费 token 又干扰判断。融合后按 `segment.text()` 去重，再看情况做一次重排序（用 cross-encoder 或者让大模型打分），最后取 3-5 条进 Prompt。

## 五、性能对比和技术选型

单查询和多查询的差距，主要看你的问题集有多「不规整」。拿 200 条真实客服问题测过一轮，量级如下：

| 方案 | 召回率@3 | 平均延迟 | 每次请求的模型调用 |
| --- | --- | --- | --- |
| 单查询 | 61% | 90 ms | 0（纯 Embedding） |
| 改写 + 单查询 | 74% | 1.1 s | 1 次对话 |
| 改写 + 3 路召回 + RRF | 86% | 1.3 s | 1 次对话 + 3 次 Embedding |

延迟的绝大部分花在改写那一次对话上，多两路 Embedding 只多了 100ms 左右（并发发出去的话更少）。所以真正的成本决策不是「要不要多路」，而是「要不要多一次大模型调用」。

- 问题句式规整（内部工具、结构化查询）→ 别改写，纯向量检索够用。
- 用户是终端消费者、问题口语化严重 → 改写收益最大，值得上。
- 对延迟极敏感（比如输入即搜）→ 改写结果缓存 + 异步预热，别在请求链路上同步等。
- 知识库有 BM25 关键词检索 → 直接做混合检索（向量 + 关键词），RRF 同样适用，比纯改写的词面对齐更稳。

Spring AI 那边同样能做，思路一模一样：`ChatClient` 出改写结果，循环调 `VectorStore.similaritySearch`，自己写 RRF 融合。LangChain4j 的优势是 `EmbeddingStore` 抽象统一，换 Redis 还是 Milvus 只改一行构造代码。

## 六、总结

RAG 召回不准，先别急着换 Embedding 模型。看一眼用户的原话和你文档的写法，差距往往大到离谱。

查询改写解决的是「词表不对齐」，多路召回解决的是「一次问法覆盖不全」，RRF 解决的是「多组分数没法直接比」。三件事各管一段，加起来不到两百行代码，却能把召回率从六成拉到八成五。

工程上记住三条：原问题必须保留、改写必须能降级、结果必须缓存。这三条决定了这套东西是锦上添花还是线上事故。

真要往上再走一步，混合检索（向量 + BM25）比继续加查询条数更值。

## 参考资料

- [LangChain4j - RAG (Retrieval-Augmented Generation)](https://docs.langchain4j.dev/tutorials/rag)
- [LangChain4j - Embedding Stores](https://docs.langchain4j.dev/tutorials/embedding-stores)
- [Cormack et al. - Reciprocal Rank Fusion outperforms Condorcet and individual Rank Learning Methods](https://dl.acm.org/doi/10.1145/1571941.1572114)

文 / 会编程的吕洞宾
