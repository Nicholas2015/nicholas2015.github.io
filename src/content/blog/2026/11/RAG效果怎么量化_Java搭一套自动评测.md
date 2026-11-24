---
title: RAG效果怎么量化：Java搭一套自动评测
date: 2026-11-21 15:20:41
tags: ["AI", "RAG", "LangChain4j", "Java"]
categories: ai
---

# RAG效果怎么量化：Java搭一套自动评测

> RAG 项目做到第二个月，基本都会撞上同一堵墙：你能说出它哪里不好，但说不清这一版到底比上一版强还是弱。改切分、换 embedding、加重排，全靠"感觉好像顺了点"。上线后用户还在投诉答不准，你也拿不出证据证明改动有效。
>
> 跳出这个循环只有一条路：把"好不好"变成能跑、能比、能卡住发布流程的数字。这篇讲怎么用 Java 半天搭出这套东西——评测集怎么标、检索指标怎么算、答案怎么让模型判卷、预算怎么控住。

## 一、RAG 效果差，到底差在检索还是生成

一句话：RAG 答不好，九成不是模型笨，是"检索没找到"和"找到了模型没照说"这两件事混在一起，而大部分团队从来没分开测过。

一条 RAG 链路，真正会出问题的就三个位置：

- **检索没找到。** 用户问"发票能不能重开"，知识库里明明有这条制度，但 top-5 里一条相关的都没有。模型再强也只能瞎猜。
- **找到了，但没送到。** 命中的块被上下文长度截断，或者拼进 prompt 的顺序太靠后，模型注意力没落在上面。
- **送到了，模型没照说。** 资料里写着"7 天"，模型答"15 天"。这是生成阶段的问题，跟检索无关。

不分环节测，你拿到的只有一个笼统的"答对率"。这个数字有两个致命缺陷。

**第一，它分不清病因，所以指导不了动作。** 看到答对率掉了 5 个点，你该去调 top-k、换 embedding，还是改 prompt？没有依据，只能一个个试，试一轮两天。

**第二，它会系统性地高估你的检索能力。** 举个我自己踩过的例子：30 道人工抽检，27 道答对，看着像 90%。我把向量库清空重跑了一遍，还有 6 道是对的——因为模型靠自己的常识答出来了，资料根本没参与。也就是说真实检索命中率远低于表面数字。等你哪天换了个小模型、或者领域换成模型不熟的，这 6 道立刻崩。

所以评测必须拆成两层，用两套指标：

| 测什么 | 指标 | 谁来判断 | 特点 |
| --- | --- | --- | --- |
| 检索有没有把对的块捞出来 | hit@k、recall@k、MRR | 代码算，规则明确 | 零模型成本、结果确定、能进 CI |
| 答案有没有超纲编造 | 忠实度、编造率 | 模型判卷 | 有成本、看整体质量 |

再加一类特殊题目：**知识库里根本没有的问题**。这类题的正确行为是拒答，测的是模型敢不敢编。它不归上面任何一层，但比两者都重要，后面单独讲。

## 二、底层原理：评测集、检索指标、忠实度三件事

### 2.1 评测集不是"标准答案集"，是"可核对的断言集"

很多人第一版评测集长这样：一行问题，一行标准答案。跑完发现没法自动判分——模型答的话跟标准答案措辞完全不同，但意思是对的，字符串比对必然失败。

换个思路。**别存标准答案，存"这份答案必须说到的几条事实"。** 每条事实要小到能独立判断真假：

- 好："退款申请必须在签收后 7 天内提交"
- 好："退货运费由商家承担"
- 差："退款政策是 7 天无理由，运费商家出，生鲜类除外"（三件事粘一条，判卷模型只能打一个笼统的分，某一项错了也会被整体放过）

这种单条事实我叫它**断言（claim）**。一条问题配 2 到 5 条断言，判卷就是逐条问"答案里说了这条吗"。

同时，每条问题还要标一列 `goldChunkIds`：能回答这个问题的那几个知识块，在向量库里的 ID。这是检索指标的唯一依据。

这里有个关键细节：**标注必须精确到块，不能只标到文档。** 标到文档级，"退款政策.md 被召回了"就算对，但那份文档有 40 个块，真正有用的可能在第 37 块，模型压根没看到——指标全绿，线上全错。

