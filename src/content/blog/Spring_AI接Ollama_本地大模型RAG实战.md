---
title: "Spring AI 接 Ollama，本地大模型 RAG 实战"
date: 2026-10-10T20:00:00+08:00
category: "AI"
tags: ["AI", "spring-ai", "rag", "ollama"]
---

> 公司想拿内部文档做问答机器人，可文档里躺着客户名单、报价单和合同条款，一条都不敢往外传。用云上的大模型 API，数据合规这关先过不去；自己从零搭一套，又不知道从哪儿下手。其实这事不用二选一：Ollama 能在一台普通开发机上把开源大模型跑起来，Spring AI 负责把 Java 应用接上去，再配一套本地 Embedding 加向量检索，一套完整的 RAG 就成型了。下面把这条路从头到尾走一遍，代码可直接跑。

## 一、这个问题到底是什么

先说结论：本地 RAG 就一句话——把大模型和知识库都留在自己机器上，只把检索出来的几段文字塞进提示词，交给模型生成答案。

RAG 全称检索增强生成（Retrieval-Augmented Generation）。说人话就是：大模型本身不知道你公司的制度、产品手册、工单记录，你也没必要为了让它知道就去微调一个模型。你只要在提问的时候，先把自己文档里最相关的几段找出来，连同问题一起丢给模型，它自然就能照着资料回答。

这个套路像开卷考试。模型是个记性不错但没背过你这本教材的考生，你不给它书它只能瞎编，你翻到对应的那一页递给它，它就能答得很准。RAG 干的就是"翻书"这件事。

那为什么非要放在本地？三个真实理由：

- **数据出不去。** 客户信息、合同、财务数据，很多行业连传到第三方云服务这一步都不允许。
- **钱。** 云 API 按 token 计费，文档问答一次要喂进去几千字的上下文，量一大账单很吓人。本地模型只花电费和硬盘。
- **可控。** 断网也能用，模型换哪个版本、参数怎么调，自己说了算。

落地到 Java 项目，本地化其实要解决两件事：一是**模型在本地跑**，这一步交给 Ollama；二是**向量检索在本地做**，这一步交给 Spring AI 的向量库。Spring AI 是 Spring 官方的大模型集成框架，它把调用大模型、做 Embedding、存向量、检索这一整套流程都封装成了 Java 开发者熟悉的 bean 和接口，不用自己拼 HTTP 请求。

这篇文章的目标很具体：用 Spring AI 接上本地 Ollama，写一个能问答内部文档的 RAG 服务，再给它加上工具调用能力。全程不需要联网调用任何云 API。

## 二、底层原理到底怎么回事

RAG 的完整流水线分两个阶段：写入阶段（把文档变成能检索的格式）和查询阶段（把问题变成答案）。两条线合起来是五步。

**写入阶段：**

1. **切块。** 把长文档切成一段一段的小块。为什么必须切？一是模型上下文窗口有上限，整本书塞不进去；二是检索需要"精准"，一大段混着好几个主题的文字，向量会变得模糊，切小了才能精确命中。
2. **转向量。** 每个小块交给 Embedding 模型，变成一串浮点数，也就是向量。
3. **存库。** 把向量连同原文一起存进向量库，并建立索引。

**查询阶段：**

4. **问题转向量。** 用户的问题用同一个 Embedding 模型也转成向量。
5. **找最近的块 + 生成。** 在向量库里找出跟问题向量最接近的几块原文，拼进提示词，交给对话模型生成答案。

这里最关键、也最容易困惑的是**Embedding 到底在干什么**。你可以把 Embedding 理解成给每段文字在一个高维空间里定一个"坐标"。意思相近的文字，坐标就离得近；意思差得远，坐标就离得远。比如"怎么退款"和"申请退货的流程"字面不一样，但坐标会挨得很近。这样一来，"找相关资料"就变成了一个纯数学问题：算哪个坐标离问题的坐标最近。最常用的距离算法是余弦相似度，衡量的是两个向量方向的夹角，夹角越小越相似。

