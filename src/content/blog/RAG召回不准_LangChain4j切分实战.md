---
title: "RAG召回不准？LangChain4j切分实战"
date: 2026-10-18T20:00:00+08:00
category: "AI"
tags: ["AI", "langchain4j", "rag"]
---

**摘要：** 文档切分是 RAG 检索的天花板。块切得太大，一个向量混进好几个主题；切得太小，指代和条件全丢；中文还会因为句级切分用的是英文模型，一路退化成按字符硬切。本文用 LangChain4j 讲清切分原理，给出中文分句切分器的完整实现，以及一套可运行的检索链路。

> 知识库上线第二周，客服来投诉：问「退款几天到账」，AI 答的是「发票怎么开」。你把 topK 从 3 调到 10，换了 embedding 模型，甚至换了向量库，答案还是飘。最后翻日志才发现，文档切分把「到账时间」和它的前提条件切成了两块，命中的那块只有半句话。这篇文章就解决这件事：LangChain4j 里怎么切、切多大、中文为什么会踩坑，以及怎么验证切分到底行不行。

## 一、这个问题到底是什么

结论：切分决定了检索的上限。块切错了，换模型、换向量库、调 topK，全是在下游打补丁。

先把一个容易被忽略的事实摆出来：向量检索的最小单位不是文档，是块（chunk）。你的知识库里有 500 篇文档，切完可能变成 2 万个块，每个块单独算一个向量。用户提问时，系统拿问题的向量去和这 2 万个向量比相似度，捞回最像的几个块，塞给大模型当参考资料。

所以模型看到的从来不是「那篇退款规则」，而是「被切开的那一段退款规则」。这一段切得好不好，直接决定答案对不对。

### 三种典型的切坏方式

**块太大。** 一个块里塞了三段内容：退款条件、到账时间、发票流程。embedding 把这三段压成一个向量，等于把三种意思取了个平均。用户问发票，这个块也能命中；问退款，还是命中它。命中之后模型只看到开头两行，答案就偏了。

**块太小。** 每 100 字切一刀。于是「超过 7 个工作日未到账的，可申请加急」被切成「超过 7 个工作日未到账的」和「可申请加急」。前一块没有主语，后一块没有条件，两块单独看都不完整。

**边界切在关键位置。** 一份操作手册，第一步和第二步被切开，检索只捞到第二步。模型拿着「点击确认按钮」这一句，根本不知道前面要先把订单状态改成已支付。

### 为什么调 topK 和 minScore 救不回来

这两个参数控制的是「捞几个」和「多像才算像」。它们改变不了块里有没有完整答案。

- topK 调大：捞回来的块多了，噪音也多了，模型更容易被无关内容带跑。
- minScore 调低：本来不该进来的块进来了。
- minScore 调高：真正包含答案的块因为表述差异被挡在门外。

一句话，块里没有完整信息，检索参数怎么调都是拆东墙补西墙。

### 一个可执行的判断标准

别凭感觉。准备 20 个真实用户问题，每个问题标好标准答案在哪一段。跑一遍检索，看 top3 里有没有那段话。命中率低于八成，先回去改切分，别急着换模型。

这个动作花不了半小时，但能省掉后面几周的瞎调。

## 二、底层原理到底怎么回事

结论：LangChain4j 的默认切分器是「层级递归」结构，从段落往下一路退到字符；中文文本在「句子」这一层会断掉，最后往往变成按字符硬切。

### 递归切分：一层层往下退

`DocumentSplitters.recursive(...)` 是官方推荐的通用切分器。它的工作方式像俄罗斯套娃，一层套一层：

1. 先按段落切。段落之间用两个以上换行符分隔。
2. 段落还是太长，按行切。
3. 行还是太长，按句子切。
4. 句子还是太长，按单词切。
5. 单词还是太长，按字符切。

每一层都尽量把「完整的小单元」装进一个块，装不下就退到下一层。这样切出来的块，边界通常落在语义单位上，而不是随便一刀。

它有两个重载：

```java
DocumentSplitter byChars  = DocumentSplitters.recursive(500, 50);
DocumentSplitter byTokens = DocumentSplitters.recursive(500, 50, tokenCountEstimator);
```

第一个按字符数算，第二个按 token 数算。参数含义一样：块的上限，以及相邻块之间允许重叠多少。

