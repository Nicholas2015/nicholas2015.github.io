---
title: "RAG效果差在哪，Java给知识库做量化评估"
date: 2026-10-01T20:00:00+08:00
category: "AI"
tags: ["rag"]
---

> 你花两周把 RAG 知识库上线，内测时回答挺像样。上线后用户开始反馈「答非所问」「一本正经地胡说」。你换切块大小、换 embedding、加 rerank，可改完根本不知道是变好还是变坏——手上只有几个随手试的问题，没有一把尺子。RAG 的失败其实分两层：该被检索到的资料没被找出来，或者找出来了模型没照着答。这两层必须分开量。这篇用 LangChain4j 在 Java 里搭一套能跑的评估：检索层算命中率和 MRR，生成层让大模型当裁判打忠实度分。跑完你就知道每次调参是赚是亏。

## 一、这个问题到底是什么

RAG 出问题，症状看着都一样，病因却分两层。

**第一层是检索没找对。** 用户问「怎么退款」，知识库里明明有退款政策，向量检索返回的却全是「退货」「换货」的段落。资料压根没进模型的上下文，后面回答再流畅也是错的。这叫「召回失败」。

**第二层是找对了却不照着答。** 资料已经塞进上下文，模型还是开始自由发挥，编出资料里根本没有的条款和数字。这就是幻觉。

两层要用的药不一样：召回不行，你得动切块、embedding 模型、检索条数；幻觉不行，你得改 prompt、降温度、加约束。问题在于，多数人改完没有尺子量，只能靠「感觉好像好点了」。

### 为什么必须量化

RAG 的可调参数很多：切块大小和重叠、检索返回条数 K、embedding 模型、检索前是否改写问题、检索后是否加 rerank、系统提示词怎么写。这几个参数一组合，空间大到没法靠手工试出来。没有量化，调参就是碰运气——这次好可能只是这几个测试问题刚好撞上了。

量化要回答两个问题：

- 该被找到的资料，在前 K 条里出现了吗？（检索层）
- 模型给出的回答，是不是严格贴着资料说的？（生成层）

### 这篇用到的四个指标

- **Hit@K（命中率）**：在前 K 条检索结果里，能命中目标资料的比例。
- **MRR（平均倒数排名）**：只看第一条命中的资料排在第几位，排名越靠前分越高。
- **忠实度（faithfulness）**：回答里的每个说法，能不能在资料里找到依据。
- **答案相关性（relevance）**：回答有没有真正回答到问题上。

前两个不需要大模型参与，便宜稳定，适合每次改动都跑；后两个要请大模型当裁判，贵一点也带偏见，适合关键改动和定期体检。

## 二、底层原理到底怎么回事

### 向量检索到底在干什么

embedding 模型把一句话或一个段落变成一串小数，也就是向量。语义越接近的两段文字，它们的向量方向越接近。所谓检索，就是把用户问题也变成向量，然后从库里挑出方向最接近的 K 段。

**Hit@K（命中率）** 就是：你准备了 20 道测试题，每道题都知道答案应该出自哪几段资料。对每一道题检索一次，看前 K 条里有没有那段资料。20 道里命中 16 道，命中率就是 0.8。

**MRR（平均倒数排名）** 换个角度：命中不算完，还得看排多前。命中第 1 条得 1 分，第 2 条得 0.5 分，第 3 条得 0.33 分（即 1 除以排名）。把 20 道题的分数平均，就是 MRR。

为什么要两个都看？举个例子：命中率 0.95 看着很高，但 MRR 只有 0.3，说明资料大多数情况下是找到了，可往往排在第 3、第 4 条。而排序靠前的那几条只要沾点边，就很容易把模型的注意力带跑。这种情况下你要解决的不是「找不找得到」，而是「排序质量」。

### 大模型当裁判，靠不靠谱

