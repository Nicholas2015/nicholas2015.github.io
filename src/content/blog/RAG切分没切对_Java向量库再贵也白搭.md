---
title: "RAG切分没切对，Java向量库再贵也白搭"
date: 2026-11-14T20:00:00+08:00
category: "AI"
tags: ["AI", "rag"]
---

> 知识库上线三周，用户问"滤芯多久换一次"，AI 答得头头是道；问"漏水了先关哪个阀"，它开始胡编。你换了更贵的 embedding 模型、加了 rerank、调了 topK，召回还是忽好忽坏。打开向量库看一眼入库的 chunk，问题往往就摆在那儿：半句话、断掉的表格、丢了标题的段落。切分是 RAG 的第一道工序，也是唯一一道做错了后面全白费的工序。

**摘要：** RAG 召回质量有一半死在切分上。本文用 LangChain4j 1.x 拆开文档切分的内部结构，给出三段可直接运行的 Java 代码——递归切分、按 Markdown 标题切、父子块切分，并说清 chunk 大小和 overlap 到底该怎么定。

## 一、这个问题到底是什么

**切分是 RAG 里唯一一个"后面再优化也补不回来"的环节。**

检索、重排、提示词都能在后面调，切坏了的信息在入库那一刻就没了。模型再强也读不到一句被拦腰砍断的话。常见的翻车有五种，你对号入座一下。

**第一种：整篇塞进去。** 有人图省事，一份 3 万字的设备手册只生成一个向量。向量是这段文本的"语义平均分"，3 万字里讲了安装、维护、故障码、保修，平均下来等于什么都没讲。用户问保修期，它召回的是整本手册，然后模型开始自由发挥。

**第二种：按固定长度硬切。** 每 1000 字切一刀，不管刀口落在哪。于是"更换滤芯前请先关闭进水阀"被切成两半：前半句在第 7 块，后半句在第 8 块。用户问"换滤芯要注意什么"，命中的第 7 块只有"更换滤芯前请先"，答出来的操作步骤直接漏掉最关键的一步。

**第三种：表格和代码被腰斩。** 参数表切成两截，第二块只剩表头和几行数字，没有列名，人类看了都懵，别说模型。代码块更惨，切掉 `}` 之后整段语法都不成立。

**第四种：切完丢了上下文。** 一段正文写着"该值默认为 30 秒"，你知道"该值"指什么吗？原始文档里它上面有个 `## 连接超时` 的标题，切分时标题被扔掉了。这块内容单独看毫无意义，向量也就毫无区分度。

**第五种：元数据没写。** chunk 里只有文本，没有来源文件、没有章节、没有权限标签、没有版本号。后面想按部门过滤、想在回答里标注出处、想只检索最新版文档，全都做不了——只能推倒重来重新入库。

这五种问题的共同点：**都是入库阶段一次性犯下的错，而且全都不可逆。**

所以切分不是"随便切切"，它决定了三件事：向量能不能表达清楚一个意思、召回来的内容够不够模型直接用、回答能不能溯源。下面把它的机制拆开。

## 二、底层原理到底怎么回事

**切分器在做的事，是把一篇长文档拆成一堆"自带语义边界的文本块"，每块单独算一个向量。**

### 从 Document 到 TextSegment

LangChain4j 里这两个类型分工很明确。

`Document` 是整篇文档：一个 `text()` 加一份 `Metadata`。`TextSegment` 是切出来的块：一小段 `text()` 加一份 `Metadata`。切分器 `DocumentSplitter` 就一个核心方法 `split(Document)`，返回 `List<TextSegment>`。

关键在于**切分不是按字符数硬砍，而是按语义层级从上往下退**。以 `DocumentSplitters.recursive()` 为例，它的退让顺序是：

1. 先按**段落**切（空行分隔）
2. 一个段落还是太长，按**行**切
3. 一行还是太长，按**句子**切
4. 一句还是太长，按**词**切
5. 词也不行，最后才按**字符**硬切

