---
title: "RAG 答非所问？Java 混合检索加重排序"
date: 2026-10-23T20:00:00+08:00
category: "AI"
tags: ["AI", "rag"]
---

> 知识库里明明躺着一条 `ERR_CONN_4021` 的处理文档，用户问起这个错误码，RAG 却把"连接超时的通用排查"回了一遍。答案看着挺像那么回事，就是没用。这类问题不是模型笨，是检索这一层漏了。纯向量检索只认"意思像"，不认"字面一模一样"。今天我们把这个洞补上：用 BM25 抓精确词，用向量抓语义，用 RRF 把两路结果合起来，最后让模型对候选做一次重排序。全是 Java，核心逻辑两百行左右。

## 一、这个问题到底是什么

**向量检索擅长"意思相近"，不擅长"字符串相同"，这是它的设计决定的，不是配置问题。**

把文档变成向量的过程，是把一整段话压成一千多个浮点数。压缩的时候，模型保留的是语义轮廓："连接超时"和"连接池满了"在向量空间里离得很近，因为它们讲的是同一类事。代价是细节被磨平了。`ERR_CONN_4021` 这种字符串，在训练语料里出现次数极少，模型没学过它有多重要，压完之后它跟"某个错误码"没什么区别。

于是就有了那个经典场面：

- 用户问：`ERR_CONN_4021 是什么错误？服务一直在重试`
- 向量检索返回：连接超时和读超时要分开看 / 重试要用指数退避 / 网关 502 怎么排查
- 真正该返回的那条，讲 4021 的，排在第五名开外

三条返回里两条都在讲"重试",看起来高度相关，实际上没有一条回答了"4021 是什么"。模型拿着这三条去组织语言，只能编出一个听起来合理的答案。这就是 RAG 里最难发现的一类错误——**检索错了，但错得很像对的**。

判断一个查询属于哪一类，有个土办法：把问题里的专有名词全删掉，剩下的句子还成立吗？

| 查询 | 删掉专有名词后 | 类型 | 靠什么检索 |
|---|---|---|---|
| 服务连接不上怎么办 | 还能问，语义完整 | 语义型 | 向量 |
| `ERR_CONN_4021` 是什么 | 只剩"是什么"，没法问 | 实体型 | 关键词 |
| 4021 报错要不要重试 | 还剩"报错要不要重试" | 混合型 | 两路都要 |

真实业务里，第三类最多。客服问订单号，运维问错误码，电商问 SKU，法务问条款编号——全是"语义 + 实体"的混合体。只上向量检索，等于把实体那一半直接扔了。

## 二、底层原理到底怎么回事

**混合检索的本质，是让两条互补的召回路径各干各擅长的事，再用排名融合把结果拼起来，最后用重排序做一次精排。**

拆成四步看。

### 2.1 向量检索：按含义找

文档先过 embedding 模型变成向量，查询也变成向量，然后算余弦相似度——两个向量夹角越小，意思越接近。

它的强项是"换了说法也能找到"。用户说"扣了两次钱"，文档写"重复扣款"，字面一个词都不重合，向量照样能对上。弱项也在这儿：它对面"字面"完全不敏感。错误码、型号、人名、函数名，这些靠的是精确字符匹配，语义模型帮不上忙。

工程上还有个现实约束：向量检索通常走 ANN 近似索引，为了速度牺牲一点召回。topK 给小了，正确答案压根进不了候选池，后面再好的模型也救不回来。

### 2.2 BM25：按词找

BM25 是搜索引擎用了几十年的经典算法。它给"文档和查询的匹配程度"打分，分数由三个因子决定：

```
score = IDF(词) × [ tf × (k1+1) ] / [ tf + k1 × (1 - b + b × 文档长度/平均长度) ]
```

翻译成人话：

- **tf（词频）**：这个词在这篇文档里出现几次。出现越多越相关，但收益递减——出现十次不比出现五次强一倍，`k1` 就是控制这个饱和速度的旋钮。
- **IDF（逆文档频率）**：这个词在全库里有多稀有。`ERR_CONN_4021` 只在两篇文档里出现，权重就高；"的""是"满库都是，权重趋近于零。这是 BM25 能抓住错误码的根本原因。
- **长度归一化**：长文档天然更容易命中词，得压一压。`b` 控制压制力度，0.75 是常用值。