生成层的忠实度和相关性没法用关键词比对——模型换个说法，意思一样，字面却完全不同。行业里的通行做法是让一个能力更强的模型当裁判，也就是 LLM-as-Judge。

做法是给裁判模型一份写死的评分标准（rubric），然后让它逐句检查回答：

- 回答里每个事实，能不能在资料里找到出处？找不到就算幻觉，扣分。
- 回答正面回应了问题吗？打太极、答非所问，扣分。

最后让它返回一个 0 到 1 的分数和一句扣分理由。因为返回格式固定，可以直接解析成 Java 对象。

**裁判本身也有偏见，这点必须知道：**

- 偏爱长回答。字多看起来像认真，分数会给高。
- 偏爱和自己文风像的答案。所以别用同一个模型评自己。
- 分数会抖。同一段回答评两次可能差 0.1。

对策很实在：把温度设为 0 让输出稳定，rubric 写死不留解释空间，裁判模型和被测模型尽量别同一家，再抽几条人工对一遍校准。

**一个重要心态：裁判分数不要当绝对值看。** 它有价值的地方是相对变化——同一套题，改动前后各跑一遍，分数涨了还是跌了。指望它给出「0.82 分说明优秀」这种绝对结论，是不现实的。

## 三、实战：手把手写代码

整套东西就一个 Maven 模块。依赖只有两个：LangChain4j 核心和 OpenAI 集成。

### 依赖配置

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
    <artifactId>rag-eval-demo</artifactId>
    <version>1.0.0</version>

    <properties>
        <java.version>21</java.version>
    </properties>

    <dependencies>
        <dependency>
            <groupId>dev.langchain4j</groupId>
            <artifactId>langchain4j</artifactId>
            <version>1.20.2</version>
        </dependency>
        <dependency>
            <groupId>dev.langchain4j</groupId>
            <artifactId>langchain4j-open-ai</artifactId>
            <version>1.20.2</version>
        </dependency>
    </dependencies>
</project>
```

这里用 Spring Boot 的 parent 只是为了省事——它帮你把 Java 编译版本和一堆插件版本管好了，真正干活的还是 LangChain4j。

### 被测系统：一个最小 RAG 助手

先定义助手的接口。注解写清楚它的身份和输入输出，LangChain4j 会自动帮你拼 prompt、调模型、解析返回。

```java
package com.example.rageval;

import dev.langchain4j.service.SystemMessage;
import dev.langchain4j.service.UserMessage;
import dev.langchain4j.service.V;

public interface RagAssistant {

    @SystemMessage("""
            你是客服助手。只能依据用户给的「资料」回答。
            资料里没有的内容，直接回答「资料里没有」，不要凭常识编造。
            """)
    @UserMessage("""
            资料：
            {{context}}

            问题：{{question}}
            """)
    String answer(@V("context") String context, @V("question") String question);
}
```

${context} 这种写法叫模板变量，方法与参数一一对应。系统提示词里那句「资料里没有就直说」，是压幻觉的第一道闸门。

### 检索层评分器

这个类只做一件事：拿测试题去检索，算命中率和 MRR。全程不调大模型，跑起来又快又免费。

```java
package com.example.rageval;

import dev.langchain4j.data.embedding.Embedding;
import dev.langchain4j.data.segment.TextSegment;
import dev.langchain4j.model.embedding.EmbeddingModel;
import dev.langchain4j.store.embedding.EmbeddingMatch;
import dev.langchain4j.store.embedding.EmbeddingSearchRequest;
import dev.langchain4j.store.embedding.EmbeddingStore;

import java.util.List;

public class RetrievalEvaluator {

    public record EvalCase(String question, String expectedKeyword) {
    }

    private final EmbeddingModel embeddingModel;
    private final EmbeddingStore<TextSegment> store;

    public RetrievalEvaluator(EmbeddingModel embeddingModel, EmbeddingStore<TextSegment> store) {
        this.embeddingModel = embeddingModel;
        this.store = store;
    }

