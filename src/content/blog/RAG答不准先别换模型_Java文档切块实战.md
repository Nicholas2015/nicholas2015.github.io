---
title: "RAG 答不准先别换模型：Java 文档切块实战"
date: 2026-10-29T20:00:00+08:00
category: "AI"
tags: ["AI", "rag"]
---

**摘要：** RAG 答不准，多半不是模型不行，是文档切块这一步坏了。本文用 Spring AI 的 TikaDocumentReader 和 TokenTextSplitter，讲清 chunk 的 token 语义和每个参数的真实作用，再给三个能直接跑的例子：单文件块体检、带重叠和元数据的切块器、Spring Boot 上传入库。附源码级参数坑。

> 知识库上线第一周，用户问「保修期多久」，模型答了一段安装说明。你以为是模型不行，换了更大的模型，还是一样。其实问题在更前面一步：那段保修条款被切成两块，前半块没有标题，后半块没有主语，两块的向量都不像「保修」。这篇只讲一件事——Java 里怎么把 PDF、Word 切成模型真能用的块。

## 一、这个问题到底是什么

RAG 答不准，八成出在切块，不是出在模型。这句话不是玄学，是数据流向决定的：检索阶段模型根本看不到你的原始文档，它只看到你切出来的那几十个块。切坏了，后面再贵的模型也只能在垃圾里挑。

先看三个真实症状，对上号了你再往下读。

**症状一：答案沾边但不准。** 问「RAG 的 chunk 大小怎么定」，检索回来的是讲「文档加载」的段落。两块内容相邻，主题不同，但都被塞进同一个 800 token 的块里。向量是整块文本压成的一个点，块里混了两个主题，这个点就落在两者中间，谁都不像。

**症状二：答案对一半。** 「退货政策第三条是什么」，模型答了前两条。因为第三条正好被切块边界劈开了，前半句在上一块，后半句在下一块。检索只召回了其中一块。

**症状三：引用溯源对不上。** 你做了引用展示，点开是「第 12 页」，用户翻到第 12 页找不到那句话。因为块里只有正文，没有页码，你拿到的是 Tika 吐出来的临时文件名。

这三个症状的共同点是：**块本身不自洽**。一个块要么讲不清一件事，要么脱离上下文看不懂，要么查不到出处。

那什么样的块算合格？我给三个标准，后面所有代码都围着它们转：

- **语义完整**：一个块讲一件事，边界落在段落或小标题处，不劈开句子
- **自带上下文**：块里有足够信息让模型知道「这是在说什么的哪一部分」，至少带标题路径或文档名
- **可追溯**：块能定位回原文的位置，页码、章节、源文件名都得有

一份 300 页的产品手册，按默认参数切，大概能切出 500 到 700 块。这 500 多个块里，只要有 10% 切坏了，你的召回率就掉一个档次——而检索是按 Top-K 取的，坏块挤掉好块的位置，模型看到的就是坏块。

所以别急着换模型、调 topK、上重排序。先把切块这关过了，那些手段才有意义。

## 二、底层原理到底怎么回事

### 一个块，就是一个语义指纹

embedding 模型干的事，是把一段文本压成一个固定长度的数字数组，通常是 1536 个 float。你可以把它想成一个指纹：内容相近的文本，指纹就相近，距离就小。

关键在「一段文本」这四个字。指纹是整段压出来的一个点，不是每个句子一个点。一段里塞三个主题，压出来的点就是三个主题的平均值，谁都不像。

打个比方：你把一页纸揉成团塞进抽屉，抽屉外面只能贴一个标签。这页纸上要是有三段不相干的内容，你贴哪个标签都是错的。切块就是在决定「每张纸该多大、该写什么」。

### TokenTextSplitter 到底怎么切的

Spring AI 的默认切块器是 `TokenTextSplitter`，类在 `org.springframework.ai.transformer.splitter` 包下。它的逻辑不是按字符数硬切，我扒了源码，实际是这么跑的：