代价是切分参数一改，块 ID 全变，gold 标注就废了。这事没有便宜的解法，只能把切分参数和评测集一起版本化，改切分必须重标。嫌麻烦可以退一步：文档级 ID + 段落关键词双标注，改切分时用关键词重新定位块，人工核一遍。精度差一点，但比"改一次切分就重标 100 条"现实。

### 2.2 检索指标：三个数字各管一件事

用找书打比方。书架上有 500 本书，你问"哪本讲了退货"。系统给你 5 本。

- **hit@5**：这 5 本里，有没有至少一本讲退货的？有就是 1，没有就是 0。全部题目取平均，就是命中率。它回答的是"有没有救"。
- **recall@5**：如果真正讲退货的有 3 本，你捞回了几本？捞回 2 本就 0.67。它回答的是"捞全了没有"。
- **MRR**（平均倒数排名）：正确的那本书排在第几位，就取 1 除以几。排第 1 得 1.0，排第 3 得 0.33。它回答的是"排得够不够靠前"。

三个都看，是因为它们会分别退化：

| 场景 | hit@5 | recall@5 | MRR | 说明 |
| --- | --- | --- | --- | --- |
| 正常 | 0.92 | 0.80 | 0.71 | 基本能用 |
| 只有一条对，但排第 5 | 0.92 | 0.31 | 0.25 | 命中率骗人，块挤在末尾 |
| 一半题完全找不到 | 0.50 | 0.45 | 0.40 | 检索真的坏了 |

第二行最阴险。hit@5 好看，你觉得没问题，实际上正确块每次都吊在最后一位，前面四条全是噪声，模型的注意力被稀释，答对率自然上不去。

top-k 取多少？我一般取 5。取 20 一定更好看——k 越大 hit 必然越高，但生成端塞不进 20 个块，塞进去也是又贵又慢，注意力还散。**评测的 k 必须等于线上真实的 k**，否则测的是另一个系统。

### 2.3 忠实度：为什么只能让模型判卷，而且要拆成断言

先排除几个常见错误答案。

**算语义相似度？** 答"7 天内可退"和资料里"签收后七日内申请"，相似度很高，是对的；答"15 天内可退"相似度也不低，是错的。相似度分不出这两个。

**算 BLEU / ROUGE？** 那是机器翻译时代的指标，比的是 n-gram 重叠。模型换个说法就低分，抄一遍原文就高分——跟"忠不忠于资料"没半毛钱关系。

**人肉看？** 最准，但一轮 100 题要半天，改一次代码看一次，没人受得了，最后必然荒废。

剩下的路就是让模型判卷。思路跟老师批开卷题一样：把资料、问题、答案、断言一起给它，逐条问"答案里有没有明确说出这条"。

三个必须遵守的细节，否则判卷会放水：

1. **判卷模型不能是被测模型。** 同一个模型评自己的答案，倾向于给自己找补。换一个家族，或者干脆用更强的模型。
2. **一次只判一条断言。** 把五条断言塞一次让它给个总分，它会给个"大概对"的印象分。逐条判，错的能被揪出来。
3. **要求它输出结构化结果，并且给理由。** 只要布尔值，模型容易蒙；要求写一句 reason，它就得真去比对，顺手也方便你排查误判。

### 2.4 随机性、采样和成本

温度设成 0 也不保证每次一样。服务端有批处理、有负载均衡，同一份输入两次结果可能不同。检索侧同理：embedding 模型升级一个补丁版本，向量就变了。

所以关键结论别跑一次就定。**边界样本跑 3 次看方差**——如果 hit@5 在 0.85 到 0.91 之间跳，那 0.88 这个数字本身没有意义，别拿它做发布依据。

成本也要提前算清。一轮全量评测，每道题的开销是：

- 1 次 query embedding（几分钱里的一小部分）
- 1 次答案生成
- 1 次判卷（一次判完所有断言）

100 道题按公开价目表算，量级在几元以内。真正贵的是你一天跑五十轮。所以实践里的节奏是：**检索指标每次都跑（几乎免费），生成指标只跑抽样，判卷结果按"问题 + 答案哈希"缓存。** 答案没变就不重判。

## 三、实战：Java 手写一套能进 CI 的 RAG 评测