**Ollama 是什么？** 它是一个在本地跑开源大模型的工具。你装上它，它会在 `11434` 端口起一个 HTTP 服务，对外提供 `/api/chat`（对话）、`/api/embeddings`（转向量）这些接口。Spring AI 的 Ollama starter 干的事，就是把这个 HTTP 接口包成 `ChatModel` 和 `EmbeddingModel` 两个标准 bean，你注入就能用，感觉不到 HTTP 的存在。

**这里有个新手最容易踩的坑：对话模型和 Embedding 模型是两个不同的模型。** 对话模型（比如 `qwen2.5:7b`）负责读懂上下文、生成回答；Embedding 模型（比如 `nomic-embed-text`）只负责把文字转成向量，它根本不会说话。很多人以为一个模型全包了，结果配置里只拉了对话模型，一到做向量就报错。这两个都要在 Ollama 里 `pull` 下来。

还有一个隐含约束：**写入和查询必须用同一个 Embedding 模型。** 如果入库用的是 A 模型，查询时换成了 B 模型，两套坐标不在一个空间里，检索结果全是乱的。这个错误不报异常，只是答案莫名其妙地不准，最容易被忽略。

## 三、实战：手把手写代码

### 环境准备

- JDK 21
- 本地装好 [Ollama](https://ollama.com/)

拉两个模型，一个对话、一个 Embedding：

```bash
# 对话模型，中文能力不错，7B 在 16G 内存的机器上能跑
ollama pull qwen2.5:7b

# Embedding 模型，负责把文字转向量
ollama pull nomic-embed-text

# 确认服务起来了，默认监听 11434
ollama serve
```

### pom.xml

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
    <artifactId>local-rag</artifactId>
    <version>1.0.0</version>

    <properties>
        <java.version>21</java.version>
        <spring-ai.version>2.0.1</spring-ai.version>
    </properties>

    <dependencyManagement>
        <dependencies>
            <dependency>
                <groupId>org.springframework.ai</groupId>
                <artifactId>spring-ai-bom</artifactId>
                <version>${spring-ai.version}</version>
                <type>pom</type>
                <scope>import</scope>
            </dependency>
        </dependencies>
    </dependencyManagement>

    <dependencies>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-web</artifactId>
            <version>4.1.1</version>
        </dependency>
        <dependency>
            <groupId>org.springframework.ai</groupId>
            <artifactId>spring-ai-starter-model-ollama</artifactId>
            <version>${spring-ai.version}</version>
        </dependency>
        <dependency>
            <groupId>org.springframework.ai</groupId>
            <artifactId>spring-ai-vector-store</artifactId>
            <version>${spring-ai.version}</version>
        </dependency>
    </dependencies>

    <build>
        <plugins>
            <plugin>
                <groupId>org.springframework.boot</groupId>
                <artifactId>spring-boot-maven-plugin</artifactId>
                <version>4.1.1</version>
            </plugin>
        </plugins>
    </build>
</project>
```

三个依赖各司其职：`spring-boot-starter-web` 提供 Web 接口；`spring-ai-starter-model-ollama` 把 Ollama 包成 `ChatModel` 和 `EmbeddingModel`；`spring-ai-vector-store` 提供内存版向量库 `SimpleVectorStore`。

### application.yml

```yaml
server:
  port: 8080

spring:
  ai:
    ollama:
      base-url: http://localhost:11434
      chat:
        options:
          model: qwen2.5:7b
          temperature: 0.7
      embedding:
        options:
          model: nomic-embed-text
```

`model` 指定用哪个模型，`temperature` 控制回答的随机性（0 最死板，1 最放飞）。Embedding 这边单独指定 `nomic-embed-text`，记住对话和向量是两套配置。

### 启动类

```java
package com.example.localrag;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class LocalRagApplication {

    public static void main(String[] args) {
        SpringApplication.run(LocalRagApplication.class, args);
    }
}
```

### 示例一：先跑通最简单的对话

别一上来就搞 RAG，先确认模型能通。`ChatClient` 是 Spring AI 对外的统一入口，用 builder 造出来就行。

```java
package com.example.localrag;

import org.springframework.ai.chat.client.ChatClient;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import reactor.core.publisher.Flux;

@RestController
@RequestMapping("/chat")
public class ChatController {

    private final ChatClient chatClient;

    // ChatClient.Builder 是 Spring AI 自动配好的，直接注入
    public ChatController(ChatClient.Builder builder) {
        this.chatClient = builder.build();
    }

    // 一次性返回完整回答
    @GetMapping("/ask")
    public String ask(@RequestParam String q) {
        return chatClient.prompt()
                .user(q)
                .call()
                .content();
    }

    // 流式返回，打字机效果
    @GetMapping(value = "/stream", produces = "text/event-stream")
    public Flux<String> stream(@RequestParam String q) {
        return chatClient.prompt()
                .user(q)
                .stream()
                .content();
    }
}
```

`prompt().user(q)` 组装一次请求，`call()` 是同步拿完整结果，`stream()` 是流式返回。启动后访问 `http://localhost:8080/chat/ask?q=你好` 能看到回复，说明 Ollama 这条链路已经打通。**第一次调用会明显变慢**，因为 Ollama 要把模型加载进内存，后面就快了，别以为是自己代码写错了。

### 示例二：本地 RAG，把文档变成问答

先注册向量库。`SimpleVectorStore` 是内存实现，数据放 JVM 内存里，适合先跑通流程；要持久化后面有办法。

```java
package com.example.localrag;

import org.springframework.ai.embedding.EmbeddingModel;
import org.springframework.ai.vectorstore.SimpleVectorStore;
import org.springframework.ai.vectorstore.VectorStore;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class RagConfig {

    // 用 Ollama 的 Embedding 模型造一个内存向量库
    @Bean
    public VectorStore vectorStore(EmbeddingModel embeddingModel) {
        return SimpleVectorStore.builder(embeddingModel).build();
    }
}
```

然后是核心服务：负责写入（切块 + 存库）和查询（检索 + 生成）。

```java
package com.example.localrag;

import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.document.Document;
import org.springframework.ai.vectorstore.SearchRequest;
import org.springframework.ai.vectorstore.VectorStore;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

@Service
public class RagService {

    private final VectorStore vectorStore;
    private final ChatClient chatClient;

    public RagService(VectorStore vectorStore, ChatClient.Builder builder) {
        this.vectorStore = vectorStore;
        // 用 defaultSystem 把规矩定死，减少模型自由发挥
        this.chatClient = builder
                .defaultSystem("你是公司内部文档助手，只根据提供的资料回答；资料里没有的信息，直接说不知道，不要编。")
                .build();
    }

    // 把长文本按空行切段，再按最大长度硬切，保证每块不太长
    public List<Document> chunk(String rawText, int maxLen) {
        List<Document> docs = new ArrayList<>();
        for (String para : rawText.split("\\n\\s*\\n")) {
            String text = para.strip();
            if (text.isEmpty()) {
                continue;
            }
            for (int i = 0; i < text.length(); i += maxLen) {
                String piece = text.substring(i, Math.min(i + maxLen, text.length()));
                docs.add(new Document(piece, Map.of("source", "internal")));
            }
        }
        return docs;
    }

    // 写入阶段：切块 + 存进向量库
    public int ingest(String rawText) {
        List<Document> chunks = chunk(rawText, 300);
        vectorStore.add(chunks);
        return chunks.size();
    }

    // 查询阶段：检索最相关的几块，拼进提示词再生成
    public String answer(String question) {
        List<Document> hits = vectorStore.similaritySearch(
                SearchRequest.builder().query(question).topK(4).build());

        String context = hits.stream()
                .map(Document::getText)
                .collect(Collectors.joining("\n---\n"));

        String prompt = """
                参考资料：
                %s

                问题：%s
                """.formatted(context, question);

        return chatClient.prompt().user(prompt).call().content();
    }
}
```

逐个说关键点：

- `chunk` 用空行切段再按 300 字硬切，是最朴素的切分方式，目的是让你看清"切块"这一步在干嘛。生产里可以换成带重叠的切分，避免一句话被从中间切断。
- `vectorStore.add(chunks)` 会自动调用 Embedding 模型把每块转成向量，你不用手动转。
- `SearchRequest.builder().query(question).topK(4)` 表示找 4 块最相关的。`topK` 是检索的块数，多了噪声大，少了可能漏掉关键内容，一般 3 到 5 起步。
- 拼提示词时用 `---` 分隔不同资料块，让模型清楚这是多段独立的材料。
- `defaultSystem` 里的"资料里没有就说不知道"很关键，它是压制幻觉的第一道防线。

最后把写入和查询暴露成 HTTP 接口：

```java
package com.example.localrag;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/rag")
public class RagController {

    private final RagService ragService;

    public RagController(RagService ragService) {
        this.ragService = ragService;
    }

    // 把文档灌进向量库
    @PostMapping("/ingest")
    public String ingest(@RequestBody String text) {
        int count = ragService.ingest(text);
        return "已写入 " + count + " 个片段";
    }

    // 基于已入库的文档提问
    @GetMapping("/ask")
    public String ask(@RequestParam String q) {
        return ragService.answer(q);
    }
}
```

先 `POST /rag/ingest` 发一段公司制度文本，再 `GET /rag/ask?q=年假有几天`，模型就会基于你灌进去的内容回答，而不是凭自己的记忆瞎说。

### 示例三：让本地模型调用工具

RAG 解决"模型不知道"的问题，工具调用（Tool Calling）解决"模型做不到"的问题——比如查数据库、调接口。你只要在方法上打 `@Tool` 注解，Spring AI 会自动把方法签名转成模型能看懂的工具描述。

```java
package com.example.localrag;

import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.tool.annotation.Tool;
import org.springframework.ai.tool.annotation.ToolParam;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

@RestController
@RequestMapping("/agent")
public class OrderAgentController {

    private final ChatClient chatClient;

    public OrderAgentController(ChatClient.Builder builder) {
        this.chatClient = builder
                .defaultSystem("你是订单客服。需要查询订单时调用工具，不要自己编造订单状态。")
                .defaultTools(new OrderTools())
                .build();
    }

    @GetMapping("/ask")
    public String ask(@RequestParam String q) {
        return chatClient.prompt().user(q).call().content();
    }

    // 工具类，里面的方法会被注册成模型可调用的工具
    public static class OrderTools {

        private static final Map<String, String> ORDERS = Map.of(
                "A1001", "已发货，预计明天到达",
                "A1002", "待付款，订单保留 30 分钟",
                "A1003", "已签收"
        );

        @Tool(description = "根据订单号查询订单的当前状态")
        public String queryOrderStatus(
                @ToolParam(description = "订单号，例如 A1001") String orderNo) {
            return ORDERS.getOrDefault(orderNo, "查无此订单，请核对单号");
        }
    }
}
```

`description` 是给模型看的"说明书"，写得越清楚，模型越知道什么时候该调这个工具。模型判断需要查订单时，会自己生成一次工具调用，Spring AI 执行你的方法、把结果回填给模型，再生成最终回答——这一整套循环你不用写，框架包了。

## 四、踩坑经验和最佳实践

**中文场景别用 `nomic-embed-text`。** 这个模型对英文友好，中文效果一般。中文知识库建议换成 `bge-m3`（`ollama pull bge-m3`），它是很不错的多语言 Embedding 模型。换模型后要**清空重建向量库**，因为新旧向量不在一个空间，混着用结果会乱。

**入库和查询的 Embedding 模型必须一致。** 前面提过，再强调一次：这个错误不报错，只是答得不准，排查起来最费劲。

**切块大小没有标准答案，但要先测。** 300 字对制度、FAQ 这类文本够用；技术文档段落长，可以放到 500 到 800。切太碎会丢失上下文，切太大则检索命中不精准。加上一点重叠（比如每块和上一块重叠 50 字）能明显减少"关键句被切断"的情况。

**`topK` 别贪大。** 有人觉得多塞几块资料更保险，其实不然。塞得越多，噪声越多，模型越容易被无关内容带偏，提示词还更贵。3 到 5 块通常是甜点区，不够再加。

**首调用慢是正常的。** Ollama 按需加载模型，第一次请求要几秒到十几秒。生产环境可以配一个预热请求，或者设 `OLLAMA_KEEP_ALIVE` 让模型常驻内存，避免每次冷启动。

**本地小模型的工具调用能力有限。** 7B 级别的模型做工具调用偶尔会调错参数、或者该调不调。模型描述写清楚、参数用 `@ToolParam` 标注类型和示例，能提升成功率；真要稳定，考虑换更大的模型。

**想持久化向量，`SimpleVectorStore` 支持存文件。** 它是内存实现，重启就没了。调 `save(File)` 写到磁盘、启动时 `load(File)` 读回来，就能克服重启丢数据。但并发和规模上去了，还是得换 Redis 或 Milvus 这类专业向量库。

**别忽略幻觉。** RAG 只能降低幻觉，不能消除。system prompt 里明确"资料里没有就说不知道"，加上检索质量把关，是两道最基本的闸门。

## 五、性能对比和技术选型

**本地模型 vs 云 API**，一句话：合规和数据敏感选本地，追求效果上限选云。

| 维度 | 本地 Ollama | 云 API |
| --- | --- | --- |
| 数据合规 | 数据不出机器，最安全 | 数据要出境，可能不合规 |
| 成本 | 一次性的电费 + 硬件 | 按 token 持续付费 |
| 效果 | 开源模型，7B 够用但不惊艳 | 顶级闭源模型，效果好 |
| 延迟 | 取决于本地显卡，首调用慢 | 网络 + 排队，通常稳定 |
| 运维 | 自己管模型和硬件 | 无 |

**Ollama 更适合谁？** 开发调试、中小规模、数据敏感场景，它上手最省事。要扛高并发，vLLM 这类专门做推理服务的方案吞吐更高，但部署复杂度也上去了。先用 Ollama 把业务跑通，规模真的顶不住再换。

**向量库怎么选？**

- **`SimpleVectorStore`**：内存实现，零依赖，开发和小数据量首选。
- **Redis**：如果项目本来就有 Redis，加个向量检索能力最省事，适合中等规模。
- **Milvus**：专门的向量数据库，百万级以上、要高可用和高性能时选它。

我的建议是**别一上来就上重型向量库**。用 `SimpleVectorStore` 把 RAG 流程和提示词调明白，等真的有性能压力，再按数据量替换成 Redis 或 Milvus，代码里注入的都是 `VectorStore` 接口，换实现基本只改一个 bean。

## 六、总结

本地 RAG 难的不是模型，是把"切块、转向量、检索、拼提示词"这条链路搭顺。Ollama 解决了模型在本地跑的问题，Spring AI 解决了 Java 应用怎么优雅接上去的问题，两者一拼，一个不联网、数据不出机器的文档问答服务就成了。

回顾几个必须记住的点：

- **对话模型和 Embedding 模型是两个模型**，都要拉下来，且入库查询必须用同一个。
- **切块大小、`topK` 都要实测**，别照抄别人的数字。
- **中文知识库优先选 `bge-m3` 这类多语言 Embedding 模型**，别拿英文模型硬套。
- **system prompt 里写明"不知道就说不知道"**，这是压幻觉最省事的办法。
- **向量库先用内存版跑通**，有压力再换 Redis / Milvus。

下一步可以做的事：给检索加上重排序（Rerank）提升命中率、把 `SimpleVectorStore` 换成 Redis 做持久化、再加一层对话记忆支持多轮追问。这三件事都能在现有的 `VectorStore` 和 `ChatClient` 上直接扩展，不用推翻重来。

## 参考资料

- [Ollama 官网](https://ollama.com/)
- [Spring AI - Ollama Chat](https://docs.spring.io/spring-ai/reference/api/chat/ollama-chat.html)
- [Spring AI - Ollama Embeddings](https://docs.spring.io/spring-ai/reference/api/embeddings/ollama-embeddings.html)
- [Spring AI - ChatClient](https://docs.spring.io/spring-ai/reference/api/chatclient.html)
- [Spring AI - Tool Calling](https://docs.spring.io/spring-ai/reference/api/tools.html)
- [Spring AI - Vector Databases](https://docs.spring.io/spring-ai/reference/api/vectordbs.html)

文 / 会编程的吕洞宾