也就是说，只有遇到"一整个超长句子"这种极端情况，才会出现真正的硬截断。这就是它比 `text.substring(0, 1000)` 强的地方——它尽量让每个块的边界落在人写作时本来就有的断点上。

### 字符和 token 是两套尺子

切分器有两种度量方式：按字符（char）或按 token。`DocumentSplitters.recursive(500, 80)` 里的 500 是字符数；带 `TokenCountEstimator` 参数的重载里，500 就是 token 数。

差别在哪？模型计费和上下文窗口都按 token 算。中文大致 1 个汉字对应 1 到 1.5 个 token，英文 1 个 token 约 4 个字符。所以按字符切 500，实际可能吃掉 500 到 750 个 token，遇到大量标点、生僻字还会更高。

**实践里的做法：** 如果知识库以中文为主、不接 tokenizer，用字符切没问题，把预算往下压 30% 就行。要对成本精打细算，就传一个 `TokenCountEstimator` 进去，让它按真实 token 算。LangChain4j 的 `TokenCountEstimator` 接口有三个方法（文本、单条消息、多条消息），自己实现一个基于 jtokkit 或模型官方 tokenizer 的版本也不难。

### overlap 为什么只在句子边界取

`recursive(500, 80)` 的第二个参数是重叠长度。它的作用是把上一块的结尾几句话复制到下一块开头，避免一个完整意思正好被切断。

注意源码里的细节：**重叠部分总是按句子往回取的**，不会取到半句话。原因是重叠的目的是"补上下文"，不是"补字符"。取半句话进来，既浪费 token，又给向量掺了噪声。

代价也很实在：80 字符的重叠意味着总 token 量多出 16% 到 20%。一份 10 万字的文档，切完可能变成 12 万字的入库量，embedding 费用和存储同步上涨。**重叠不是越大越好，够用就行。**

### 向量是"平均语义"，这就是 chunk 大小的根本矛盾

这一点想通了，参数就不用瞎试。

embedding 模型把一段文本压成一个固定长度的向量（常见 768 维、1024 维、1536 维）。这个过程本质上是把文本里所有语义做加权平均。于是：

- **块太大**：一平均，主题就糊了。安装、维护、故障码混在一个向量里，问哪个都"有点像"，哪个都不准。
- **块太小**：平均是准了，但信息不够。一个只有 20 字的块，能表达的语义太少，向量区分度差，而且模型拿到它也没法生成完整答案。

所以 chunk 大小的本质是**在"向量纯度"和"信息完整性"之间找一个平衡点**。这个平衡点不是常数，它跟着文档类型走：产品手册的段落短、边界清晰，400 到 600 字符就够；技术白皮书段落长、逻辑链紧密，得放到 800 到 1200。

### 结构信息是免费的语义标签

文档天然自带结构：标题层级、表格、代码块、列表。这些结构本身就是作者给的语义标注，比任何算法猜出来的边界都准。

如果一份文档有清晰的 `#` / `##` / `###` 标题，把"标题路径"跟着块一起存下来，检索质量会明显不一样。比如块的正文是"该值默认为 30 秒"，前面挂上 `连接配置 > 超时参数`，这块的语义立刻就明确了，用户问"超时时间默认多少"也能准确命中。

**这类信息存在 metadata 里，不进正文。** 进正文会污染向量（把标题词重复加权），进 metadata 则能做过滤、能做展示、还能在拼 prompt 的时候还原上下文。

### 父子块：把"检索准"和"生成全"拆开

chunk 大小那个矛盾，其实可以绕过去。

做法是切两层：**小块用来检索，大块用来生成**。切出一个 800 字符的父块，再把它切成几个 150 字符的子块，子块存向量并记录 `parent_id`。检索命中的是子块（精准），喂给模型的是它对应的父块（完整）。

LangChain4j 里没有现成的父子块组件，但用两个切分器套一层就能实现，后面实战部分给代码。这也是目前工程上最常用的一招。

## 三、实战：手把手写代码