### 3.1 项目骨架和依赖

一个普通 Maven 项目，不需要 Spring 容器。LangChain4j 负责切块、embedding、调模型；Jackson 读评测集。

```xml
<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
    <modelVersion>4.0.0</modelVersion>

    <parent>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-parent</artifactId>
        <version>4.2.0</version>
        <relativePath/>
    </parent>

    <groupId>com.example</groupId>
    <artifactId>rag-eval</artifactId>
    <version>1.0.0</version>

    <properties>
        <java.version>21</java.version>
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
            <groupId>com.fasterxml.jackson.core</groupId>
            <artifactId>jackson-databind</artifactId>
            <version>2.23.0</version>
        </dependency>
    </dependencies>
</project>
```

目录结构：

```
rag-eval/
├── pom.xml
├── eval/
│   ├── corpus/            被评测的知识库，一个 md 一个主题
│   │   ├── refund.md
│   │   └── shipping.md
│   └── cases.jsonl        评测集，一行一道题
└── src/main/java/com/example/rageval/
    ├── EvalCase.java
    ├── EvalSetLoader.java
    ├── RetrievalMetrics.java
    ├── Answerer.java
    ├── FaithfulnessJudge.java
    └── RagEvaluator.java
```

### 3.2 评测集长什么样

JSONL，一行一条，方便手写也方便 diff。

```json
{"id":"q1","question":"签收后第 9 天还能申请退款吗","goldChunkIds":["refund#0"],"claims":["退款申请必须在签收后 7 天内提交","超过 7 天的申请不予受理"],"shouldRefuse":false}
{"id":"q2","question":"退货运费谁出","goldChunkIds":["refund#1"],"claims":["质量问题导致的退货运费由商家承担"],"shouldRefuse":false}
{"id":"q3","question":"你们支持比特币支付吗","goldChunkIds":[],"claims":[],"shouldRefuse":true}
```

第三个 `q3` 就是专门用来测编造的。知识库没这条，正确行为是拒答。`goldChunkIds` 空数组表示它不参与检索打分。

对应的 Java 记录类：

```java
package com.example.rageval;

import java.util.List;

public record EvalCase(
        String id,
        String question,
        List<String> goldChunkIds,
        List<String> claims,
        boolean shouldRefuse) {
}
```

读文件这部分没什么花样，跳过空行和 `//` 注释即可：

```java
package com.example.rageval;

import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

public final class EvalSetLoader {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private EvalSetLoader() {
    }

    public static List<EvalCase> load(Path path) throws IOException {
        List<EvalCase> cases = new ArrayList<>();
        for (String line : Files.readAllLines(path)) {
            String trimmed = line.trim();
            if (trimmed.isEmpty() || trimmed.startsWith("//")) {
                continue;
            }
            cases.add(MAPPER.readValue(trimmed, EvalCase.class));
        }
        if (cases.isEmpty()) {
            throw new IllegalStateException("评测集是空的：" + path);
        }
        return cases;
    }
}
```

标 `goldChunkIds` 时你并不知道块 ID 是什么。第一版可以这样：跑一次入库，把每个块的 `chunkId` 和前 30 个字打印出来，照着手工填。填完再删掉打印，一劳永逸。

### 3.3 检索指标：纯代码，零模型成本

这段是整个评测里最值钱的部分，因为它确定、免费、能卡 CI。