    private int hitRank(EvalCase c, int k) {
        Embedding queryEmbedding = embeddingModel.embed(c.question()).content();
        List<EmbeddingMatch<TextSegment>> matches = store.search(
                EmbeddingSearchRequest.builder()
                        .queryEmbedding(queryEmbedding)
                        .maxResults(k)
                        .build()
        ).matches();

        for (int i = 0; i < matches.size(); i++) {
            if (matches.get(i).embedded().text().contains(c.expectedKeyword())) {
                return i + 1;
            }
        }
        return 0;
    }

    public void evaluate(List<EvalCase> cases, int k) {
        int hitCount = 0;
        double reciprocalRankSum = 0.0;

        for (EvalCase c : cases) {
            int rank = hitRank(c, k);
            if (rank > 0) {
                hitCount++;
                reciprocalRankSum += 1.0 / rank;
            }
        }

        double hitAtK = (double) hitCount / cases.size();
        double mrr = reciprocalRankSum / cases.size();
        System.out.printf("Hit@%d = %.2f%n", k, hitAtK);
        System.out.printf("MRR    = %.3f%n", mrr);
    }
}
```

两个关键点。第一，EvalCase 里只放「问题 + 必须出现的关键词」，判断是否命中就看检索回来的段落文本里含不含这个词。第二，命中位置从 1 开始算，所以 rank 直接就是排名，1.0 / rank 就是倒数排名。

### 生成层评分器

这个类请大模型当裁判，返回一个 Java 对象。注意返回类型写的是 record，LangChain4j 会自动让模型按 JSON 结构输出并反序列化。

```java
package com.example.rageval;

import dev.langchain4j.model.chat.ChatModel;
import dev.langchain4j.service.AiServices;
import dev.langchain4j.service.SystemMessage;
import dev.langchain4j.service.UserMessage;
import dev.langchain4j.service.V;

public class AnswerJudge {

    public record Score(double faithfulness, double relevance, String comment) {
    }

    interface Judge {

        @SystemMessage("""
                你是一个严格的评审。只根据给定的「参考资料」判断「回答」是否可信。
                打分范围 0.0 到 1.0：
                - faithfulness：回答里每个事实是否都能在参考资料中找到依据，只要有一处编造就扣分。
                - relevance：回答是否真正回答了问题，答非所问或打太极就扣分。
                不要因为回答长就给高分。
                comment 用一句中文说明扣分原因。
                """)
        @UserMessage("""
                问题：
                {{question}}

                参考资料：
                {{context}}

                回答：
                {{answer}}
                """)
        Score judge(@V("question") String question,
                    @V("context") String context,
                    @V("answer") String answer);
    }

    private final Judge judge;

    public AnswerJudge(ChatModel chatModel) {
        this.judge = AiServices.builder(Judge.class)
                .chatModel(chatModel)
                .build();
    }

    public Score score(String question, String context, String answer) {
        return judge.judge(question, context, answer);
    }
}
```

rubric 里那句「不要因为回答长就给高分」，就是在对冲裁判偏爱长文本的毛病。这种针对性约束比泛泛写「请严格评分」有用得多。

### 串起来跑

主类负责灌数据、造测试集、跑两轮评估。

```java
package com.example.rageval;

import dev.langchain4j.data.document.Document;
import dev.langchain4j.data.document.loader.FileSystemDocumentLoader;
import dev.langchain4j.data.document.splitter.DocumentSplitters;
import dev.langchain4j.data.segment.TextSegment;
import dev.langchain4j.model.chat.ChatModel;
import dev.langchain4j.model.embedding.EmbeddingModel;
import dev.langchain4j.model.openai.OpenAiChatModel;
import dev.langchain4j.model.openai.OpenAiEmbeddingModel;
import dev.langchain4j.service.AiServices;
import dev.langchain4j.store.embedding.EmbeddingMatch;
import dev.langchain4j.store.embedding.EmbeddingSearchRequest;
import dev.langchain4j.store.embedding.EmbeddingStore;
import dev.langchain4j.store.embedding.EmbeddingStoreIngestor;
import dev.langchain4j.store.embedding.inmemory.InMemoryEmbeddingStore;