三个例子都是纯 Java、无外部服务，配好依赖后在 IDE 里直接跑 `main` 就能看到输出。先给一份能用的 pom。

```xml
<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
    <modelVersion>4.0.0</modelVersion>

    <groupId>com.example</groupId>
    <artifactId>rag-splitter-demo</artifactId>
    <version>1.0.0</version>

    <properties>
        <maven.compiler.release>21</maven.compiler.release>
        <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
    </properties>

    <dependencies>
        <dependency>
            <groupId>dev.langchain4j</groupId>
            <artifactId>langchain4j</artifactId>
            <version>1.23.0</version>
        </dependency>
        <dependency>
            <groupId>org.slf4j</groupId>
            <artifactId>slf4j-simple</artifactId>
            <version>2.0.20</version>
        </dependency>
    </dependencies>
</project>
```

切分器本身不需要模型、不需要向量库，`langchain4j` 一个包足够。这一点很多人不知道，以为切分也得接大模型。

### 3.1 最小可跑：看看递归切分到底切出什么

先别急着入库，把切出来的块打印出来看一眼。这一步能省掉后面 80% 的返工。

```java
package com.example.rag.splitter;

import dev.langchain4j.data.document.Document;
import dev.langchain4j.data.document.DocumentSplitter;
import dev.langchain4j.data.document.Metadata;
import dev.langchain4j.data.document.splitter.DocumentSplitters;
import dev.langchain4j.data.segment.TextSegment;

import java.util.List;
import java.util.Map;

public class RecursiveSplitDemo {

    public static void main(String[] args) {
        String text = """
                净水器冬季维护说明

                一、长期停用

                如果室外温度可能低于 5 摄氏度，请先关闭进水阀，再打开排污口排空管路中的存水。排空后不要重新通水，低温环境下残留水结冰会把滤瓶撑裂。来年恢复使用前，需要更换全部滤芯，因为滤芯内的潮湿环境容易滋生细菌。

                二、短期停用

                停用时间在一周以内，不需要排空管路。建议关闭进水阀，避免水压波动造成接口渗漏。重新通水时先打开排污口冲洗三分钟，把管路中积存的陈水放掉，再切换到正常出水。

                三、故障码 E03

                E03 表示进水压力不足，常见原因是进水阀门未完全打开、前置过滤器堵塞、或者入户水压低于 0.1 兆帕。排查顺序是：先确认阀门全开，再拆下前置过滤器检查滤网，最后用压力表测量入户水压。三项都正常但故障码仍在，说明压力传感器损坏，需要联系售后更换。
                """;

        // 元数据在切分前挂到 Document 上，切出来的每一块都会继承
        Metadata metadata = Metadata.from(Map.of(
                "source", "净水器冬季维护说明.md",
                "doc_id", "manual-water-001",
                "version", "v3"
        ));
        Document document = Document.from(text, metadata);

        // 第一个参数：块最大字符数；第二个参数：块间重叠字符数
        DocumentSplitter splitter = DocumentSplitters.recursive(200, 40);
        List<TextSegment> segments = splitter.split(document);

        System.out.println("切出块数：" + segments.size());
        for (TextSegment segment : segments) {
            Metadata meta = segment.metadata();
            System.out.printf("---- index=%s 长度=%d 来源=%s%n%s%n",
                    meta.getString("index"), segment.text().length(), meta.getString("source"),
                    segment.text());
        }
    }
}
```

跑出来你会看到几件事，每件都值得注意。

`index` 是切分器自动加的，**类型是字符串不是整数**。源码里是 `String.valueOf(index)`，所以 `getString("index")` 拿得到，`getInteger("index")` 也能拿到——LangChain4j 的 `Metadata.getInteger` 内部会做类型转换。但你自己强转 `(Integer) metadata.toMap().get("index")` 就会抛 `ClassCastException`，这个坑很多人踩过。

切出来的块**继承了 Document 上的所有元数据**。这是源码里 `document.metadata().copy().put("index", ...)` 的效果，而且用的是 `copy()`，所以每块的元数据是独立的，改一块不会污染其他块。