```java
package com.example.rageval;

import java.util.List;

public final class RetrievalMetrics {

    public record QueryOutcome(String caseId, List<String> retrievedChunkIds, List<String> goldChunkIds) {
    }

    public record Summary(double hitRate, double recall, double mrr, int questions) {
    }

    private RetrievalMetrics() {
    }

    public static Summary summarize(List<QueryOutcome> outcomes) {
        // 拒答题没有标准块，不参与检索打分
        List<QueryOutcome> scored = outcomes.stream()
                .filter(o -> !o.goldChunkIds().isEmpty())
                .toList();
        if (scored.isEmpty()) {
            return new Summary(0.0, 0.0, 0.0, 0);
        }
        double hit = 0.0;
        double recall = 0.0;
        double mrr = 0.0;
        for (QueryOutcome o : scored) {
            hit += hitAtK(o);
            recall += recallAtK(o);
            mrr += reciprocalRank(o);
        }
        int n = scored.size();
        return new Summary(hit / n, recall / n, mrr / n, n);
    }

    // top-k 里有没有一个是对的
    private static double hitAtK(QueryOutcome o) {
        return o.retrievedChunkIds().stream().anyMatch(o.goldChunkIds()::contains) ? 1.0 : 0.0;
    }

    // 该捞的几个，捞回了几个
    private static double recallAtK(QueryOutcome o) {
        long found = o.goldChunkIds().stream()
                .filter(o.retrievedChunkIds()::contains)
                .count();
        return (double) found / o.goldChunkIds().size();
    }

    // 第一个对的排第几
    private static double reciprocalRank(QueryOutcome o) {
        List<String> retrieved = o.retrievedChunkIds();
        for (int i = 0; i < retrieved.size(); i++) {
            if (o.goldChunkIds().contains(retrieved.get(i))) {
                return 1.0 / (i + 1);
            }
        }
        return 0.0;
    }
}
```

`reciprocalRank` 就是 MRR 的单题版本：排第 1 给 1.0，排第 4 给 0.25，一条都没命中给 0。三个方法都是纯函数，没有任何外部依赖，可以随手写单元测试锁死行为。

### 3.4 让模型判卷

两个 AI Service 接口。先看答题的那个，这就是你线上 RAG 的简化版：

```java
package com.example.rageval;

import dev.langchain4j.service.SystemMessage;
import dev.langchain4j.service.UserMessage;
import dev.langchain4j.service.V;

public interface Answerer {

    @SystemMessage("""
            你是客服助手。只允许使用【资料】里的内容回答，禁止用你自己的常识补充。
            资料里找不到答案时，只回一句：资料中没有相关信息。
            回答不超过 120 字，不要复述资料原文。
            """)
    @UserMessage("""
            【资料】
            {{context}}

            【问题】
            {{question}}
            """)
    String answer(@V("context") String context, @V("question") String question);
}
```

`@V` 把方法参数填进 prompt 模板里的占位符。`AiServices` 会在背后生成代理对象，你只管调 `answerer.answer(...)`。

判卷接口的返回值用了 record，LangChain4j 会自动把它变成 JSON Schema 塞给模型，再把模型返回的 JSON 反序列化回来。你不用手写解析。

```java
package com.example.rageval;

import dev.langchain4j.service.SystemMessage;
import dev.langchain4j.service.UserMessage;
import dev.langchain4j.service.V;

import java.util.List;

public interface FaithfulnessJudge {

    @SystemMessage("""
            你是 RAG 答案的核对员，只做一件事：判断答案里的内容有没有超出给定资料。
            规则：
            1. 逐条核对断言。答案明确说出了这条断言的内容，才算 supported=true。
            2. 答案说了但和资料矛盾，supported=false，reason 写“与资料冲突”。
            3. 答案没提到这条断言，supported=false，reason 写“答案未提及”。
            4. 如果答案整体在表达“资料中没有相关信息”，把 refused 置为 true。
            5. 不要推测答案的言外之意，只按字面判断。
            """)
    @UserMessage("""
            【资料】
            {{context}}

            【问题】
            {{question}}

            【答案】
            {{answer}}

            【待核对断言】
            {{claims}}

            逐条判断后返回结果。
            """)
    Verdict judge(@V("context") String context,
                  @V("question") String question,
                  @V("answer") String answer,
                  @V("claims") String claims);

    record Verdict(boolean refused, List<ClaimVerdict> claims) {
    }

    record ClaimVerdict(String claim, boolean supported, String reason) {
    }
}
```

`reason` 不是给模型看的，是给你看的。判卷判错了（模型很常见地会把"资料支持"和"常识支持"搞混），你翻一眼理由就知道该改 prompt 还是改断言。

### 3.5 主流程：检索、生成、判卷、卡门禁

所有东西拼起来。