### 重叠（overlap）是怎么实现的

重叠是为了解决「边界切断」。上一块的结尾和下一块的开头重复一点，被切断的句子至少能在其中一块里完整出现。

关键在于：**重叠只按整句回退**。不是你想重叠 50 个字符就机械地截 50 个字符，而是往回找完整的句子，凑够大概 50 为止。这样重叠部分本身也是可读的。

这个设计在英文里没问题。中文就出事了，原因在下一节。

### 中文为什么会被按字符硬切

句子切分用的是 Apache OpenNLP 的英文句子模型。它认的是英文的句号、问号、感叹号加空格那一套。

中文呢？「退款将在 7 个工作日内到账。」这句话后面没有空格，模型识别不出句子边界。识别不出会怎样？整个段落被当成「一个超长句子」，交给下一层处理。

下一层是单词切分，按空格切。中文没有空格，整段又是一个「超长单词」。再往下，就是字符切分。

结果就是：**中文文档在 LangChain4j 的默认递归切分里，最终经常是按固定字符数硬切**。切口可能落在词中间、句子中间，overlap 的整句回退也退不动。

这不是框架的 bug，是句子模型的语言限制。知道了这一点，解决方案就很明确：自己按中文标点分句，再装块。

### 字符和 token 不是一回事

按字符切，好处是可预测：500 字符就是 500 字符。坏处是它和模型的计量单位对不上。

- 英文大约 4 个字符一个 token。
- 中文大约 1 到 2 个字符一个 token，具体看模型的分词表。
- 代码和 JSON 的 token 密度又是另一个样。

同样设成 500，一段中文可能是 300 token，一段代码可能是 200 token，一段英文可能只有 120 token。如果你的目的是「别超模型上下文」，按字符切基本靠猜；按 token 切才是按计量单位办事。

LangChain4j 提供了 `TokenCountEstimator` 接口，OpenAI 系模型可以直接用 `OpenAiTokenCountEstimator`，它在本地跑分词，不发网络请求。

### 内置切分器会偷偷加一个字段

每个切出来的块，除了继承文档的元数据，还会多一个 `index`，表示它是原文的第几块，从 0 开始。

这个字段别删。线上排查「为什么召回了这句没头没尾的话」时，靠它才能定位回原文位置。自己写切分器的话，这个字段要手动补上。

### 入库管道的四个环节

LangChain4j 把「文档进向量库」抽象成一条管道：

```text
Document → DocumentSplitter → TextSegmentTransformer → EmbeddingModel → EmbeddingStore
```

- `DocumentSplitter`：把长文档切成块。
- `TextSegmentTransformer`：可选，给每个块做二次加工，比如统一加上文档标题、把表格转成文字。
- `EmbeddingModel`：把每个块转成向量。
- `EmbeddingStore`：存向量和原文。

`EmbeddingStoreIngestor` 把这条管道串起来，你只要配好组件，调一次 `ingest` 就行。

## 三、实战：手把手写代码

先建一个 Maven 项目，`pom.xml` 如下。三个依赖：LangChain4j 核心、OpenAI 集成、日志实现。

```xml
<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
    <modelVersion>4.0.0</modelVersion>

    <groupId>com.example</groupId>
    <artifactId>rag-chunking-demo</artifactId>
    <version>1.0.0</version>
    <packaging>jar</packaging>

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
                <groupId>org.codehaus.mojo</groupId>
                <artifactId>exec-maven-plugin</artifactId>
                <version>3.6.4</version>
            </plugin>
        </plugins>
    </build>
</project>
```

### 示例一：先看看默认切分器把中文切成了什么样

这段代码不调用任何大模型，纯本地跑。准备一段退款规则，分别用段落切分器和递归切分器处理，打印每块的字数和首尾文字。