切分器会尽量在段落边界落刀。你写的 200 字符预算，实际输出的块会在 200 上下浮动，遇到一个 300 字的段落会整体保留而不是硬切——这是层级退让的结果。

**调之前先看，看完再调。** 把这份打印结果贴给业务方确认"这样切合理吗"，比你自己猜准得多。

### 3.2 结构感知：按 Markdown 标题切，把标题路径带进元数据

技术文档大多是 Markdown。这种文档最好的边界就是标题，不用算，作者已经标好了。LangChain4j 自带的分割器不认识标题，得自己写一个 `DocumentSplitter`。

好处有两个：块不会跨章节，`heading_path` 还能在回答里当出处展示。

```java
package com.example.rag.splitter;

import dev.langchain4j.data.document.Document;
import dev.langchain4j.data.document.DocumentSplitter;
import dev.langchain4j.data.document.Metadata;
import dev.langchain4j.data.document.splitter.DocumentSplitters;
import dev.langchain4j.data.segment.TextSegment;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class MarkdownSectionSplitter implements DocumentSplitter {

    /** 匹配 1 到 3 级标题，比如 "## 连接参数" */
    private static final Pattern HEADING = Pattern.compile("^(#{1,3})\\s+(.+)$");

    private final int maxChars;
    /** 某个章节本身超过 maxChars 时，交给递归分割器兜底 */
    private final DocumentSplitter fallback;

    public MarkdownSectionSplitter(int maxChars, int overlapChars) {
        this.maxChars = maxChars;
        this.fallback = DocumentSplitters.recursive(maxChars, overlapChars);
    }

    @Override
    public List<TextSegment> split(Document document) {
        List<TextSegment> result = new ArrayList<>();
        // 当前标题路径，下标 0 对应一级标题，以此类推
        List<String> headingPath = new ArrayList<>();
        StringBuilder section = new StringBuilder();
        int[] seq = {0};

        for (String line : document.text().split("\\R")) {
            Matcher matcher = HEADING.matcher(line.trim());
            if (matcher.matches()) {
                flush(section, headingPath, document, result, seq);
                int level = matcher.group(1).length();
                // 遇到同级或更高级标题，先把路径里更深的层级砍掉
                while (headingPath.size() >= level) {
                    headingPath.remove(headingPath.size() - 1);
                }
                headingPath.add(matcher.group(2).trim());
                // 标题本身写进正文首行，块单独拿出来看也知道自己在讲什么
                section.append(line.trim()).append('\n');
            } else {
                section.append(line).append('\n');
            }
        }
        flush(section, headingPath, document, result, seq);
        return result;
    }

    private void flush(StringBuilder section, List<String> headingPath, Document document,
                       List<TextSegment> result, int[] seq) {
        String body = section.toString().trim();
        section.setLength(0);
        if (body.isEmpty()) {
            return;
        }

        Metadata base = document.metadata().copy()
                .put("heading_path", String.join(" > ", headingPath))
                .put("level", headingPath.size());

        if (body.length() <= maxChars) {
            result.add(TextSegment.from(body,
                    base.copy().put("index", String.valueOf(seq[0]++))));
            return;
        }

        // 章节太长，退回递归切分，再把标题路径合并回每一块
        List<TextSegment> parts = fallback.split(Document.from(body, base));
        for (TextSegment part : parts) {
            Metadata merged = part.metadata().copy()
                    .put("index", String.valueOf(seq[0]++));
            result.add(TextSegment.from(part.text(), merged));
        }
    }

    public static void main(String[] args) {
        String markdown = """
                # 网关接入指南

                ## 连接超时

                客户端连接网关时，默认读取超时时间为 30 秒。该值可以通过 startup 脚本的 timeout 参数覆盖。

                ## 重试策略

                网关对幂等接口默认重试两次，间隔 200 毫秒。非幂等接口（POST、PATCH）不重试，需要在业务侧做补偿。

                ### 补偿表设计

                建议用单独的一张补偿表记录失败请求，字段至少包含请求号、接口名、失败原因、重试次数、下次重试时间。补偿任务按下次重试时间轮询，单批不超过 200 条，避免一次拉太多把数据库压垮。
                """;

        Document document = Document.from(markdown,
                Metadata.from(java.util.Map.of("source", "gateway-guide.md", "doc_id", "gw-001")));

        MarkdownSectionSplitter splitter = new MarkdownSectionSplitter(300, 40);
        for (TextSegment segment : splitter.split(document)) {
            System.out.printf("[%s] level=%d path=%s%n%s%n%n",
                    segment.metadata().getString("index"),
                    segment.metadata().getInteger("level"),
                    segment.metadata().getString("heading_path"),
                    segment.text());
        }
    }
}
```