```java
package com.example.rageval;

import dev.langchain4j.data.document.Document;
import dev.langchain4j.data.document.DocumentSplitter;
import dev.langchain4j.data.document.Metadata;
import dev.langchain4j.data.document.splitter.DocumentSplitters;
import dev.langchain4j.data.embedding.Embedding;
import dev.langchain4j.data.segment.TextSegment;
import dev.langchain4j.model.embedding.EmbeddingModel;
import dev.langchain4j.model.openai.OpenAiChatModel;
import dev.langchain4j.model.openai.OpenAiEmbeddingModel;
import dev.langchain4j.service.AiServices;
import dev.langchain4j.store.embedding.EmbeddingMatch;
import dev.langchain4j.store.embedding.EmbeddingSearchRequest;
import dev.langchain4j.store.embedding.EmbeddingStore;
import dev.langchain4j.store.embedding.inmemory.InMemoryEmbeddingStore;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;
import java.util.stream.IntStream;
import java.util.stream.Stream;

public class RagEvaluator {

    private static final int TOP_K = 5;
    private static final int CHUNK_SIZE = 400;
    private static final int CHUNK_OVERLAP = 60;

    public static void main(String[] args) throws IOException {
        Path corpusDir = Path.of(args.length > 0 ? args[0] : "eval/corpus");
        Path caseFile = Path.of(args.length > 1 ? args[1] : "eval/cases.jsonl");

        String apiKey = System.getenv("OPENAI_API_KEY");
        if (apiKey == null || apiKey.isBlank()) {
            throw new IllegalStateException("先导出 OPENAI_API_KEY");
        }

        EmbeddingModel embeddingModel = OpenAiEmbeddingModel.builder()
                .apiKey(apiKey)
                .modelName("text-embedding-3-small")
                .build();

        // 被测答案用便宜的小模型；判卷换个家族，避免自己给自己打分
        Answerer answerer = AiServices.builder(Answerer.class)
                .chatModel(OpenAiChatModel.builder()
                        .apiKey(apiKey)
                        .modelName("gpt-4.1-mini")
                        .temperature(0.0)
                        .build())
                .build();

        FaithfulnessJudge judge = AiServices.builder(FaithfulnessJudge.class)
                .chatModel(OpenAiChatModel.builder()
                        .apiKey(apiKey)
                        .modelName("gpt-5-mini")
                        .build())
                .build();

        EmbeddingStore<TextSegment> store = indexCorpus(corpusDir, embeddingModel);
        List<EvalCase> cases = EvalSetLoader.load(caseFile);

        List<RetrievalMetrics.QueryOutcome> outcomes = new ArrayList<>();
        int supportedClaims = 0;
        int totalClaims = 0;
        int refuseCases = 0;
        int refusedAsExpected = 0;

        for (EvalCase c : cases) {
            List<EmbeddingMatch<TextSegment>> matches = retrieve(store, embeddingModel, c.question());
            List<String> retrievedIds = matches.stream()
                    .map(m -> m.embedded().metadata().getString("chunkId"))
                    .toList();
            outcomes.add(new RetrievalMetrics.QueryOutcome(c.id(), retrievedIds, c.goldChunkIds()));

            String context = matches.stream()
                    .map(m -> "[" + m.embedded().metadata().getString("chunkId") + "]\n" + m.embedded().text())
                    .collect(Collectors.joining("\n\n"));
            String answer = answerer.answer(context, c.question());

            if (c.shouldRefuse()) {
                refuseCases++;
                boolean refused = judge
                        .judge(context, c.question(), answer, "（本题不核对断言，只判断是否拒答）")
                        .refused();
                if (refused) {
                    refusedAsExpected++;
                }
                System.out.printf("%-5s 应拒答 | refused=%s | %s%n", c.id(), refused, oneLine(answer));
                continue;
            }

            if (c.claims().isEmpty()) {
                continue;
            }

            String claimsText = IntStream.range(0, c.claims().size())
                    .mapToObj(i -> (i + 1) + ". " + c.claims().get(i))
                    .collect(Collectors.joining("\n"));

            FaithfulnessJudge.Verdict verdict = judge.judge(context, c.question(), answer, claimsText);
            long ok = verdict.claims().stream()
                    .filter(FaithfulnessJudge.ClaimVerdict::supported)
                    .count();
            supportedClaims += (int) ok;
            totalClaims += c.claims().size();

            System.out.printf("%-5s 断言 %d/%d | %s%n", c.id(), ok, c.claims().size(),
                    verdict.claims().stream()
                            .filter(v -> !v.supported())
                            .map(v -> v.claim() + " -> " + v.reason())
                            .collect(Collectors.joining("; ")));
        }

        RetrievalMetrics.Summary summary = RetrievalMetrics.summarize(outcomes);
        double faithfulness = totalClaims == 0 ? 0.0 : (double) supportedClaims / totalClaims;
        double fabricationRate = refuseCases == 0 ? 0.0 : 1.0 - (double) refusedAsExpected / refuseCases;

        System.out.println();
        System.out.println("========== 评测报告 ==========");
        System.out.printf("检索   hit@%d=%.2f  recall@%d=%.2f  mrr=%.2f  （样本 %d 题）%n",
                TOP_K, summary.hitRate(), TOP_K, summary.recall(), summary.mrr(), summary.questions());
        System.out.printf("生成   忠实度=%.2f（%d/%d 条断言成立）%n",
                faithfulness, supportedClaims, totalClaims);
        System.out.printf("拒答   按预期拒答 %d/%d，编造率=%.2f%n",
                refusedAsExpected, refuseCases, fabricationRate);

        boolean pass = summary.hitRate() >= 0.80
                && faithfulness >= 0.90
                && fabricationRate <= 0.05;
        System.out.println(pass ? "结论：PASS，可以发布" : "结论：FAIL，别发");
        if (!pass) {
            System.exit(1);
        }
    }

    private static EmbeddingStore<TextSegment> indexCorpus(Path corpusDir, EmbeddingModel embeddingModel)
            throws IOException {
        EmbeddingStore<TextSegment> store = new InMemoryEmbeddingStore<>();
        DocumentSplitter splitter = DocumentSplitters.recursive(CHUNK_SIZE, CHUNK_OVERLAP);

        try (Stream<Path> files = Files.list(corpusDir)) {
            List<Path> docs = files
                    .filter(p -> p.getFileName().toString().endsWith(".md"))
                    .sorted()
                    .toList();

            for (Path file : docs) {
                String docName = file.getFileName().toString().replace(".md", "");
                Document document = Document.from(Files.readString(file), Metadata.from(Map.of("doc", docName)));

                List<TextSegment> chunks = new ArrayList<>();
                List<TextSegment> raw = splitter.split(document);
                for (int i = 0; i < raw.size(); i++) {
                    TextSegment segment = raw.get(i);
                    Metadata metadata = segment.metadata().copy().put("chunkId", docName + "#" + i);
                    chunks.add(TextSegment.from(segment.text(), metadata));
                }

                List<Embedding> embeddings = embeddingModel.embedAll(chunks).content();
                store.addAll(embeddings, chunks);
            }
        }
        return store;
    }

    private static List<EmbeddingMatch<TextSegment>> retrieve(EmbeddingStore<TextSegment> store,
                                                              EmbeddingModel embeddingModel,
                                                              String question) {
        Embedding queryEmbedding = embeddingModel.embed(question).content();
        EmbeddingSearchRequest request = EmbeddingSearchRequest.builder()
                .queryEmbedding(queryEmbedding)
                .maxResults(TOP_K)
                .build();
        return store.search(request).matches();
    }

    private static String oneLine(String text) {
        String flat = text.replaceAll("\\s+", " ").trim();
        return flat.length() <= 60 ? flat : flat.substring(0, 60) + "…";
    }
}
```

