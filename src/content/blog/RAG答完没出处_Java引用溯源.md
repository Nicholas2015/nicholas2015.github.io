---
title: "RAG答完没出处？Java做引用溯源，句句可查"
date: 2026-10-24T20:00:00+08:00
category: "AI"
tags: ["AI", "rag"]
---

> 业务方看完 AI 的回答，第一句问的往往不是"对不对"，而是"哪来的"。你翻检索日志，能找到五段文档，可回答里没有一个字能跟它们对上号。更糟的是模型偶尔自己编一个文件名，格式还挺像真的。这篇讲怎么让 RAG 的每段回答都带上能点开验证的出处：入库时留元数据，生成时只许引用编号，返回前逐条校验。代码用 Spring AI 2.0 加 Java 21，照抄能跑。

## 一、这个问题到底是什么

**RAG 没有出处，等于把幻觉的举证责任甩给了用户。**

企业知识库落地时，回答准不准是一回事，能不能被核对是另一回事。前者靠模型能力，后者靠工程。大部分项目只做了前者。

三个典型现场：

- 答案是对的，但用户要验证，得自己再去搜一遍。搜到了还好，搜不到就开始怀疑你在胡说。
- 答案里写着"根据《XX 管理办法》第 12 条"，你去知识库一查，第 12 条讲的是报销，不是退款。这句话是模型顺手编的。
- 检索返回五段，模型只用了第一段，剩下四段是噪声还是支撑，没人知道。出了问题复盘，连"当时喂了什么"都还原不出来。

很多人第一反应是加一句提示词："请在回答末尾标注来源。" 这条路的成功率很低，原因不在提示词写得不好。

模型看到的上下文，是我们拼好的一坨纯文本。它知道这段话讲了什么，但不知道这段话来自哪个文件、第几节、什么版本。你让它标来源，它只有两个选择：一是把上下文里出现的标题抄一遍，二是根据内容猜一个像样的名字。第二种就是编造。

还有一种情况更隐蔽：上下文里确实带了文件名，模型也确实写了，但它把 A 文件的结论挂到了 B 文件名下。文字上看不出破绽，核对时才发现对不上。

所以问题的本质不是"模型不肯标来源"，是**来源信息在进入模型之前就已经丢了**。检索层只把文本交出去，元数据留在了自己手里。模型手上没有映射关系，你让它怎么标？

正确的做法是把"来源"变成一道选择题，而不是一道填空题。检索出五段，就编五个号，模型只能从 1 到 5 里挑，不能自己造名字。这跟开庭举证是一个道理：证据必须来自证据清单上的编号，不能当庭说"我记得有这么个文件"。

这里还有个容易忽略的细节：引用要定位到段落，不是整篇文档。一份 40 页的售后管理办法，告诉用户"看这个文件"等于没帮上忙。所以入库切分的时候，章节号、页码、段落序号这些字段必须跟着 chunk 一起存。切分粒度直接决定了引用的精度上限。

一句话收口：引用溯源 = 元数据治理 + 编号协议 + 后置校验。三层缺一层，出来的东西都不可信。

## 二、底层原理到底怎么回事

**引用能成立，靠的不是模型诚实，是编号和原文之间那条不可伪造的映射。**

整条链路分成四段，每段的责任很清楚：

```
入库：文档 → 切分 → chunk（正文 + 元数据）→ 向量化 → 向量库
查询：问题 → 检索 topK → 拼编号上下文 → 模型输出 JSON
校验：citations 越界丢弃 → 去重 → 回填原文片段
返回：answer + sources[] + grounded
```

**第一段，chunk 得有自己的身份证。**

一个 chunk 至少要带这些字段：文档 ID、标题、章节、原文链接、切片序号、更新时间。少一个，后面就有一环对不上。没有章节，引用只能到文档级；没有链接，用户点不过去；没有切片序号，同一节被切成两段时你分不清是哪一段。

这些字段在入库时写进 `metadata`，跟着向量一起存。检索命中时，它们原样回来。这一步做好，后面才有得谈。