这段代码有几个设计点值得说明。

`headingPath` 用列表维护，遇到 `###` 就在 `##` 基础上追加，遇到新的 `##` 就先把 `###` 弹掉。这就是一个极简的栈，靠它还原出"补偿表设计"实际位于"网关接入指南 > 重试策略"下面。

标题行被写进了正文，而不是只存元数据。原因是向量只看正文，一个只有"重试两次，间隔 200 毫秒"的块，缺少"重试策略"这个主语。把标题带上，向量才准。

章节超过 `maxChars` 时没有硬切，而是丢回 `DocumentSplitters.recursive`。这样长章节内部依然按段落、句子退让，同时 `heading_path` 通过 `Document.from(body, base)` 传下去，兜底切出来的块也带着标题。

`index` 是全局递增的，不是每个章节重新从 0 开始。这样同一个 `doc_id` 下的 `(doc_id, index)` 就能唯一定位一块，做增量更新时不会串。

### 3.3 父子块：小块检索，大块喂模型

前面说的那个矛盾，用这招解决。父块负责"信息完整"，子块负责"向量精准"。

```java
package com.example.rag.splitter;

import dev.langchain4j.data.document.Document;
import dev.langchain4j.data.document.DocumentSplitter;
import dev.langchain4j.data.document.Metadata;
import dev.langchain4j.data.document.splitter.DocumentSplitters;
import dev.langchain4j.data.segment.TextSegment;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

public class ParentChildChunker {

    /** 父块：保留完整上下文，直接喂给模型 */
    private final DocumentSplitter parentSplitter = DocumentSplitters.recursive(900, 0);
    /** 子块：只用来算向量、做检索 */
    private final DocumentSplitter childSplitter = DocumentSplitters.recursive(180, 30);

    public record Chunk(String parentId, TextSegment child, String parentText) {
    }

    public List<Chunk> chunk(Document document, String docId) {
        List<Chunk> chunks = new ArrayList<>();
        List<TextSegment> parents = parentSplitter.split(document);

        for (TextSegment parent : parents) {
            String parentId = docId + "-p" + parent.metadata().getString("index");
            List<TextSegment> children =
                    childSplitter.split(Document.from(parent.text(), parent.metadata()));

            for (TextSegment child : children) {
                Metadata meta = child.metadata().copy()
                        .put("doc_id", docId)
                        .put("parent_id", parentId);
                chunks.add(new Chunk(parentId, TextSegment.from(child.text(), meta), parent.text()));
            }
        }
        return chunks;
    }

    public static void main(String[] args) {
        String text = """
                滤芯更换周期

                PP 棉滤芯建议 3 到 6 个月更换一次，具体看进水水质。水质较硬的地区，滤芯表面容易结垢，出水量明显变小就该换了，不必死等周期。

                活性炭滤芯的更换周期是 6 到 12 个月。它主要吸附余氯和异味，失效的表现是出水有味道，或者烧水后水面漂浮一层白色粉末。活性炭失效后不会立刻影响出水量，所以容易被忽略，建议按时间强制更换。

                RO 膜的更换周期是 2 到 3 年，取决于前置滤芯的维护情况。前置滤芯按时更换，RO 膜寿命能拉满；前置滤芯长期不换，泥沙和余氯会直接损伤膜片，一年多就得换，成本差好几倍。
                """;

        Document document = Document.from(text,
                Metadata.from(Map.of("source", "滤芯说明.md")));

        ParentChildChunker chunker = new ParentChildChunker();
        List<Chunk> chunks = chunker.chunk(document, "manual-water-001");

        for (Chunk chunk : chunks) {
            System.out.printf("父块=%s 子块长度=%d%n子块内容：%s%n父块长度=%d%n%n",
                    chunk.parentId(),
                    chunk.child().text().length(),
                    chunk.child().text().replace("\n", " "),
                    chunk.parentText().length());
        }
    }
}
```