```java
package com.example.rag;

import dev.langchain4j.data.document.Document;
import dev.langchain4j.data.document.DocumentSplitter;
import dev.langchain4j.data.document.splitter.DocumentByParagraphSplitter;
import dev.langchain4j.data.document.splitter.DocumentSplitters;
import dev.langchain4j.data.segment.TextSegment;

import java.util.IntSummaryStatistics;
import java.util.List;

public class SplitterShowcase {

    private static final String RULE = """
            退款规则

            订单支付成功后，未发货的订单可以随时申请退款，款项将原路退回。
            已发货但未签收的订单，需要先拒收，拒收成功后系统自动发起退款。
            已签收的订单，支持 7 天无理由退款，但生鲜、定制类商品除外。

            退款到账时间

            原路退回的款项，微信支付和支付宝通常在 1 到 3 个工作日内到账。
            银行卡支付受银行处理时效影响，通常需要 3 到 7 个工作日。
            超过 7 个工作日仍未到账的，请提供订单号和付款截图，联系人工客服加急处理。

            发票说明

            退款成功后，已开具的发票需要先红冲，红冲完成才能重新开票。
            电子发票红冲一般当天完成，纸质发票需要寄回后处理，周期约 5 个工作日。
            """;

    public static void main(String[] args) {
        Document document = Document.from(RULE);

        report("按段落切", new DocumentByParagraphSplitter(120, 20), document);
        report("递归切分，120 字符", DocumentSplitters.recursive(120, 20), document);
        report("递归切分，60 字符", DocumentSplitters.recursive(60, 0), document);
    }

    private static void report(String name, DocumentSplitter splitter, Document document) {
        List<TextSegment> segments = splitter.split(document);
        IntSummaryStatistics stat = segments.stream()
                .mapToInt(segment -> segment.text().length())
                .summaryStatistics();

        System.out.printf("%n===== %s：共 %d 块，长度 min=%d，avg=%.1f，max=%d%n",
                name, segments.size(), stat.getMin(), stat.getAverage(), stat.getMax());

        for (int i = 0; i < segments.size(); i++) {
            String text = segments.get(i).text().replace("\n", " ");
            System.out.printf("  [%d] %d 字 | 开头：%s | 结尾：%s%n",
                    i, text.length(), head(text, 14), tail(text, 14));
        }
    }

    private static String head(String text, int n) {
        return text.substring(0, Math.min(n, text.length()));
    }

    private static String tail(String text, int n) {
        return text.substring(Math.max(0, text.length() - n));
    }
}
```

运行：

```bash
mvn -q compile exec:java -Dexec.mainClass=com.example.rag.SplitterShowcase
```

重点看输出的两件事。第一，块数是不是符合预期。第二，每块的结尾是不是停在句子中间。

在中文文本上，递归切分经常给出「结尾：……通常需要 3 到 7 个工」这种结果。看到这种输出，就说明它已经退到字符切分了。段落切分看起来更整齐，是因为这段文本的段落本身够短；段落一长，它同样会退化。

### 示例二：写一个按中文标点分句的切分器

思路很直接：先用中文标点把文本切成句子，再把句子一个个往块里装，装不下就换块，换块时回退几句做重叠。整句进出，绝不切在句子中间。