几个值得说明的写法：

- `chunkId` 写成 `文档名#序号`，跟评测集里的 `goldChunkIds` 对齐。序号是切分器保证顺序的，重跑不变。
- `indexCorpus` 里把 `chunkId` 塞进每个块的 metadata，检索回来直接取，不需要再查表。
- `System.exit(1)` 是给 CI 用的。把这段挂在 `mvn verify` 后面，指标不达标流水线直接红，没人能"先上了再说"。
- 判卷模型不给 `temperature`。有些推理模型压根不接受这个参数，传了会报 400，不如不传。

## 四、踩坑经验：这八个地方最容易把评测做废

**1. 评测集让写代码的人自己编。** 你编的问题一定长得像你的 prompt，天然好答。指标 0.95，上线照样被骂。评测题从客服工单、搜索日志、群里真实提问里抄，一个字都别改。按业务分桶（退款 / 物流 / 发票），每桶至少 20 条，别让退款题占八成。

**2. 断言写成整段标准答案。** 前面说过，一条断言只装一个事实。判断标准很土：这句话能不能单独拿出来说"对"或"不对"。不能，就拆。

**3. 判卷模型和被测模型同源。** 都是 GPT 家族时，判卷会系统性宽容——它"理解"被测答案的意图，把没说的话也算成说了。换家族，或者判卷用更强的型号。