父块 900 字符、子块 180 字符、子块重叠 30 字符，这三个数是起点不是定论。

父块切分时重叠设成 0，因为父块之间不需要重叠——它不会被单独拿去回答，重叠只会在子块层产生价值。子块重叠加 30 字符，是为了让子块之间不丢衔接句。

`parent_id` 的构造方式是 `{docId}-p{父块 index}`。父子块的 index 分别独立计数，父块 0 的子块 index 也是从 0 开始，所以必须拼上 `parent_id` 才能唯一定位一个子块。

入库时，**只有子块进向量库**，`parent_id` 作为元数据字段存好。父块文本可以一起存进向量库的同一条记录的 `metadata` 里（大多数向量库支持文本型 payload），也可以单独存一张表。前者查一次就够，后者更省空间。我倾向直接存 payload，少一次数据库往返。

检索命中子块之后，`parent_id` 相同的子块去重，取父块全文，再拼进 prompt。一份 900 字符的中文父块大约 900 到 1300 token，取三块三千多 token，比整篇塞进去省得多，也比 180 字符的子块给的信息完整得多。

## 四、踩坑经验和最佳实践

**踩坑一：元数据对象被共享，切完互相覆盖。** `Metadata` 是可变对象。你要是自己写切分器，图省事直接 `document.metadata().put("index", "0")`，那所有块共用一份元数据，最后全部变成同一个 index。LangChain4j 自带切分器用的是 `copy()`，没这个问题；自己写就必须每块 `copy()`。

**踩坑二：拿 `index` 当整数用。** 前面提过，它存的是字符串。做增量更新、做排序、拼 `parent_id` 时，该 `getInteger` 就 `getInteger`，别直接强转 Map 里的值。

**踩坑三：overlap 随手写 200。** 一块 500 字符、重叠 200 字符，总入库量凭空多 40%，embedding 账单和检索时的重复结果一起涨。经验值是块大小的 10% 到 15%，句子边界清晰的中文文档 10% 就够。

**踩坑四：表格被切成两截。** 结构化分割器只认段落和句子，表格在它眼里就是一堆短句。参数表、对比表、配置清单这类内容，正确做法是**整张表当一个块**，哪怕它有 1200 字符。表格的价值在于行列对应关系，切开就废了。

**踩坑五：PDF 解析出来的顺序是乱的。** 双栏排版的 PDF，解析器可能按行读，把左栏第一行和右栏第一行拼在一起。这不是切分器的锅，但结果一样糟糕。入库前先抽 5 页人工看一遍文本顺序，比后面调参有效得多。

**踩坑六：页眉页脚重复。** PDF 每页顶部都有文档名和页码，解析完混进正文，切片后每个块都带着同一句噪声。这种块向量高度相似，检索时互相挤占名额。解析后按行做频次统计，出现次数接近页数的行直接删掉。

**踩坑七：只估算字符，撞了模型窗口。** 按 1000 字符切，遇到英文技术文档、代码、JSON，1000 字符可能就 400 token；遇到中文生僻专业词，1000 字符能到 1400 token。给模型拼 5 块就可能超窗口。要么留足余量，要么老老实实用 tokenizer。

**实践建议，按重要性排：**