**第二段，编号是本次请求的局部编号。**

注意，编号不是数据库主键，也不是文档 ID。它是这次检索结果里的临时序号，从 1 开始，只在这一个请求里有效。

为什么不用全局 ID？因为全局 ID 通常又长又乱，像 `doc_7f3a9c21_chunk_004`。让模型原样抄一串十六进制，出错率高得离谱，而且错了你很难判断它是抄错还是编的。用 1、2、3 这种短数字，模型几乎不会写错；就算写错，越界检查一秒钟就能发现。

编号是局部的，还顺带解决了跨请求串号的问题。A 用户问退款，编号 3 是退款政策；B 用户问发票，编号 3 是发票规定。各自独立，互不干扰。

**第三段，把"只能选不能造"写进输出格式。**

上下文拼成这个样子再交给模型：

```
[1] 售后服务管理办法 / 第 12 条 退款时效
退款申请审核通过后，原路退回，银行卡 1-3 个工作日到账……

[2] 售后服务管理办法 / 第 13 条 退款异常
超过 7 个工作日未到账，需提交支付流水号……
```

系统提示词只干三件事：只用编号资料回答、每条结论必须有编号、资料不足就说不知道。

输出不让它写自然语言里的 `[1]`，而是要求一个 JSON 对象：

```json
{"answer": "退款审核通过后 1-3 个工作日到账。", "citations": [1]}
```

这一步是整个方案的关键。自然语言里的方括号是开放文本，正文里出现数组下标、代码片段、数学区间，都可能被正则误抓。JSON 的 `citations` 字段是闭集，类型是整数数组，解析器只认这个字段，误判空间小得多。用 Spring AI 的 `entity()` 把这段 JSON 直接映射成 Java record，连解析代码都不用写。

**第四段，校验器不相信模型。**

模型返回 `[1, 7]`，而这次只检索出 5 段，7 就是无效编号，直接丢掉。返回 `[2, 2, 2]`，去重成一个。返回空数组，说明它找不到支撑，这时候答案再自信也不能当成有据可查。

校验通过之后，用编号回到原始 `Document`，把标题、章节、链接、原文片段一起拼进响应。前端拿到的 `sources` 里，`snippet` 是原文截出来的，不是模型复述的。这一点很重要：模型可以撒谎说自己引用了第 3 条，但它没法让第 3 条指向一段不存在的原文。

这就是"把信任模型换成信任映射"。模型依然可能理解错、总结错，但至少它引用的每一句，你都能点开看到原文，自己判断对不对。RAG 的价值本来就不是让模型永远正确，是让错误变得容易被发现。

**代价也说清楚。**

上下文里加了编号和元数据，prompt 会变长一点。topK 开大，长得多。要求模型给引用，它会更保守，有些时候直接回"资料不足"。这不是 bug，是你要的行为——宁可少答，也别瞎答。

流式输出这里有个硬约束：JSON 没生成完，你没法校验，也就没法边流边给用户看。知识库问答这种场景，我建议直接走非流式。首字延迟换可验证性，这笔账划算。真要做打字机效果，只能在流结束后补一个引用区块，中间那段"裸答案"仍然不可信。

## 三、实战：手把手写代码

**能跑通的引用溯源，代码上只有三件事：带元数据的 chunk、编号化的上下文、拿到结果后的校验。** 下面按依赖、配置、入库、服务、接口的顺序铺开，每一段都能单独跑。

先看依赖。两个 Spring AI 坐标就够：一个接模型，一个提供内存向量库和检索请求对象。

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
    <artifactId>rag-citation</artifactId>
    <version>0.0.1-SNAPSHOT</version>

    <properties>
        <java.version>21</java.version>
    </properties>

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
            <artifactId>spring-ai-vector-store</artifactId>
            <version>2.0.2</version>
        </dependency>

        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-test</artifactId>
            <version>4.1.2</version>
            <scope>test</scope>
        </dependency>
    </dependencies>