1. 用 CL100K_BASE 编码（就是 GPT 系列那套分词表）把整段文本变成一串 token 编号
2. 每次取前 `chunkSize` 个 token，解码回字符串
3. 如果后面还有大段剩余（剩余 token 数 > chunkSize），就在这截文本里找最后一个句号、问号、感叹号或换行，且这个位置要超过 `minChunkSizeChars`，在那儿截断
4. 截断后的文本长度要大于 `minChunkLengthToEmbed`，否则整块丢掉
5. 从 token 流里扣掉已用的部分，继续下一轮
6. 循环到 `maxNumChunks` 上限，剩下的文本一次性拼成最后一块，不再切

几个结论，都是从这段逻辑里直接读出来的：

**参数单位是 token，不是字。** 中文一个字大概吃 1 个 token 上下，英文一个单词大概 1.3 个 token。所以 `chunkSize=800` 对中文约等于 600 到 800 字，对英文是 600 多个单词。别拿字符数去套。

**标点回退是有条件的。** 只有当这块后面还剩很多内容时才回退。一份很短的小节，哪怕没到 chunkSize，也是完整一块，不会被劈开。这个设计挺合理。

**它不生成重叠。** 这点很多人搞错。源码里没有任何 overlap 逻辑，块和块之间是硬接的。上一块结尾的半句话，下一块不会补上。想要重叠，得自己写。

**`minChunkSizeChars` 设太大，标点回退会失效。** 因为回退位置必须大于这个值。你设成 1000，而 chunkSize 是 800 token（约 600 字），永远满足不了，切块就退化成按 token 硬切，句子中间一刀两断。

**`maxNumChunks` 是硬上限，超了就塞成一坨。** 默认 10000。单个文件切出超过 1 万块，剩下的不会继续切，而是拼成一个巨大的块。这种块基本等于废块，检索时永远排不上，还占存储。

各参数的实际作用对照：

| 参数 | 默认值 | 真实作用 |
|---|---|---|
| `chunkSize` | 800 | 每块的目标 token 数，回退标点后实际会略小 |
| `minChunkSizeChars` | 350 | 标点回退的最小位置，设太大会让回退失效 |
| `minChunkLengthToEmbed` | 5 | 短于这个字符数的块直接丢弃，用来过滤页眉页脚 |
| `maxNumChunks` | 10000 | 单文档块数上限，超出的剩余内容拼成最后一块 |
| `keepSeparator` | true | 保留换行，false 则把换行换成空格。代码块、表格必须留 true |

### 为什么块需要上下文

切块切到 500 token，一定会丢失上下文。原文里写「该部件在高温环境下需每 200 小时更换一次」，切成独立块之后，「该部件」指谁？模型不知道。

这不是小问题。Anthropic 在讲上下文检索时举过类似例子：一个块写着「公司收入增长 3%」，没有年份、没有公司名，检索阶段几乎不可能被召回，因为查询里一定有具体信息，而块里没有。

两种补法。一种是在切块时把标题路径拼进正文，让块自带上下文；另一种是切完之后，用模型给每个块生成一句「这块在讲什么」的前缀。前者便宜、确定性高，后者贵但效果好。生产环境我推荐先做前者，够用再说。

### 块大小该定多少

没有标准答案，但有个可操作的判断方法：**块大小要装得下一个完整的答案单元。**

FAQ 类知识库，一个问答就是天然一块，200 到 400 token 足够。技术文档，一节讲一个概念，600 到 800 token 合适。法律合同，条款是天然边界，按条切，可能只有 100 token。小说、长文，需要更大的块来保叙事连贯，1000 token 以上。

定完之后跑一遍体检（第三节第一个例子就是干这个的），看平均块长和你预期差多少，看有多少块短于 50 个字符——那些基本是页眉、页脚、目录残留，属于噪音。

## 三、实战：手把手写代码