1. **上线前抽样人工看 20 块**，看边界是否落在语义断点上。这一步的收益比任何调参都高。
2. **元数据一次写全**：`doc_id`、`source`、`version`、`heading_path`、`index`、`tenant_id`。缺了哪个，后面就得多跑一次全量入库。
3. **不同文档类型用不同切分器**。Markdown 用标题切，纯文本用递归切，参数表整块切，代码按函数切。一个切分器走天下是幻想。
4. **块大小先定在 400 到 800 字符**，跑通再按实际召回效果微调。别一上来就试 15 组参数，没有评测集的话试出来的都是幻觉。
5. **留一份可重放的原始文档**。切分策略一定会改，改完得能重新入库。原始文件丢了，就只能重新找业务方要。

## 五、性能对比和技术选型

**四种切分方式的取舍很清楚：预算够就用结构感知，预算紧就用递归，别用固定长度。**

| 切分方式 | 边界质量 | 实现成本 | 适用场景 | 主要风险 |
| --- | --- | --- | --- | --- |
| 固定字符截断 | 差 | 极低 | 临时验证、日志类文本 | 句子腰斩，语义错乱 |
| 递归切分 | 中上 | 低 | 通用纯文本、混排文档 | 表格和代码照样切碎 |
| 按标题切分 | 好 | 中 | Markdown、HTML、Word 转出的结构化文档 | 标题层级混乱时失效 |
| LLM 语义切分 | 最好 | 高 | 高价值知识库、法律合同 | 每篇都要调模型，成本高、慢 |

块大小的影响可以量化。以一份 1 万字的文档、每块配 3 块召回为参考：

| 块大小（字符） | 块数量 | 单次召回送入模型的量 | 向量纯度 | 说明 |
| --- | --- | --- | --- | --- |
| 200 | 约 55 | 约 600 字符 | 高 | 检索准，但块内常缺主语，答案容易断章 |
| 500 | 约 22 | 约 1500 字符 | 较高 | 中文技术文档的通用推荐值 |
| 1000 | 约 11 | 约 3000 字符 | 中 | 适合逻辑链长的白皮书、方案文档 |
| 2000 | 约 5 | 约 6000 字符 | 低 | 一个向量混多个主题，召回开始发虚 |

表里的块数量是按无重叠估算的，实际加重叠会多 10% 到 20%。

**我的建议很直接：**

中文技术文档、产品手册、FAQ，用递归切分，500 字符配 10% 重叠，先跑起来。文档结构清晰（有标题、有章节），换成按标题切分，并把 `heading_path` 写进元数据。对话式问答、需要长上下文的场景，上父子块。

别碰 LLM 语义切分的冲动。它确实切得最漂亮，但一篇文档切一次要几毛钱、几十秒，知识库上千篇的时候，这笔账很难算平。等前三种都试过、确实还差那一截，再考虑。

## 六、总结

切分做错的代价是隐形的：向量库看起来一切正常，检索也能返回结果，就是答不准。等到用户投诉，你已经分不清是切分问题、embedding 问题还是提示词问题。

判断标准其实很简单：**把任意一个 chunk 单独拿出来读一遍，能不能读懂？** 读不懂，模型也读不懂。它缺主语、缺标题、缺上下文，那这块向量就是废的。

记住三层关系。文档层带全局元数据，块层带位置和结构信息，检索层靠子块精准、靠父块完整。这三层的信息在入库那一刻就定型了，后面所有的调优都在这之上做加法，补不回缺失的部分。

最后一句：换 embedding 模型之前，先去看看你的 chunk。十次里有八次，问题不在模型。

---

文 / 会编程的吕洞宾

## 参考资料

- [LangChain4j RAG 官方教程](https://docs.langchain4j.dev/tutorials/rag/)
- [HierarchicalDocumentSplitter 源码](https://github.com/langchain4j/langchain4j/blob/main/langchain4j/src/main/java/dev/langchain4j/data/document/splitter/HierarchicalDocumentSplitter.java)
- [DocumentSplitter 接口源码](https://github.com/langchain4j/langchain4j/blob/main/langchain4j-core/src/main/java/dev/langchain4j/data/document/DocumentSplitter.java)