BM25 不需要模型、不需要 GPU、不花钱，纯内存计算，几万篇文档也是毫秒级。它的死穴是"不懂同义词"——用户说"扣了两次钱"，文档写"重复扣款",零命中。

中文还有个坑：BM25 靠空格切词，中文没空格。上分词器（IK、jieba）当然可以，但要多引一个依赖、多维护一份词典。轻量做法是**按字切 bigram**：把"连接池满了"切成 `连接`、`接池`、`池满`、`满了`。粗是粗了点，但对错误码、专有名词这类查询，效果比想象中好，而且零依赖。我们的示例代码就走这条路。

### 2.3 RRF：把两路排名合起来

问题来了：向量检索给的是 0 到 1 的余弦相似度，BM25 给的是没有上界的分数，两个数根本不能相加。硬加权只会变成调参地狱。

RRF（Reciprocal Rank Fusion）绕开了这个问题——**它不看分数，只看排名**：

```
RRF(d) = Σ 1 / (k + rank_i(d))
```

一篇文档在每一路里的名次，取倒数加起来。`k` 通常取 60，作用是压平头部差距，避免某一路的第一名一家独大。

好处很直接：不管两路分数量纲差多远，只要"排在前面的更可信"这个假设成立，融合就有效。而且它对单路的异常分数天然免疫——某一路给出一个荒谬的高分，RRF 完全不关心。

一篇文档如果在向量里排第 2、在 BM25 里排第 1，得分是 `1/62 + 1/61 ≈ 0.0325`；另一篇只在向量里排第 1，得分是 `1/61 ≈ 0.0164`。两路都认可的，稳压单路第一。这正是我们要的效果：**错误码文档靠 BM25 进榜，语义文档靠向量进榜，两路都对的排最前。**

### 2.4 重排序：精度换延迟

融合之后的候选池大概 8 到 20 条，但它们只是"可能相关"。真正的排序要靠重排序模型。

区别在计算方式：向量检索是 bi-encoder，问题和文档**各自**算向量，从没见过面，所以快但粗。重排序是 cross-encoder（或者干脆让大模型来判断），把"问题 + 文档"一起喂进去，逐字比对，精度高一个档次，但每对都要算一次，慢且贵。

所以工业界的标准做法是两阶段漏斗：

1. 召回阶段用便宜的方法（向量 + BM25）从十万篇里捞 20 条
2. 精排阶段用贵的方法只对这 20 条打分，取前 3

**永远不要用大模型对全库排序**，那是烧钱。候选 20 条、最终留 3 条，是成本和效果比较平衡的位置。

## 三、实战：手把手写代码

先看依赖。用 Maven 建一个普通 Java 项目，不需要 Spring。

```xml
<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
    <modelVersion>4.0.0</modelVersion>

    <groupId>com.example</groupId>
    <artifactId>rag-hybrid</artifactId>
    <version>1.0.0</version>

    <properties>
        <maven.compiler.release>21</maven.compiler.release>
        <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
    </properties>

    <dependencies>
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
        <dependency>
            <groupId>org.slf4j</groupId>
            <artifactId>slf4j-simple</artifactId>
            <version>2.0.20</version>
        </dependency>
    </dependencies>

    <build>
        <plugins>
            <plugin>
                <groupId>org.apache.maven.plugins</groupId>
                <artifactId>maven-compiler-plugin</artifactId>
                <version>3.16.0</version>
            </plugin>
            <plugin>
                <groupId>org.codehaus.mojo</groupId>
                <artifactId>exec-maven-plugin</artifactId>
                <version>3.6.4</version>
                <configuration>
                    <mainClass>com.example.rag.Main</mainClass>
                </configuration>
            </plugin>
        </plugins>
    </build>
</project>
```