先上依赖。三个就够：Web（提供上传接口和 Jackson）、Tika 文档读取器、commons（切块器在这里，Tika 读取器会传递依赖进来，但显式声明更清楚）。

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
    <artifactId>rag-ingest</artifactId>
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
            <artifactId>spring-ai-tika-document-reader</artifactId>
            <version>2.0.2</version>
        </dependency>

        <dependency>
            <groupId>org.springframework.ai</groupId>
            <artifactId>spring-ai-commons</artifactId>
            <version>2.0.2</version>
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

### 示例一：先给文档做一次体检

调参之前先看清楚你的文档长什么样。这个类读一个文件，切一遍，把块数、块长分布、头几块内容打出来。它不连数据库、不调模型，`java` 命令直接跑。

```java
package com.example.rag;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

import com.knuddels.jtokkit.Encodings;
import com.knuddels.jtokkit.api.Encoding;
import com.knuddels.jtokkit.api.EncodingType;
import org.springframework.ai.document.Document;
import org.springframework.ai.reader.tika.TikaDocumentReader;
import org.springframework.ai.transformer.splitter.TokenTextSplitter;
import org.springframework.core.io.PathResource;

public class ChunkProbe {

    public static void main(String[] args) {
        if (args.length != 1) {
            System.err.println("用法: java ChunkProbe <文件路径>");
            return;
        }

        Path file = Path.of(args[0]);
        List<Document> raw = new TikaDocumentReader(new PathResource(file)).get();

        StringBuilder all = new StringBuilder();
        for (Document doc : raw) {
            if (doc.getText() != null) {
                all.append(doc.getText());
            }
        }
        System.out.printf("原文长度: %d 字符%n", all.length());

        TokenTextSplitter splitter = TokenTextSplitter.builder()
                .withChunkSize(800)
                .withMinChunkSizeChars(300)
                .withMinChunkLengthToEmbed(20)
                .withMaxNumChunks(20000)
                .withKeepSeparator(true)
                .build();

        List<Document> chunks = splitter.split(raw);
        Encoding encoding = Encodings.newLazyEncodingRegistry().getEncoding(EncodingType.CL100K_BASE);

        List<Integer> sizes = new ArrayList<>();
        int tooShort = 0;
        for (Document chunk : chunks) {
            String text = chunk.getText() == null ? "" : chunk.getText();
            int tokens = encoding.encode(text).size();
            sizes.add(tokens);
            if (text.length() < 50) {
                tooShort++;
            }
        }

        int max = sizes.stream().mapToInt(Integer::intValue).max().orElse(0);
        int min = sizes.stream().mapToInt(Integer::intValue).min().orElse(0);
        double avg = sizes.stream().mapToInt(Integer::intValue).average().orElse(0);

        System.out.printf("块数: %d%n", chunks.size());
        System.out.printf("token 分布: 最小 %d / 平均 %.0f / 最大 %d%n", min, avg, max);
        System.out.printf("短于 50 字符的块: %d 个 (%.1f%%)%n",
                tooShort, chunks.isEmpty() ? 0 : tooShort * 100.0 / chunks.size());

        int show = Math.min(3, chunks.size());
        for (int i = 0; i < show; i++) {
            String text = chunks.get(i).getText();
            String preview = text == null ? "" : text.replace("\n", " ");
            System.out.println("--- 块 " + i + " (" + sizes.get(i) + " tokens) ---");
            System.out.println(preview.substring(0, Math.min(80, preview.length())));
        }
    }
}
```

这段代码的关键动作只有三个：`TikaDocumentReader` 把 PDF、DOCX、PPTX、HTML 统一转成 `List<Document>`；`TokenTextSplitter.split()` 切块；再用 jtokkit 的编码器数真实 token 数。

为什么单独统计「短于 50 字符的块」？因为这类块基本都是页眉、页脚、扫描件水印、目录页码。它们进向量库只会污染召回，看到这个数字高，就该去查 Tika 的文本后处理配置，或者直接把短块过滤掉。