```java
package com.example.rag;

import dev.langchain4j.data.document.Document;
import dev.langchain4j.data.document.DocumentSplitter;
import dev.langchain4j.data.document.Metadata;
import dev.langchain4j.data.segment.TextSegment;
import dev.langchain4j.model.TokenCountEstimator;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;

public class ChineseSentenceSplitter implements DocumentSplitter {

    private static final Pattern BOUNDARY = Pattern.compile("(?<=[。！？；!?;])|\\n+");

    private final int maxTokens;
    private final int overlapTokens;
    private final TokenCountEstimator estimator;

    public ChineseSentenceSplitter(int maxTokens, int overlapTokens, TokenCountEstimator estimator) {
        if (maxTokens <= 0) {
            throw new IllegalArgumentException("maxTokens 必须大于 0");
        }
        if (overlapTokens < 0 || overlapTokens >= maxTokens) {
            throw new IllegalArgumentException("overlapTokens 必须在 [0, maxTokens) 区间内");
        }
        this.maxTokens = maxTokens;
        this.overlapTokens = overlapTokens;
        this.estimator = estimator;
    }

    @Override
    public List<TextSegment> split(Document document) {
        List<String> sentences = new ArrayList<>();
        for (String part : BOUNDARY.split(document.text())) {
            String sentence = part.strip();
            if (!sentence.isEmpty()) {
                sentences.add(sentence);
            }
        }

        List<TextSegment> segments = new ArrayList<>();
        List<String> window = new ArrayList<>();
        int windowTokens = 0;

        for (String sentence : sentences) {
            int tokens = count(sentence);

            if (tokens > maxTokens) {
                if (!window.isEmpty()) {
                    segments.add(toSegment(window, segments.size(), document));
                    window.clear();
                    windowTokens = 0;
                }
                for (String piece : hardSplit(sentence)) {
                    segments.add(toSegment(List.of(piece), segments.size(), document));
                }
                continue;
            }

            if (windowTokens + tokens > maxTokens && !window.isEmpty()) {
                segments.add(toSegment(window, segments.size(), document));

                List<String> tail = new ArrayList<>();
                int keptTokens = 0;
                for (int i = window.size() - 1; i >= 0; i--) {
                    int tailTokens = count(window.get(i));
                    if (keptTokens + tailTokens > overlapTokens) {
                        break;
                    }
                    tail.add(0, window.get(i));
                    keptTokens += tailTokens;
                }
                window = new ArrayList<>(tail);
                windowTokens = keptTokens;
            }

            window.add(sentence);
            windowTokens += tokens;
        }

        if (!window.isEmpty()) {
            segments.add(toSegment(window, segments.size(), document));
        }
        return segments;
    }

    private int count(String text) {
        return estimator.estimateTokenCountInText(text);
    }

    private TextSegment toSegment(List<String> sentences, int index, Document document) {
        Metadata metadata = document.metadata().copy()
                .put("index", index)
                .put("chunkType", "sentence-window");
        return TextSegment.from(String.join("", sentences), metadata);
    }

    private List<String> hardSplit(String sentence) {
        List<String> pieces = new ArrayList<>();
        int start = 0;
        while (start < sentence.length()) {
            int low = start + 1;
            int high = sentence.length();
            while (low < high) {
                int mid = (low + high + 1) / 2;
                if (count(sentence.substring(start, mid)) <= maxTokens) {
                    low = mid;
                } else {
                    high = mid - 1;
                }
            }
            pieces.add(sentence.substring(start, low));
            start = low;
        }
        return pieces;
    }
}
```

几个关键点。

`BOUNDARY` 用零宽断言，切的时候保留标点。`(?<=[。！？；!?;])` 的意思是「前面是这些标点就切一刀」，标点本身留在前一句里。后面那个 `\\n+` 处理换行，两份规则之间也能断开。

装块逻辑是贪心的：能装就装，装不下先落盘，再回退整句做重叠。回退时从后往前数，直到再加一句就超过 `overlapTokens` 为止。这样重叠的永远是完整句子。

`hardSplit` 兜底处理超长句。它用二分法找「在 token 上限内能放下的最长前缀」，比按固定字符数切更准确，代价是要多次调用分词器。正常文档里超长句很少，这点开销可以接受。

`toSegment` 里补了 `index` 字段。内置切分器会自动加，自定义的必须自己加，否则线上排查时没有位置信息。

### 示例三：接上 embedding，跑通检索和问答

准备工作：项目根目录建 `knowledge/` 文件夹，放几个 `.md` 文件，内容就是你的业务文档。然后设置环境变量 `OPENAI_API_KEY`。