`langchain4j` 是核心包，里面有 `EmbeddingModel`、`Content`、`ReciprocalRankFuser` 这些我们直接用的东西；`langchain4j-open-ai` 提供 OpenAI 协议的实现，任何兼容 OpenAI 接口的服务（DashScope 兼容模式、vLLM、Ollama 的 OpenAI 端点）都能接。

### 3.1 语料：十二篇运维文档

```java
package com.example.rag;

import dev.langchain4j.data.segment.TextSegment;

import java.util.List;

public final class Corpus {

    private Corpus() {
    }

    public static List<TextSegment> load() {
        return List.of(
                TextSegment.from("ERR_CONN_4021：上游连接池耗尽。常见触发场景是下游响应变慢，连接归还不上。"
                        + "处理步骤：先看连接池活跃连接数和等待队列长度；临时调大 maxPoolSize 只能缓解，"
                        + "根因通常是下游 P99 变长。"),
                TextSegment.from("ERR_CONN_4021 在旧版网关里表示连接池满，新版网关把这个错误改成了 ERR_CONN_4031，"
                        + "排查日志时两个错误码都可能出现，看网关版本号区分。"),
                TextSegment.from("连接超时和读超时要分开看。连接超时说明 TCP 握手没完成，读超时说明连上了但对方不返回数据。"
                        + "前者查网络和 DNS，后者查下游处理耗时。"),
                TextSegment.from("重试策略建议：只对幂等接口重试，最多 3 次，退避用指数退避加随机抖动。"
                        + "对非幂等的写接口重试会造成重复扣款。"),
                TextSegment.from("HTTP 429 是限流响应，说明请求发太快了。收到 429 应该降低发送速率，"
                        + "而不是立刻重试，否则会放大拥塞。"),
                TextSegment.from("网关 502 通常是上游进程挂了或者端口没起来，503 是上游过载或被摘除。"
                        + "两者都要先看健康检查结果。"),
                TextSegment.from("线程池打满的表现是任务排队、接口 RT 上涨但 CPU 不高。"
                        + "先看队列长度和拒绝策略，不要一上来就加线程数。"),
                TextSegment.from("DNS 解析失败也会表现为连接超时，因为拿不到 IP 就建不了连接。"
                        + "排查时用 dig 对比宿主机和容器内的解析结果。"),
                TextSegment.from("TLS 握手失败常见原因是证书过期或证书链不完整。"
                        + "用 openssl s_client 可以看到完整的握手过程。"),
                TextSegment.from("全链路追踪里 traceId 串不起来，多半是异步线程没有传递 MDC，"
                        + "或者跨服务调用时没透传 header。"),
                TextSegment.from("发版回滚要先摘流量再回滚，避免新旧版本同时处理同一批请求。"),
                TextSegment.from("JVM GC 停顿会导致接口偶发超时，看 GC 日志里的 pause 时间，"
                        + "老年代回收频繁说明堆内存不够或者有内存泄漏。")
        );
    }
}
```

这十二篇是刻意设计的：第 1、2 篇是错误码专属文档，第 3、4、5、6 篇是"语义相邻但答非所问"的干扰项。真实知识库里干扰项只会更多。

### 3.2 向量检索：算余弦，取前 K

```java
package com.example.rag;

import dev.langchain4j.data.segment.TextSegment;
import dev.langchain4j.model.embedding.EmbeddingModel;
import dev.langchain4j.rag.content.Content;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

public class VectorRetriever {

    private final EmbeddingModel embeddingModel;
    private final List<TextSegment> segments;
    private final List<float[]> vectors;

    public VectorRetriever(EmbeddingModel embeddingModel, List<TextSegment> segments) {
        this.embeddingModel = embeddingModel;
        this.segments = segments;
        this.vectors = new ArrayList<>();
        for (TextSegment segment : segments) {
            vectors.add(embeddingModel.embed(segment).content().vector());
        }
    }

    public List<Content> retrieve(String query, int topK) {
        float[] queryVector = embeddingModel.embed(query).content().vector();
        List<Scored> scored = new ArrayList<>();
        for (int i = 0; i < segments.size(); i++) {
            scored.add(new Scored(segments.get(i), cosine(queryVector, vectors.get(i))));
        }
        scored.sort(Comparator.comparingDouble(Scored::score).reversed());
        return scored.stream()
                .limit(topK)
                .map(scoredSegment -> Content.from(scoredSegment.segment()))
                .toList();
    }

    private static double cosine(float[] a, float[] b) {
        double dot = 0.0;
        double normA = 0.0;
        double normB = 0.0;
        for (int i = 0; i < a.length; i++) {
            dot += (double) a[i] * b[i];
            normA += (double) a[i] * a[i];
            normB += (double) b[i] * b[i];
        }
        if (normA == 0.0 || normB == 0.0) {
            return 0.0;
        }
        return dot / (Math.sqrt(normA) * Math.sqrt(normB));
    }

    private record Scored(TextSegment segment, double score) {
    }
}
```