import java.nio.file.Path;
import java.util.List;
import java.util.stream.Collectors;

public class RagEvalApp {

    private static final int K = 3;

    public static void main(String[] args) {
        String apiKey = System.getenv("OPENAI_API_KEY");

        EmbeddingModel embeddingModel = OpenAiEmbeddingModel.builder()
                .apiKey(apiKey)
                .modelName("text-embedding-3-small")
                .build();

        EmbeddingStore<TextSegment> store = new InMemoryEmbeddingStore<>();

        // 1. 灌数据：读文档 -> 切块 -> 向量化 -> 入库
        List<Document> documents = List.of(
                FileSystemDocumentLoader.loadDocument(Path.of("knowledge/faq.txt"))
        );
        EmbeddingStoreIngestor.builder()
                .embeddingModel(embeddingModel)
                .embeddingStore(store)
                .documentSplitter(DocumentSplitters.recursive(300, 30))
                .build()
                .ingestDocuments(documents);

        // 2. 测试集：问题 + 必须被检索到的关键词
        List<RetrievalEvaluator.EvalCase> cases = List.of(
                new RetrievalEvaluator.EvalCase("怎么申请退款？", "退款"),
                new RetrievalEvaluator.EvalCase("发票怎么开？", "发票"),
                new RetrievalEvaluator.EvalCase("会员多久到期？", "会员")
        );

        // 3. 检索层评分：命中率 + MRR，不花钱
        new RetrievalEvaluator(embeddingModel, store).evaluate(cases, K);

        // 4. 生成层评分：先让助手回答，再让裁判打分
        ChatModel chatModel = OpenAiChatModel.builder()
                .apiKey(apiKey)
                .modelName("gpt-4o-mini")
                .temperature(0.0)
                .build();

        RagAssistant assistant = AiServices.builder(RagAssistant.class)
                .chatModel(chatModel)
                .build();

        AnswerJudge judge = new AnswerJudge(chatModel);

        for (RetrievalEvaluator.EvalCase c : cases) {
            String context = retrieveContext(embeddingModel, store, c.question());
            String answer = assistant.answer(context, c.question());
            AnswerJudge.Score score = judge.score(c.question(), context, answer);

            System.out.printf("问题：%s%n回答：%s%n忠实度=%.2f 相关性=%.2f 点评=%s%n%n",
                    c.question(), answer, score.faithfulness(), score.relevance(), score.comment());
        }
    }