```java
package com.example.rag;

import dev.langchain4j.data.document.Document;
import dev.langchain4j.data.document.Metadata;
import dev.langchain4j.data.embedding.Embedding;
import dev.langchain4j.data.segment.TextSegment;
import dev.langchain4j.model.chat.ChatModel;
import dev.langchain4j.model.embedding.EmbeddingModel;
import dev.langchain4j.model.openai.OpenAiChatModel;
import dev.langchain4j.model.openai.OpenAiEmbeddingModel;
import dev.langchain4j.model.openai.OpenAiTokenCountEstimator;
import dev.langchain4j.rag.content.retriever.ContentRetriever;
import dev.langchain4j.rag.content.retriever.EmbeddingStoreContentRetriever;
import dev.langchain4j.service.AiServices;
import dev.langchain4j.store.embedding.EmbeddingMatch;
import dev.langchain4j.store.embedding.EmbeddingSearchRequest;
import dev.langchain4j.store.embedding.EmbeddingSearchResult;
import dev.langchain4j.store.embedding.EmbeddingStore;
import dev.langchain4j.store.embedding.EmbeddingStoreIngestor;
import dev.langchain4j.store.embedding.inmemory.InMemoryEmbeddingStore;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

public class RagApp {

    public interface Assistant {
        String answer(String question);
    }

    public static void main(String[] args) throws Exception {
        String apiKey = System.getenv("OPENAI_API_KEY");
        if (apiKey == null || apiKey.isBlank()) {
            throw new IllegalStateException("请先设置环境变量 OPENAI_API_KEY");
        }

        EmbeddingModel embeddingModel = OpenAiEmbeddingModel.builder()
                .apiKey(apiKey)
                .modelName("text-embedding-3-small")
                .build();

        ChatModel chatModel = OpenAiChatModel.builder()
                .apiKey(apiKey)
                .modelName("gpt-4o-mini")
                .temperature(0.2)
                .build();

        EmbeddingStore<TextSegment> store = new InMemoryEmbeddingStore<>();

        EmbeddingStoreIngestor ingestor = EmbeddingStoreIngestor.builder()
                .documentSplitter(new ChineseSentenceSplitter(
                        320, 40, new OpenAiTokenCountEstimator("gpt-4o-mini")))
                .embeddingModel(embeddingModel)
                .embeddingStore(store)
                .build();

        Path knowledgeDir = Path.of("knowledge");
        try (var files = Files.list(knowledgeDir)) {
            List<Path> markdownFiles = files
                    .filter(path -> path.toString().endsWith(".md"))
                    .toList();

            for (Path file : markdownFiles) {
                Metadata metadata = new Metadata()
                        .put("source", file.getFileName().toString())
                        .put("type", "business-rule");
                ingestor.ingest(Document.from(Files.readString(file), metadata));
            }
        }

        Embedding queryEmbedding = embeddingModel.embed("退款多久能到账").content();
        EmbeddingSearchResult<TextSegment> result = store.search(EmbeddingSearchRequest.builder()
                .queryEmbedding(queryEmbedding)
                .maxResults(4)
                .minScore(0.55)
                .build());

        System.out.println("===== 检索结果 =====");
        for (EmbeddingMatch<TextSegment> match : result.matches()) {
            TextSegment segment = match.embedded();
            System.out.printf("score=%.3f | source=%s | index=%s%n  %s%n",
                    match.score(),
                    segment.metadata().getString("source"),
                    segment.metadata().getInteger("index"),
                    segment.text().replace("\n", " "));
        }

        ContentRetriever retriever = EmbeddingStoreContentRetriever.builder()
                .embeddingStore(store)
                .embeddingModel(embeddingModel)
                .maxResults(4)
                .minScore(0.55)
                .build();

        Assistant assistant = AiServices.builder(Assistant.class)
                .chatModel(chatModel)
                .contentRetriever(retriever)
                .build();

        System.out.println("\n===== 模型回答 =====");
        System.out.println(assistant.answer("退款多久能到账？超过 7 天还没到怎么办？"));
    }
}
```

运行：

```bash
mvn -q compile exec:java -Dexec.mainClass=com.example.rag.RagApp
```

这段代码做了四件事。

建两个模型：embedding 模型负责把文本转成向量，chat 模型负责生成回答。`temperature(0.2)` 是让回答稳一点，RAG 场景不需要它发挥创意。

建入库管道：切分器用刚写的 `ChineseSentenceSplitter`，块上限 320 token，块间重叠 40 token。320 这个数字不是拍脑袋，`text-embedding-3-small` 支持 8191 token 的输入，但块越大语义越糊，中文业务文档一般 200 到 500 token 比较合适。

给文档打元数据再入库。`source` 记录文件名，`type` 标记业务类型。这两个字段后面既能用来过滤，也能用来在回答里标注出处。

检索时先手动查一次，把分数和原文打出来。这一步很重要，它能让你直观看到「召回了什么」。`minScore(0.55)` 是经验起点，不同 embedding 模型的分数分布不一样，换模型必须重新校准。

最后用 `AiServices` 把检索器挂到接口上。你只声明一个 `answer` 方法，LangChain4j 会自动完成「检索 → 拼提示词 → 调模型 → 返回文本」。想在回答里带出处，把返回值改成 `Result<String>`，再取 `contents()` 即可。

## 四、踩坑经验和最佳实践

**中文别指望默认的句级切分。** 这是最大的坑。默认句子模型认英文标点，中文会被当成一个超长句，最后退到字符切分。要么用上面的自定义切分器，要么在入库前把中文标点规则处理好。判断方法很简单：打印每块结尾，看有没有断在句子中间。