构造函数里把所有文档的向量算好存内存——示例数据量小，这么做最直观。生产环境这一步换成向量数据库，`retrieve` 方法里的循环变成一次 `search` 调用，其余逻辑不动。

返回类型是 `Content` 而不是 `TextSegment`，因为后面要交给 `ReciprocalRankFuser` 融合，它认的就是 `Content`。

### 3.3 关键词检索：手写 BM25

```java
package com.example.rag;

import dev.langchain4j.data.segment.TextSegment;
import dev.langchain4j.rag.content.Content;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

public class Bm25Retriever {

    private static final double K1 = 1.2;
    private static final double B = 0.75;

    private final List<TextSegment> segments;
    private final List<Map<String, Integer>> termFrequencies = new ArrayList<>();
    private final Map<String, Integer> documentFrequencies = new HashMap<>();
    private final List<Integer> lengths = new ArrayList<>();
    private final double averageLength;

    public Bm25Retriever(List<TextSegment> segments) {
        this.segments = segments;
        for (TextSegment segment : segments) {
            List<String> tokens = tokenize(segment.text());
            Map<String, Integer> tf = new HashMap<>();
            for (String token : tokens) {
                tf.merge(token, 1, Integer::sum);
            }
            termFrequencies.add(tf);
            lengths.add(tokens.size());
            for (String token : tf.keySet()) {
                documentFrequencies.merge(token, 1, Integer::sum);
            }
        }
        this.averageLength = lengths.stream().mapToInt(Integer::intValue).average().orElse(1.0);
    }

    public List<Content> retrieve(String query, int topK) {
        Set<String> queryTerms = new LinkedHashSet<>(tokenize(query));
        List<Scored> scored = new ArrayList<>();
        for (int i = 0; i < segments.size(); i++) {
            Map<String, Integer> tf = termFrequencies.get(i);
            int length = lengths.get(i);
            double score = 0.0;
            for (String term : queryTerms) {
                int frequency = tf.getOrDefault(term, 0);
                if (frequency == 0) {
                    continue;
                }
                int df = documentFrequencies.getOrDefault(term, 0);
                double idf = Math.log(1.0 + (segments.size() - df + 0.5) / (df + 0.5));
                double denominator = frequency + K1 * (1 - B + B * length / averageLength);
                score += idf * (frequency * (K1 + 1)) / denominator;
            }
            if (score > 0) {
                scored.add(new Scored(segments.get(i), score));
            }
        }
        scored.sort(Comparator.comparingDouble(Scored::score).reversed());
        return scored.stream()
                .limit(topK)
                .map(scoredSegment -> Content.from(scoredSegment.segment()))
                .toList();
    }

    static List<String> tokenize(String text) {
        String lower = text.toLowerCase(Locale.ROOT);
        List<String> tokens = new ArrayList<>();
        StringBuilder ascii = new StringBuilder();
        StringBuilder cjk = new StringBuilder();
        for (int i = 0; i < lower.length(); i++) {
            char c = lower.charAt(i);
            if (c >= 0x4E00 && c <= 0x9FFF) {
                flushAscii(ascii, tokens);
                cjk.append(c);
            } else if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_' || c == '.' || c == '-') {
                flushCjk(cjk, tokens);
                ascii.append(c);
            } else {
                flushAscii(ascii, tokens);
                flushCjk(cjk, tokens);
            }
        }
        flushAscii(ascii, tokens);
        flushCjk(cjk, tokens);
        return tokens;
    }

    private static void flushAscii(StringBuilder buffer, List<String> tokens) {
        if (buffer.length() > 0) {
            tokens.add(buffer.toString());
            buffer.setLength(0);
        }
    }

    private static void flushCjk(StringBuilder buffer, List<String> tokens) {
        if (buffer.length() == 0) {
            return;
        }
        String run = buffer.toString();
        buffer.setLength(0);
        if (run.length() == 1) {
            tokens.add(run);
            return;
        }
        for (int i = 0; i < run.length() - 1; i++) {
            tokens.add(run.substring(i, i + 2));
        }
    }

    private record Scored(TextSegment segment, double score) {
    }
}
```