</project>
```

没有引 BOM，所以每个坐标都写死版本，你搬到自己的项目里也不会被别的 BOM 悄悄改掉。

配置文件里三件事：模型地址、聊天模型、向量模型。`base-url` 可以指向任何 OpenAI 兼容服务，比如阿里的兼容模式地址是 `https://dashscope.aliyuncs.com/compatible-mode`。密钥走环境变量，别写进仓库。

```yaml
server:
  port: 8080

spring:
  ai:
    openai:
      api-key: ${OPENAI_API_KEY}
      base-url: ${OPENAI_BASE_URL:https://api.openai.com}
      chat:
        options:
          model: ${CHAT_MODEL:gpt-4o-mini}
          temperature: 0.2
      embedding:
        options:
          model: ${EMBEDDING_MODEL:text-embedding-3-small}

app:
  rag:
    top-k: 5
    similarity-threshold: 0.55
```

温度调到 0.2，是因为这个任务偏抽取和归纳，不需要发挥。创意写作才需要高温。

启动类没什么花头：

```java
package com.example.ragcite;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class RagCitationApplication {

    public static void main(String[] args) {
        SpringApplication.run(RagCitationApplication.class, args);
    }
}
```

接下来是知识库。示例用内存向量库，省掉装 Redis 或 Milvus 的步骤；检索接口是同一个，生产环境换成 `RedisVectorStore` 或 `MilvusVectorStore`，下面的业务代码一行都不用改。

重点看 `demoDocuments()` 里的元数据：`docId`、`title`、`section`、`url`、`chunkIndex`。这五个字段就是后面引用的全部素材，缺一个，前端展示就会缺一块。

```java
package com.example.ragcite.config;

import java.util.List;
import java.util.Map;

import org.springframework.ai.document.Document;
import org.springframework.ai.embedding.EmbeddingModel;
import org.springframework.ai.vectorstore.SimpleVectorStore;
import org.springframework.ai.vectorstore.VectorStore;
import org.springframework.boot.CommandLineRunner;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class KnowledgeBaseConfig {

    @Bean
    public VectorStore vectorStore(EmbeddingModel embeddingModel) {
        return SimpleVectorStore.builder(embeddingModel).build();
    }

    @Bean
    public CommandLineRunner loadDemoDocuments(VectorStore vectorStore) {
        return args -> vectorStore.add(demoDocuments());
    }

    private List<Document> demoDocuments() {
        return List.of(
                new Document("""
                        退款申请审核通过后，款项按原支付路径退回。
                        银行卡支付一般 1-3 个工作日到账，第三方支付一般 1-2 个工作日到账。
                        到账时间以银行或支付机构实际处理为准。""",
                        Map.of(
                                "docId", "policy-2026-03",
                                "title", "售后服务管理办法",
                                "section", "第 12 条 退款时效",
                                "url", "https://intranet.example.com/docs/policy-2026-03#s12",
                                "chunkIndex", 3)),
                new Document("""
                        超过 7 个工作日仍未到账的退款，视为异常单。
                        用户需提供支付流水号，客服在工单系统提交查询，
                        财务在 2 个工作日内反馈银行侧处理结果。""",
                        Map.of(
                                "docId", "policy-2026-03",
                                "title", "售后服务管理办法",
                                "section", "第 13 条 退款异常处理",
                                "url", "https://intranet.example.com/docs/policy-2026-03#s13",
                                "chunkIndex", 4)),
                new Document("""
                        电子发票在订单完成后 24 小时内自动开具，可在订单详情页下载。
                        纸质发票需在下单时勾选，随货寄出，不支持补开。
                        发票抬头填写错误的，需在开具后 30 天内申请重开。""",
                        Map.of(
                                "docId", "finance-2026-01",
                                "title", "发票管理规范",
                                "section", "第 3 条 开票时限",
                                "url", "https://intranet.example.com/docs/finance-2026-01#s3",
                                "chunkIndex", 1)));
    }
}
```