**PDF 解析出来的换行会把段落切碎。** PDF 转文本经常一行一个换行，段落切分器看到两个换行就以为是新段落，结果一段话被切成十几块。入库前先做清洗：单个换行合并成空格，连续两个以上换行才保留。清洗比换切分器更有效。

**overlap 不是越大越好。** 重叠 50% 看起来很稳，实际会让 topK 里塞满同一段内容的多个副本，真正相关的其他段落被挤出去。经验值是全块的 10% 到 15%。重叠的目的是救边界，不是复制内容。

**表格要单独处理。** 纯文本切分会把表格拦腰截断，表头在一头，数据在另一头，模型看到「| 3 个工作日 |」根本不知道这一列是什么。做法是把表格转成 Markdown，每行数据前面补上表头字段，比如「退款到账时间：银行卡 3 到 7 个工作日」。转换后表格行就变成了自解释的句子。

**元数据要带全。** 至少三个字段：来源文件、块序号、业务分类。线上出问题，靠这三个字段才能定位。别只存文本，向量库里丢了元数据，等于把书拆散还不标页码。

**改切分参数必须全量重建索引。** 块变了，向量就变了。只重新嵌入新增文档，老向量还是按老切法算的，检索结果会新旧混杂。切分参数属于索引结构的一部分，动它就得重建。

**minScore 不能跨模型复用。** 0.55 在某个模型上是「勉强相关」，换一个模型可能变成「高度相关」。换 embedding 模型时，拿同一批问题重新跑一遍分数分布，再定阈值。

**块大小按问题类型定。** 事实型问答（退款几天到账）适合小块，200 到 300 token，精确。流程型问答（怎么申请退款）适合大块，500 到 800 token，保证步骤完整。一个知识库里混着两类内容，就按文档类型分别配置切分器，别一刀切。

## 五、性能对比和技术选型

四种切分方式的实际取舍：

| 切分方式 | 边界质量 | 中文支持 | 成本 | 适用场景 |
| --- | --- | --- | --- | --- |
| `DocumentSplitters.recursive`（字符） | 中，中文会退化为字符切 | 差 | 低，纯字符串操作 | 英文文档、结构规整的 Markdown |
| `DocumentSplitters.recursive`（token） | 中，同上 | 差 | 中，每块要分词 | 对上下文长度敏感的场景 |
| `DocumentByParagraphSplitter` | 段落完整，段内仍会切 | 中 | 低 | 段落短、主题集中的文档 |
| 自定义中文分句切分器 | 高，整句进出 | 好 | 中，分词次数多 | 中文业务文档、规则手册、客服知识库 |

选型建议，按优先级排：

1. 中文知识库，直接用自定义分句切分器。多写 100 行代码，省掉后面几个月的检索调优。
2. 英文或中英混排，`DocumentSplitters.recursive` 配合 token 计量够用。
3. 文档结构非常规整（每段就是一个完整知识点），段落切分器最省事，但要把超长段落先拆开。
4. 别用固定字符数硬切。它唯一的优点是简单，代价是检索质量不可控。

块大小的起点：事实型 250 token，流程型 500 token，重叠 10% 到 15%。这三个数字不是标准答案，是让你有个能跑起来的起点，最终要靠真实问题集校准。

## 六、总结

切分是 RAG 里最不起眼、又最不能凑合的一步。模型再强，块里没有完整答案，它也变不出来。

三件事记住就够了。

第一，块是检索的最小单位。调 topK、换 embedding 模型之前，先确认块里有没有完整语义。没有，先改切分。

第二，中文要用中文的分句规则。LangChain4j 默认的句子模型是英文的，中文会一路退化成按字符硬切，切口落在哪全看运气。自定义一个按中文标点分句的 `DocumentSplitter`，是投入产出比最高的一件事。

第三，用真实问题验证，别用感觉。20 个问题，看 top3 命中率。低于八成就是切分或检索有问题，改完再测。这个循环跑三轮，比看十篇调优文章都管用。

## 参考资料

- [LangChain4j RAG 教程](https://docs.langchain4j.dev/tutorials/rag)
- [LangChain4j 内存向量存储](https://docs.langchain4j.dev/integrations/embedding-stores/in-memory)
- [LangChain4j AI Services](https://docs.langchain4j.dev/tutorials/ai-services)

文 / 会编程的吕洞宾