三个关键点，值得单独说：

**切词规则。** ASCII 字母、数字、下划线、点、连字符连在一起算一个词，所以 `ERR_CONN_4021` 是一个完整 token，不会被拆碎。中文连续段走 bigram，切出相邻两字。两种字符交界处强制分段，避免 `4021是什么` 粘成一个 token。

**IDF 的位置。** 它乘在每一项上，所以只在少量文档出现的词会主导分数。`err_conn_4021` 只出现在 2 篇里，IDF 很高；"连接""超时"这类词在七八篇里都有，IDF 低。结果就是精确匹配的文档天然排前面，不需要任何额外规则。

**分数为 0 直接丢弃。** 一个词都没命中的文档不该出现在关键词结果里，否则它会以"最后一名"的身份混进 RRF，白占一个位置。

### 3.4 用大模型做重排序

LangChain4j 的 `ScoringModel` 接口就是为这件事准备的：给它一批文档和一个查询，它返回一组分数。

```java
package com.example.rag;

import dev.langchain4j.data.segment.TextSegment;
import dev.langchain4j.model.chat.ChatModel;
import dev.langchain4j.model.output.Response;
import dev.langchain4j.model.scoring.ScoringModel;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class LlmScoringModel implements ScoringModel {

    private static final Pattern SCORE_LINE = Pattern.compile("(\\d+)\\s*[:：]\\s*(\\d+(?:\\.\\d+)?)");

    private final ChatModel chatModel;

    public LlmScoringModel(ChatModel chatModel) {
        this.chatModel = chatModel;
    }

    @Override
    public Response<List<Double>> scoreAll(List<TextSegment> segments, String query) {
        if (segments.isEmpty()) {
            return Response.from(Collections.<Double>emptyList());
        }
        List<Double> scores = new ArrayList<>(Collections.nCopies(segments.size(), 0.0));
        String answer = chatModel.chat(buildPrompt(segments, query));
        for (String line : answer.split("\\R")) {
            Matcher matcher = SCORE_LINE.matcher(line);
            if (!matcher.find()) {
                continue;
            }
            int index = Integer.parseInt(matcher.group(1)) - 1;
            if (index >= 0 && index < scores.size()) {
                scores.set(index, Double.parseDouble(matcher.group(2)));
            }
        }
        return Response.from(scores);
    }

    private static String buildPrompt(List<TextSegment> segments, String query) {
        StringBuilder prompt = new StringBuilder();
        prompt.append("你在给检索结果打分，判断每段资料能否回答用户的问题。\n");
        prompt.append("用户问题：").append(query).append("\n\n");
        for (int i = 0; i < segments.size(); i++) {
            prompt.append("[").append(i + 1).append("] ").append(segments.get(i).text()).append("\n\n");
        }
        prompt.append("只输出 ").append(segments.size()).append(" 行，每行写成 序号:分数。\n");
        prompt.append("分数取 0 到 10 的整数：0 表示完全无关，10 表示直接回答了问题。\n");
        prompt.append("不要输出任何解释，不要重复原文。");
        return prompt.toString();
    }
}
```