跑一次，你会发现两件事：平均块长往往比 `chunkSize` 低 20% 到 30%（标点回退造成的），以及中文文档的块数比按字数估算的多不少。

### 示例二：带重叠和元数据的切块器

默认切块器不给重叠，也不给标题路径。自己包一层。

```java
package com.example.rag;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import org.springframework.ai.document.Document;
import org.springframework.ai.document.DocumentTransformer;
import org.springframework.ai.transformer.splitter.TokenTextSplitter;

public class OverlapDocumentTransformer implements DocumentTransformer {

    private final TokenTextSplitter splitter;
    private final int overlapChars;

    public OverlapDocumentTransformer(int chunkSize, int overlapChars) {
        this.overlapChars = overlapChars;
        this.splitter = TokenTextSplitter.builder()
                .withChunkSize(chunkSize)
                .withMinChunkSizeChars(200)
                .withMinChunkLengthToEmbed(20)
                .withMaxNumChunks(20000)
                .withKeepSeparator(true)
                .build();
    }

    @Override
    public List<Document> apply(List<Document> documents) {
        List<Document> result = new ArrayList<>();

        for (Document source : documents) {
            List<Document> pieces = this.splitter.split(source);
            String sourceName = String.valueOf(source.getMetadata().getOrDefault("source", "unknown"));
            String previousTail = "";

            for (int i = 0; i < pieces.size(); i++) {
                Document piece = pieces.get(i);
                String body = piece.getText() == null ? "" : piece.getText();
                String text = previousTail.isEmpty() ? body : previousTail + "\n" + body;

                Map<String, Object> metadata = new HashMap<>(piece.getMetadata());
                metadata.put("source", sourceName);
                metadata.put("chunk_index", i);
                metadata.put("chunk_total", pieces.size());

                result.add(new Document(text, metadata));
                previousTail = tail(body, this.overlapChars);
            }
        }
        return result;
    }

    private String tail(String text, int length) {
        if (text.length() <= length) {
            return text;
        }
        return text.substring(text.length() - length);
    }
}
```

三个动作值得说。

`splitter.split(source)` 直接吃 `Document` 而不是 `List`，切块器会把原文档的 metadata 复制到每一块上——所以源文件名会被带下来。但 `TikaDocumentReader` 写进 metadata 的 `source` 是资源的名字，如果你传的是临时文件路径，这里拿到的就是一串 `/tmp/rag-123456.pdf`。所以下面入库前要覆盖成业务侧的真实文件名。

重叠的实现是取上一块最后 `overlapChars` 个字符，拼到下一块开头。为什么用字符不用 token？简单，够用，而且边界情况少。代价是块的实际 token 会超标，`chunkSize=600` 加 120 字符重叠，实际可能到 700 token。留点余量就行。

`chunk_index` 和 `chunk_total` 不是摆设。用户点开引用时，你可以显示「第 3/12 段」；做上下文扩展检索时，靠这两个字段把相邻块一起捞出来。

重叠设多少？块长的 10% 到 20%。短块（200 token 的 FAQ）不需要重叠，重叠反而让两条问答混在一起。长块（1000 token 的技术文档）给 15% 左右，能救回被切断的句子。

### 示例三：上传接口，切完落 JSONL

真实场景是用户传文件，你切完入库。这一步用 Spring Boot 串起来。