    private static String retrieveContext(EmbeddingModel embeddingModel,
                                          EmbeddingStore<TextSegment> store,
                                          String question) {
        List<EmbeddingMatch<TextSegment>> matches = store.search(
                EmbeddingSearchRequest.builder()
                        .queryEmbedding(embeddingModel.embed(question).content())
                        .maxResults(K)
                        .build()
        ).matches();

        return matches.stream()
                .map(match -> match.embedded().text())
                .collect(Collectors.joining("\n---\n"));
    }
}
```

准备一个 `knowledge/faq.txt`，把常见的退款、发票、会员条款写进去，就能直接 `mvn compile exec:java` 跑起来。输出长这样：

```text
Hit@3 = 0.67
MRR    = 0.556
问题：怎么申请退款？
回答：在订单页面点「申请退款」，7 天内到账。
忠实度=1.00 相关性=1.00 点评=无扣分
```

命中率只有 0.67，说明有一道题的资料前三名都没进来。这时候你就该去看是哪道题、为什么没进来，而不是盲目换 embedding 模型。

## 四、踩坑经验和最佳实践

**测试集决定评估的可信度。** 评估集一定要来自真实用户问题，不能自己编。真实问题往往口语化、信息不全、带错别字，这些才是检索真正会翻车的地方。20 到 50 道题起步，覆盖高频场景。

**关键词匹配很粗糙，但要够用就行。** 用关键词判断命中，好处是零成本、零歧义。坏处是同义词漏判——资料里写「退还货款」，你搜「退款」就匹配不上。实用做法是一个用例配多个关键词，任一命中即算命中；或者换成「标准答案的向量相似度」判定。别为了追求完美，把评估器本身搞成一个新项目。

**别只看 Hit@K。** K 调大，Hit@K 一定上升——前 10 条里总能蒙到。但 MRR 会告诉你排序其实很烂。两个指标一起看，才不会自我欺骗。

**分数看相对变化，不看绝对值。** 同一套题、同一个裁判，改动前后各跑一遍，涨了就是涨了。今天 0.82、明天 0.79 这种波动，多半只是模型抖动。

**被测模型温度必须设 0。** 温度不设 0，同一个问题两次回答都不一样，评分自然抖，你根本分不清是参数改了还是随机性。

**分层跑，省钱。** 检索层评估不花钱，改一次切块就重跑一次；生成层要花钱，只在检索层达标、或者改了 prompt 之后再跑。

**专门盯最差的那几条。** 平均分 0.85 听着不错，但可能有 3 道题是 0.3 分，问题全藏在长尾。评估的价值就在于把这些个案揪出来。

## 五、性能对比和技术选型

几种评估手段的取舍：

| 方法 | 成本 | 能抓幻觉吗 | 稳定性 | 何时用 |
| --- | --- | --- | --- | --- |
| 人工标注 | 高 | 能 | 高 | 上线前抽查、校准 |
| 关键词/规则匹配 | 极低 | 不能 | 高 | 检索层每次回归 |
| 向量相似度对比 | 低 | 弱 | 中 | 快速粗筛 |
| 大模型当裁判 | 中 | 能 | 中 | 关键改动 + 定期体检 |

选型建议很直接：

- **检索层**：关键词命中率 + MRR，每次改动都跑，这是性价比最高的一环。
- **生成层**：大模型裁判，配上固定 rubric 和温度 0，重要改动和每周体检跑。
- **人工**：只在两处投入——上线前从评估集里抽 10% 人工对一遍，确认裁判模型和你的判断一致；以及每次裁判给出异常低分时，人工复核是不是误判。

别一上来就搞复杂框架。一套几十行的 Java 评估器，只要能稳定跑、能对比，就已经比「凭感觉」强太多。

## 六、总结

RAG 优化最大的误区，是把它当成一个纯手工调参的活。事实是，没有量化的调参只是碰运气。

这次搭的这套东西，核心就三层：

- 检索层用命中率和 MRR 衡量「资料有没有被找到、排得够不够前」；
- 生成层用大模型当裁判衡量「回答有没有贴着资料说」；
- 一切看相对变化，改动前后对比，而不是纠结绝对分数。

真正花时间的从来不是写这几行评估代码，而是攒一套好的测试题，然后坚持每次改动都跑一遍。有了这把尺子，你才知道自己每一次调整到底是在前进还是在原地打转。

## 参考资料

1. 【Retrieval-Augmented Generation (RAG)】 https://docs.langchain4j.dev/tutorials/rag
2. 【AI Services】 https://docs.langchain4j.dev/tutorials/ai-services
3. 【Embedding Stores】 https://docs.langchain4j.dev/tutorials/embedding-stores
4. 【RAGAS: Automated Evaluation of Retrieval Augmented Generation】 https://arxiv.org/abs/2309.15217
5. 【Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks】 https://arxiv.org/abs/2005.11401
6. 【LangChain4j 1.20.2 Release】 https://github.com/langchain4j/langchain4j/releases/tag/1.20.2

文 / 会编程的吕洞宾