`scoreAll` 是整个接口里唯一必须实现的方法，一次调用给全部文档打分——不是循环调 N 次。这一点很重要，N 次调用意味着 N 倍延迟和 N 倍费用。

解析用正则容错：模型偶尔会写成 `1：8`（中文冒号）或者 `1: 8`（多一个空格），正则两种都吃。解析不出来的行跳过，对应文档得 0 分，降级而不是抛异常——重排序挂了不该让整个问答挂掉。

### 3.5 融合与串联

```java
package com.example.rag;

import dev.langchain4j.data.segment.TextSegment;
import dev.langchain4j.model.scoring.ScoringModel;
import dev.langchain4j.rag.content.Content;
import dev.langchain4j.rag.content.aggregator.ReciprocalRankFuser;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

public class HybridSearcher {

    private final VectorRetriever vectorRetriever;
    private final Bm25Retriever bm25Retriever;
    private final ScoringModel scoringModel;

    public HybridSearcher(VectorRetriever vectorRetriever, Bm25Retriever bm25Retriever, ScoringModel scoringModel) {
        this.vectorRetriever = vectorRetriever;
        this.bm25Retriever = bm25Retriever;
        this.scoringModel = scoringModel;
    }

    public List<Content> search(String query, int candidateK, int finalK) {
        List<Content> vectorHits = vectorRetriever.retrieve(query, candidateK);
        List<Content> keywordHits = bm25Retriever.retrieve(query, candidateK);
        List<Content> fused = ReciprocalRankFuser.fuse(List.of(vectorHits, keywordHits));
        List<Content> candidates = fused.stream().limit(candidateK).toList();
        if (candidates.isEmpty()) {
            return List.of();
        }
        List<TextSegment> segments = candidates.stream().map(Content::textSegment).toList();
        List<Double> scores = scoringModel.scoreAll(segments, query).content();

        List<Ranked> ranked = new ArrayList<>();
        for (int i = 0; i < candidates.size(); i++) {
            double score = i < scores.size() ? scores.get(i) : 0.0;
            ranked.add(new Ranked(candidates.get(i), score));
        }
        ranked.sort(Comparator.comparingDouble(Ranked::score).reversed());
        return ranked.stream()
                .limit(finalK)
                .map(Ranked::content)
                .toList();
    }

    private record Ranked(Content content, double score) {
    }
}
```

`ReciprocalRankFuser.fuse()` 是 LangChain4j 自带的实现，默认 k 取 60。两路各取 8 条，融合后去重，再截到 8 条进重排序——**候选数要大于最终返回数**，否则重排序没有腾挪空间。

### 3.6 跑起来