```java
package com.example.rag;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.ai.document.Document;
import org.springframework.ai.reader.tika.TikaDocumentReader;
import org.springframework.core.io.PathResource;
import org.springframework.stereotype.Service;
import org.springframework.web.multipart.MultipartFile;

@Service
public class IngestionService {

    private final OverlapDocumentTransformer transformer;
    private final ObjectMapper objectMapper;
    private final Path outputDir;

    public IngestionService(ObjectMapper objectMapper) throws IOException {
        this.objectMapper = objectMapper;
        this.transformer = new OverlapDocumentTransformer(600, 120);
        this.outputDir = Path.of("ingest-out");
        Files.createDirectories(this.outputDir);
    }

    public Map<String, Object> ingest(MultipartFile file) throws IOException {
        String originalName = file.getOriginalFilename() == null ? "upload.bin" : file.getOriginalFilename();
        String safeName = originalName.replaceAll("[^a-zA-Z0-9._\\-\\u4e00-\\u9fa5]", "_");

        Path temp = Files.createTempFile("rag-", "-" + safeName);
        file.transferTo(temp);

        try {
            List<Document> raw = new TikaDocumentReader(new PathResource(temp)).get();
            List<Document> chunks = this.transformer.apply(raw);

            Path jsonl = this.outputDir.resolve(UUID.randomUUID() + ".jsonl");
            StringBuilder buffer = new StringBuilder();
            for (Document chunk : chunks) {
                Map<String, Object> metadata = new LinkedHashMap<>(chunk.getMetadata());
                metadata.put("source", originalName);
                metadata.put("ingested_at", Instant.now().toString());

                Map<String, Object> line = new LinkedHashMap<>();
                line.put("id", chunk.getId());
                line.put("text", chunk.getText());
                line.put("metadata", metadata);
                buffer.append(this.objectMapper.writeValueAsString(line)).append('\n');
            }
            Files.writeString(jsonl, buffer.toString(), StandardCharsets.UTF_8);

            Map<String, Object> report = new LinkedHashMap<>();
            report.put("source", originalName);
            report.put("characters", raw.stream()
                    .mapToInt(d -> d.getText() == null ? 0 : d.getText().length()).sum());
            report.put("chunks", chunks.size());
            report.put("file", jsonl.toAbsolutePath().toString());
            return report;
        } finally {
            Files.deleteIfExists(temp);
        }
    }
}
```

```java
package com.example.rag;

import java.io.IOException;
import java.util.Map;

import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;

@RestController
@RequestMapping("/api/ingest")
public class IngestController {

    private final IngestionService ingestionService;

    public IngestController(IngestionService ingestionService) {
        this.ingestionService = ingestionService;
    }

    @PostMapping
    public Map<String, Object> upload(@RequestParam("file") MultipartFile file) throws IOException {
        return this.ingestionService.ingest(file);
    }
}
```

再加一个启动类，整套就能跑：

```java
package com.example.rag;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class RagIngestApplication {

    public static void main(String[] args) {
        SpringApplication.run(RagIngestApplication.class, args);
    }
}
```

起服务，`curl -F "file=@手册.pdf" http://localhost:8080/api/ingest`，返回块数和落盘路径。JSONL 每行一块，`jq` 一看就清楚：

```bash
jq -r '.metadata | "\(.source) #\(.chunk_index)/\(.chunk_total)"' ingest-out/*.jsonl | head
```

落 JSONL 而不是直接写向量库，是有意为之：切块和向量化分开，你能先人工抽查几十块，确认没问题再灌。切块错了就去向量库删数据，成本高得多。

真要接向量库，`chunks` 这个 `List<Document>` 直接丢给你的向量库 `add(chunks)` 就行，不用改任何结构——metadata 会跟着进去，检索时能按源文件过滤，也能显示引用出处。

## 四、踩坑经验和最佳实践

**坑一：Tika 把表格读成一坨。** PDF 里的表格，Tika 抽出来是按行拼接的文本，列和列的关系全丢。「库存 120，价格 35」这种表，抽完可能变成「12035」糊在一起。表格多的文档，要么换解析器专门处理表格，要么在切块前把表格区域单独提出来，转成 Markdown 表格再进知识库。这个坑没有纯代码解，得看文档类型选工具。

**坑二：扫描件抽出来是空的。** Tika 只做文本抽取，不做 OCR。扫描版 PDF 抽完 `getText()` 返回空字符串，切块得到 0 块，你还以为入库成功了。上线前必须加校验：字符数为 0 直接拒绝并提示用户，别静默成功。