示例数据启动时无条件加载，因为内存库重启就没了。真实项目里这段换成你的入库任务：从数据库或对象存储读文档，切分，写元数据，再 `add`。切分粒度建议按章节走，一章太长再按段落切，别按固定字数硬切，切断了条款会很难看。

下面三个 record 是数据传输的骨架。`CitationDraft` 接模型的输出，`CitedAnswer` 和 `Source` 是对外的响应。分开定义的好处是，模型给什么、你返回什么，边界清清楚楚。

```java
// CitationDraft.java
package com.example.ragcite.service;

import java.util.List;

public record CitationDraft(String answer, List<Integer> citations) {
}
```

```java
// CitedAnswer.java
package com.example.ragcite.service;

import java.util.List;

public record CitedAnswer(String answer, List<Source> sources, boolean grounded) {
}
```

```java
// Source.java
package com.example.ragcite.service;

public record Source(int index, String title, String section, String url, String snippet) {
}
```

核心服务在这里。注意三处细节：上下文用字符串拼接，不走模板引擎；`citations` 是整数数组；校验时先过滤越界再去重。

```java
package com.example.ragcite.service;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.stream.Collectors;

import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.model.ChatModel;
import org.springframework.ai.document.Document;
import org.springframework.ai.vectorstore.SearchRequest;
import org.springframework.ai.vectorstore.VectorStore;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

@Service
public class CitationService {

    private static final String SYSTEM_PROMPT = """
            你是企业知识库问答助手，必须遵守以下规则：
            1. 只使用用户消息中带编号的资料回答，不得使用资料之外的知识。
            2. 每条结论都必须能对应到至少一个编号，编号只能取自资料中出现过的数字。
            3. 不要编造文件名、条款号或链接，来源只通过 citations 字段给出编号。
            4. 资料不足以回答时，直接说明“现有资料无法回答这个问题”，citations 返回空数组。
            """;

    private final ChatClient chatClient;
    private final VectorStore vectorStore;
    private final int topK;
    private final double similarityThreshold;

    public CitationService(ChatModel chatModel,
                           VectorStore vectorStore,
                           @Value("${app.rag.top-k:5}") int topK,
                           @Value("${app.rag.similarity-threshold:0.55}") double similarityThreshold) {
        this.chatClient = ChatClient.builder(chatModel)
                .defaultSystem(SYSTEM_PROMPT)
                .build();
        this.vectorStore = vectorStore;
        this.topK = topK;
        this.similarityThreshold = similarityThreshold;
    }

    public CitedAnswer ask(String question) {
        List<Document> hits = vectorStore.similaritySearch(SearchRequest.builder()
                .query(question)
                .topK(topK)
                .similarityThreshold(similarityThreshold)
                .build());

        if (hits == null || hits.isEmpty()) {
            return new CitedAnswer("知识库里没有检索到相关资料。", List.of(), false);
        }

        String userMessage = "资料如下：\n" + buildContext(hits) + "\n问题：" + question;

        CitationDraft draft = chatClient.prompt()
                .user(userMessage)
                .call()
                .entity(CitationDraft.class);

        if (draft == null || draft.answer() == null || draft.answer().isBlank()) {
            return new CitedAnswer("模型没有返回有效答案。", List.of(), false);
        }

        List<Source> sources = resolveSources(draft.citations(), hits);
        boolean grounded = !sources.isEmpty();
        String answer = grounded
                ? draft.answer()
                : draft.answer() + "\n\n（提示：本次回答没有找到可核对的出处，请谨慎采用。）";

        return new CitedAnswer(answer, sources, grounded);
    }

    private String buildContext(List<Document> hits) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < hits.size(); i++) {
            Document doc = hits.get(i);
            sb.append('[').append(i + 1).append("] ")
              .append(meta(doc, "title")).append(" / ")
              .append(meta(doc, "section")).append('\n')
              .append(doc.getText().strip()).append("\n\n");
        }
        return sb.toString();
    }

    private List<Source> resolveSources(List<Integer> citations, List<Document> hits) {
        if (citations == null || citations.isEmpty()) {
            return List.of();
        }

        Set<Integer> valid = citations.stream()
                .filter(n -> n != null && n >= 1 && n <= hits.size())
                .collect(Collectors.toCollection(LinkedHashSet::new));

        List<Source> sources = new ArrayList<>();
        for (Integer index : valid) {
            Document doc = hits.get(index - 1);
            sources.add(new Source(
                    index,
                    meta(doc, "title"),
                    meta(doc, "section"),
                    meta(doc, "url"),
                    snippet(doc.getText())));
        }
        return sources;
    }

    private String meta(Document doc, String key) {
        Object value = doc.getMetadata().get(key);
        return value == null ? "未标注" : value.toString();
    }

    private String snippet(String text) {
        String flat = text.replaceAll("\\s+", " ").strip();
        return flat.length() <= 120 ? flat : flat.substring(0, 120) + "…";
    }
}
```