```java
package com.example.rag;

import dev.langchain4j.data.segment.TextSegment;
import dev.langchain4j.model.chat.ChatModel;
import dev.langchain4j.model.embedding.EmbeddingModel;
import dev.langchain4j.model.openai.OpenAiChatModel;
import dev.langchain4j.model.openai.OpenAiEmbeddingModel;
import dev.langchain4j.model.scoring.ScoringModel;
import dev.langchain4j.rag.content.Content;

import java.util.List;

public class Main {

    public static void main(String[] args) {
        String apiKey = System.getenv("OPENAI_API_KEY");
        if (apiKey == null || apiKey.isBlank()) {
            throw new IllegalStateException("先设置环境变量 OPENAI_API_KEY");
        }
        String baseUrl = System.getenv().getOrDefault("OPENAI_BASE_URL", "https://api.openai.com/v1");
        String chatModelName = System.getenv().getOrDefault("CHAT_MODEL", "gpt-4o-mini");
        String embeddingModelName = System.getenv().getOrDefault("EMBEDDING_MODEL", "text-embedding-3-small");

        ChatModel chatModel = OpenAiChatModel.builder()
                .baseUrl(baseUrl)
                .apiKey(apiKey)
                .modelName(chatModelName)
                .temperature(0.0)
                .build();

        EmbeddingModel embeddingModel = OpenAiEmbeddingModel.builder()
                .baseUrl(baseUrl)
                .apiKey(apiKey)
                .modelName(embeddingModelName)
                .build();

        List<TextSegment> corpus = Corpus.load();
        VectorRetriever vectorRetriever = new VectorRetriever(embeddingModel, corpus);
        Bm25Retriever bm25Retriever = new Bm25Retriever(corpus);
        ScoringModel scoringModel = new LlmScoringModel(chatModel);

        String question = "ERR_CONN_4021 是什么错误？服务一直在重试，要不要紧？";

        System.out.println("=== 只用向量检索 ===");
        print(vectorRetriever.retrieve(question, 3));

        System.out.println("\n=== 只用关键词检索 ===");
        print(bm25Retriever.retrieve(question, 3));

        HybridSearcher searcher = new HybridSearcher(vectorRetriever, bm25Retriever, scoringModel);
        List<Content> finalHits = searcher.search(question, 8, 3);

        System.out.println("\n=== 混合检索 + 重排序 ===");
        print(finalHits);

        System.out.println("\n=== 最终回答 ===");
        System.out.println(answer(chatModel, question, finalHits));
    }

    private static String answer(ChatModel chatModel, String question, List<Content> hits) {
        StringBuilder prompt = new StringBuilder();
        prompt.append("只根据下面的资料回答问题。资料里没有的内容，直接说不知道。\n\n");
        for (int i = 0; i < hits.size(); i++) {
            prompt.append("资料").append(i + 1).append("：")
                    .append(hits.get(i).textSegment().text()).append("\n\n");
        }
        prompt.append("问题：").append(question);
        return chatModel.chat(prompt.toString());
    }

    private static void print(List<Content> hits) {
        for (int i = 0; i < hits.size(); i++) {
            String text = hits.get(i).textSegment().text();
            String preview = text.length() > 40 ? text.substring(0, 40) + "..." : text;
            System.out.println((i + 1) + ". " + preview);
        }
    }
}
```

用 DashScope 的兼容模式跑，换两个环境变量就行：

```bash
export OPENAI_BASE_URL="https://dashscope.aliyuncs.com/compatible-mode/v1"
export OPENAI_API_KEY="你的key"
export CHAT_MODEL="qwen-plus"
export EMBEDDING_MODEL="text-embedding-v3"
mvn -q compile exec:java
```

跑完你会看到三段输出。第一段（纯向量）里，排前面的通常是"连接超时和读超时要分开看""重试策略建议"这类语义邻居，4021 的那两篇不一定进前三。第二段（纯 BM25）反过来，前两条直接就是错误码文档，但语义型的问法它会漏。第三段（混合 + 重排序）把两边都收进来，再让模型判断哪条真正回答了"4021 是什么"——错误码文档被顶到第一。

具体顺序会随 embedding 模型和文档措辞浮动，但趋势是稳定的：**单路都有明显短板，融合之后短板被补上。**

## 四、踩坑经验和最佳实践

**候选数给太小，融合等于没做。** 见过有人两路各取 3 条来融合，结果两路高度重叠，融合前后一模一样。每路至少 20 条，融合后取 10 到 20 条进重排序。这不是浪费，重排序就是用来从噪音里挑信号的。

**重排序候选别超过 30 条。** 一次请求要把所有候选塞进上下文，20 条 300 字的文档就是 6000 字，成本和延迟都上去了。超过这个量，先反思召回阶段是不是太松。

**文档要切碎，不切没法重排。** 一篇 3000 字的文档，重排序模型很难判断"这段到底相不相关"，因为它里面啥都有一点。切成 300 到 500 字一段，每段主题单一，打分才有区分度。切分时保留一点重叠（50 字左右），避免答案被切在边界上。

**大模型打分要 temperature 0。** 同一批文档打两次分，顺序变了，你的检索结果就抖了。重排序是判断题不是创作题，不需要任何随机性。另外必现的一个坑：模型不按格式输出，加一句"不要输出解释"能挡掉八成。

**停用词和数字要区别对待。** `4021` 这种纯数字，BM25 会给它很高的 IDF（因为稀有），这是好事。但订单号、时间戳这类数字如果被切碎，会产生大量无意义的匹配。真实项目里，正则提取出的实体应该单独加权，而不是指望通用分词。