**坑三：页眉页脚重复进库。** 每页顶部的公司名、底部的页码，会被切成大量几乎一样的碎块。这些块向量高度相似，检索时互相挤占名额。用 `minChunkLengthToEmbed` 过滤掉太短的，或者在 Tika 层用 `ExtractedTextFormatter` 去掉每页前几行。

**坑四：metadata 的 source 变成临时文件名。** 前面代码里覆盖 `source` 就是为这个。不覆盖的话，用户点引用看到 `/tmp/rag-8382910-手册.pdf`，体验直接崩。

**坑五：中文标点不在回退列表里。** `TokenTextSplitter` 默认的标点是 `. ? ! \n`，全是英文的。中文文档里句号是「。」，它不认。所以中文文档经常在句子中间被硬切。解法是 `.withPunctuationMarks(List.of('。', '？', '！', '；', '\n'))`。这个细节不注意，中文知识库的块质量天生差一截。

**坑六：大文件超时。** 一个 200 页 PDF，Tika 解析加切块可能跑十几秒。同步接口会超时，尤其是经过网关。生产上要么改成异步任务返回 taskId，要么限制单文件大小。

最佳实践就四条：小块先体检再入库；中文一定换标点；每块必带 source 和位置信息；切块和向量化分两步，中间留人工抽查的口子。

## 五、性能对比和技术选型

四种切法，按落地成本从低到高排：

| 切法 | 块质量 | 成本 | 适用场景 |
|---|---|---|---|
| 固定字符数硬切 | 差 | 极低 | 几乎不推荐，只在文本无结构时兜底 |
| TokenTextSplitter | 中上 | 低 | 大多数文档，默认首选 |
| 按文档结构切（标题/条款） | 好 | 中 | 有清晰层级的规范、手册、合同 |
| 语义切块（按相似度找边界） | 好 | 高 | 长文、无结构叙述性内容 |

`TokenTextSplitter` 的性能不用太担心，它是纯 CPU 的 token 编解码，一个 300 页 PDF 切完通常在几百毫秒级别，瓶颈在 Tika 解析，不在切块。

语义切块的做法是：把文本按句子切碎，逐句算 embedding，相邻句子相似度骤降的地方就是边界。质量确实好，但一篇 5 万字的文档要算几千次 embedding，成本和延迟都上去了。我一般只在「文档没结构 + 回答质量要求高」时才上。

真正值得先做的不是换切法，而是**按结构切**。你的 PDF 有目录，Word 有标题样式，Markdown 有 `##`，这些都是天然的、免费的边界，比任何算法都准。`MarkdownDocumentReader` 和 `ParagraphPdfDocumentReader` 就是干这个的，前者按标题和分隔线切，后者按 PDF 目录切。文档有结构就用它们，别硬切。

一句话选型：有结构用结构，没结构用 TokenTextSplitter，实在不行再上语义切块。

## 六、总结

RAG 的效果上限，在文档进向量库那一刻就定了。切块是唯一一个「改动小、收益大、几乎零成本」的环节，也是最容易被跳过的一步。

记住几件事：向量是整段文本的一个点，块里混主题就必然模糊；`TokenTextSplitter` 按 token 切、按标点回退、不给重叠，中文还得自己换标点；块必须自带上下文和出处，否则检索不到、也溯源不了；切块和向量化分两步，中间留人工抽查的口子。

下次遇到答不准，先跑一遍体检脚本，看看你的块长什么样。大概率不用换模型。

文 / 会编程的吕洞宾

## 参考资料

- [Spring AI - ETL Pipeline](https://docs.spring.io/spring-ai/reference/api/etl-pipeline.html)
- [Apache Tika - Supported Document Formats](https://tika.apache.org/3.1.0/formats.html)
- [Anthropic - Introducing Contextual Retrieval](https://www.anthropic.com/news/contextual-retrieval)
- [spring-projects/spring-ai](https://github.com/spring-projects/spring-ai)