`buildContext` 里为什么不用 `PromptTemplate`？因为文档正文里可能出现花括号，比如代码示例、JSON 片段、`${}` 占位符，模板引擎会把它们当变量解析，直接抛异常或者悄悄替换成空。拼接字符串最笨，也最稳。要用模板的话，把正文当参数传，别拼进模板本身。

`meta` 兜底返回"未标注"，是为了让缺字段的脏数据还能跑完流程，而不是空指针炸在线上。日志里最好把这个情况记一笔，回头补数据。

`resolveSources` 的顺序很关键：先按范围过滤，再用 `LinkedHashSet` 去重并保留模型给出的顺序。如果你先去重再过滤，无效编号会占位，返回的引用数量对不上。

最后是一个接口，把问题递进去，把带引用的结果吐出来：

```java
package com.example.ragcite.web;

import com.example.ragcite.service.CitationService;
import com.example.ragcite.service.CitedAnswer;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

@RestController
@RequestMapping("/api/rag")
public class AskController {

    private final CitationService citationService;

    public AskController(CitationService citationService) {
        this.citationService = citationService;
    }

    @PostMapping("/ask")
    public CitedAnswer ask(@RequestBody AskRequest request) {
        if (request == null || request.question() == null || request.question().isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "question 不能为空");
        }
        return citationService.ask(request.question());
    }

    public record AskRequest(String question) {
    }
}
```

跑起来，问一句"退款多久到账"：

```bash
export OPENAI_API_KEY=sk-你的密钥
export OPENAI_BASE_URL=https://api.openai.com
mvn spring-boot:run
```

```bash
curl -s http://localhost:8080/api/rag/ask \
  -H 'Content-Type: application/json' \
  -d '{"question":"退款审核通过后多久到账？"}'
```

返回大致长这样：

```json
{
  "answer": "退款审核通过后按原支付路径退回，银行卡一般 1-3 个工作日到账，第三方支付一般 1-2 个工作日到账。",
  "sources": [
    {
      "index": 1,
      "title": "售后服务管理办法",
      "section": "第 12 条 退款时效",
      "url": "https://intranet.example.com/docs/policy-2026-03#s12",
      "snippet": "退款申请审核通过后，款项按原支付路径退回。银行卡支付一般 1-3 个工作日到账……"
    }
  ],
  "grounded": true
}
```

`index` 是给人看的编号，`url` 带锚点能直接跳到条款，`snippet` 是原文截的。前端把 `sources` 渲染成卡片，用户点一下就能核对。

## 四、踩坑经验和最佳实践

**引用做不准，八成不是模型的问题，是元数据缺了或者编号协议没定死。**

**元数据只存了文件名。** 这是最常见的一种。引用只能显示"售后服务管理办法"，用户还得自己在 40 页里翻。把标题路径拼进 `section` 字段，比如"第 3 章 > 第 12 条 > 退款时效"，展示效果立刻不一样。有页码的 PDF 再加一个 `page` 字段。

**topK 越调越大。** 召回不够就加 topK，加到 20，编号一多，模型开始乱点，prompt 也翻倍。5 到 8 段足够。真召回不够，去改切分策略、加混合检索、加 rerank，别在 topK 上硬顶。