**embedding 要缓存。** 十二篇文档每次启动重算一遍，开发时无所谓，生产环境是灾难。文档入库时算一次存起来，查询时只算查询那一条。增量更新时按文档 ID 删旧向量、插新向量，别全量重建。

**RRF 的 k 值别乱调。** 默认 60 是论文里的经验值，覆盖面广。有人喜欢调到 10，想让头部更突出，结果单路的第一名把另一路的优质结果全压下去了。除非你有明确的评测集，否则别动。

**别把重排序当成万能药。** 如果召回阶段压根没把正确文档捞进来，重排序再准也变不出来。先保证召回率，再谈精排。判断方法很土：拿 50 个真实问题，人工标出正确答案，看它进没进候选池。进不去，问题在召回；进去了但没排前面，问题在排序。

## 五、性能对比和技术选型

先把四种方案摆一起。延迟是量级估算，具体数字取决于模型和部署方式，但比例关系是可靠的。

| 方案 | 精确词匹配 | 同义改写 | 延迟量级 | 成本 | 适合场景 |
|---|---|---|---|---|---|
| 纯向量 | 弱 | 强 | 几十毫秒 | 每次查询一次 embedding | 口语化问答、语义搜索 |
| 纯 BM25 | 强 | 无 | 毫秒级 | 零 | 日志检索、代码搜索、错误码 |
| 向量 + BM25 + RRF | 强 | 强 | 几十毫秒 | 一次 embedding | 大多数 RAG 场景的默认选择 |
| 再加 LLM 重排序 | 强 | 强 | 加几百毫秒到 1 秒 | 多一次 LLM 调用 | 答案准确性优先、并发不高 |

我的建议很直接：

- **新项目直接上混合检索 + RRF**，成本几乎为零（BM25 是纯内存计算），效果提升立竿见影。这一步的性价比最高。
- **重排序按需加**。知识库超过几千篇、或者业务对错误零容忍（医疗、法务、金融），加。日活几万的客服机器人、延迟预算只有 500 毫秒，先别加，把召回做好更划算。
- **别自己训重排序模型**，除非你有标注数据和 GPU 预算。用通用大模型打分，效果已经够用。

补一句：如果你用的是 LangChain4j 的 `AiServices` 那条链路，里面的 `ReRankingContentAggregator` 已经把"多路召回 + 重排序"封装好了，你只要传一个 `ScoringModel` 进去。上面手写的这套更适合你想控制每一环、或者要接自研检索服务的时候。原理完全一样，只是把零件摆开看。

## 六、总结

RAG 答非所问，十次里有七次是检索的问题，不是模型的问题。而检索错得最隐蔽的一种，是"语义很近但事实不对"——向量检索天生就会犯这个错，因为它的工作方式就是把字面差异磨掉。

补法不复杂，四步：

1. 加一路 BM25，专治错误码、型号、人名这类精确匹配
2. 中文没分词器就用 bigram，够用且零依赖
3. 用 RRF 按排名融合，绕开分数量纲不可比的问题
4. 对融合后的 20 条候选做一次重排序，取前 3 喂给模型

整套东西的核心代码不到两百行，不需要额外服务，不需要 GPU。真正的成本是重排序那一次 LLM 调用——而它换来的是"能答对"和"答得像"之间的差别。

先别急着换更大的模型。去看看你的检索返回了什么。

文 / 会编程的吕洞宾

## 参考资料

- [LangChain4j 官方文档：RAG](https://docs.langchain4j.dev/tutorials/rag/)
- [LangChain4j API：ScoringModel](https://javadoc.io/doc/dev.langchain4j/langchain4j-core/latest/dev/langchain4j/model/scoring/ScoringModel.html)
- [Reciprocal Rank Fusion outperforms Condorcet and individual Rank Learning Methods](https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf)
- [The Probabilistic Relevance Framework: BM25 and Beyond](https://www.staff.city.ac.uk/~sbrp622/papers/foundations_bm25_review.pdf)