**4. gold 标注绑死切分参数。** 我把 chunk 从 400 改到 600，100 条评测集的 gold 全部失效，当场想砸键盘。要么接受重标，要么加一层"文档 + 段落关键词"的兜底标注。

**5. 忘了固定模型快照。** `gpt-4.1-mini` 是别名，供应商升级后端你就跟着变。评测代码里写全快照名（`gpt-4.1-mini-2025-04-14`），否则某天指标集体掉 3 个点，你查一周也查不出原因。

**6. 评测题泄漏进 prompt。** 把评测集里的问题写成 few-shot 示例，指标立刻起飞，全是假的。评测集单独放一个目录，review 时看到有人 import 它就打回去。

**7. 只看平均值，不看分布。** 整体忠实度 0.93 挺好看，但退款那一桶只有 0.61。平均值会掩盖结构性短板，报告里必须按桶输出。

**8. 一轮全量跑得太贵，最后干脆不跑。** 这是最常见的死法。解法是分层：改切分/换 embedding → 只跑检索指标（几秒钟，几乎免费）；改 prompt/换模型 → 跑 30 条生成抽样；发版前 → 全量。判卷结果按"问题 + 答案 hash"缓存，重复的一分钱不花。

## 五、三种评测方式的成本和选型建议

三种手段不是互相替代，是分工。

| 方式 | 单轮成本（100 题） | 能进 CI | 能回答什么 | 主要缺陷 |
| --- | --- | --- | --- | --- |
| 检索指标（代码计算） | 100 次 embedding，可忽略 | 能，秒级 | 检索有没有退化 | 不知道答案对不对 |
| LLM 判卷 | 100 次生成 + 100 次判卷，几元以内 | 能，几分钟 | 答案是否忠于资料、敢不敢编 | 有随机性，判卷本身会错 |
| 人工抽检 | 半天 | 不能 | 判卷标准是否跑偏 | 太慢，必然荒废 |

我的建议是这样排：

- **每次提交**跑检索指标全量。它便宜到没有理由不跑，而且能挡住 80% 的"改坏了"。
- **每天一次**跑 30 条生成抽样，覆盖各个业务桶。
- **发版前**跑全量 + 人工抽 20 条。人工那 20 条不是用来算分的，是用来校准判卷模型的——如果人工判定和模型判定差超过 2 条，先修判卷 prompt。
- **换模型、换 embedding** 属于大改，全量 + 人工，别省。

阈值不用一上来就定死。先跑三版历史版本，看你的 hit@5 正常波动区间是多少，把阈值卡在区间下沿再减 2 个点。定 0.95 这种数字只会让所有人学会绕过门禁。

## 六、总结

把 RAG 效果变成数字，就三件事：

1. **评测集存断言，不存标准答案。** 一条断言一个事实，检索侧标到 chunk 级。
2. **两套指标分开算。** 检索用 hit@k / recall@k / MRR（确定、免费、进 CI），生成用忠实度 + 编造率（模型判卷，看整体）。
3. **阈值挂进流水线。** 不过就红，别给人"先上了再说"的机会。

最反直觉的一点：这套东西的价值不在那个分数，在于**你改坏的时候当天就知道**。以前要等一周后用户投诉才发现的问题，现在提交完三分钟就红。

30 条评测集也比 0 条强，但别在 30 条上停三个月。评测集会随着你对业务的理解一起长，它本身就是资产——比任何一个 prompt 都值钱。

## 参考资料

- [RAG (Retrieval-Augmented Generation) | LangChain4j](https://docs.langchain4j.dev/tutorials/rag)
- [AI Services | LangChain4j](https://docs.langchain4j.dev/tutorials/ai-services)
- [RAGAS: Automated Evaluation of Retrieval Augmented Generation](https://arxiv.org/abs/2309.15217)
- [LangChain4j Releases](https://github.com/langchain4j/langchain4j/releases)

文 / 会编程的吕洞宾