**上下文里混进了花括号。** 用模板引擎拼上下文，文档里一段 JSON 示例就能让请求挂掉。要么纯字符串拼接，要么把正文作为变量传入，模板本身只留一个占位符。

**引用格式两套标准。** 提示词里写"用 [1] 标注"，前端却按"【1】"解析，用户看到一堆原始符号。用 JSON 字段就绕开了这个问题，展示层爱怎么渲染怎么渲染。

**流式输出硬套引用。** 结构化 JSON 不完整就没法校验，边流边显示等于把没验证的内容先给用户看了。知识库问答走非流式，这个取舍我建议早点定。

**缓存把旧引用带出来。** 语义缓存命中会原样返回上次的 `sources`，文档更新后链接可能已经失效。缓存 key 里带上索引版本号，或者文档的 `updatedAt` 水位，文档一更新就整批失效。

**多租户过滤交给模型。** 提示词写"只回答 A 客户的内容"是没用的，检索阶段不过滤，B 客户的文档照样进上下文，模型看到就会用。过滤条件必须写进 `SearchRequest` 的 `filterExpression`，在向量库那层拦掉。

**`grounded=false` 当成异常。** 它不是错误，是正常状态。资料不足时返回它，前端提示"未找到依据"，比硬编一个答案强得多。监控上可以统计这个比例，比例突然升高，说明知识库该补内容了。

## 五、性能对比和技术选型

**结构化引用不增加模型调用次数，增加的是上下文长度和一次本地解析。**

| 方案 | 延迟 | 可验证性 | 适用场景 |
|---|---|---|---|
| 纯文本回答 | 最低 | 无 | 闲聊、创意、摘要 |
| 回答里嵌 `[1]` 文本 | 低 | 弱，正则易误抓 | 展示型问答 |
| JSON + 编号校验 | 略高，多一次序列化 | 强 | 企业知识库、客服、法务 |
| 二次 LLM 审核引用 | 翻倍 | 最强，但会引入新幻觉 | 高合规场景，慎用 |

延迟这块说句实话：多出来的开销主要在 prompt 变长。topK=5、每段 300 字，上下文大概 1500 到 2000 字，编号和标题只占几十个 token，对总成本的影响远小于把 topK 翻倍。JSON 解析在本地做，毫秒级，可以忽略。

真正拖慢的是"二次 LLM 审核"那条路。再调一次模型去判断"这段引用是否支撑这个结论"，听起来严谨，实际上引入了第二个可能出错的环节，成本还翻倍。除非是合同、医疗这类必须双人复核的场景，我不推荐。

选型上我的立场很明确：**默认走 JSON + 编号校验**。它不是最准的，但它是性价比最高、最容易落地、出问题最容易定位的。引用错了，你看一眼 `sources` 就知道是检索错了还是模型选错了，这个可调试性比多零点几个点的准确率值钱。

## 六、总结

引用溯源不是给答案加个脚注，是把"信模型"换成"信映射"。

三件事做到位，这套东西就能用：入库时把 `docId`、`title`、`section`、`url`、`chunkIndex` 写进元数据；生成时只给编号，不给文件名；返回前用编号回到原文，越界就丢，空引用就标 `grounded=false`。

模型依然会理解错，依然会总结偏。但用户现在有能力自己发现，而不是只能选择信或不信。这个差别，决定了你的知识库能不能过业务方那一关。

别指望一句"请标注来源"的提示词能解决。来源是工程问题，不是语言问题。工程问题就得用工程手段解决：把来源写进数据，把约束写进格式，把校验写进代码。三步都落地，引用才是真的，不是看起来像真的。

## 参考资料

- [ChatClient](https://docs.spring.io/spring-ai/reference/api/chatclient.html)
- [Vector Databases](https://docs.spring.io/spring-ai/reference/api/vectordbs.html)
- [Structured Output Converters](https://docs.spring.io/spring-ai/reference/api/structured-output/converters.html)

文 / 会编程的吕洞宾
