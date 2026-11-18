---
title: "Spring AI Advisors：别再手写RAG和记忆"
date: 2026-10-06T20:00:00+08:00
category: "AI"
tags: ["AI", "spring-ai", "rag"]
---

*摘要：Spring AI 2.0 的 Advisor 把 RAG 检索、对话记忆、敏感词拦截、Token 成本统计这些"每次都要重复写的代码"变成一条可复用的拦截器链。本文用可运行代码讲清链条原理、order 顺序规则和实战写法。*

> 你的 AI 接口是不是长这样：先拿用户问题去向量库捞资料，把资料拼进提示词，再从存储里翻出这个人的聊天记录一起塞进去，调完模型把回答存回去，最后再统计一次 token 花了多少钱。这套动作写在一个 Controller 里还好，可写到第五个接口时，你已经在复制粘贴同一坨代码了。
>
> Spring AI 2.0 给了个正经解法：Advisor（顾问）。你可以把它理解成 AI 调用版的拦截器——请求和响应都从它身上过，你只管把"检索""记忆""记账"这些通用逻辑挂上去一次，之后所有 AI 调用自动生效。

## 一、这个问题到底是什么

先说清楚它到底解决什么。

假设你有一个客服机器人，每次调用模型前要做四件事：检索知识库、加载这个用户的对话历史、调用模型、保存这轮对话并记录 token 消耗。

不用 Advisor 的时候，代码大概长这样（这是反面教材，别照着写）：

```java
package com.example.aiadvisor.legacy;

import java.util.List;
import java.util.stream.Collectors;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.memory.ChatMemory;
import org.springframework.ai.chat.messages.UserMessage;
import org.springframework.ai.chat.model.ChatModel;
import org.springframework.ai.chat.model.ChatResponse;
import org.springframework.ai.chat.prompt.Prompt;
import org.springframework.ai.document.Document;
import org.springframework.ai.vectorstore.SearchRequest;
import org.springframework.ai.vectorstore.VectorStore;
import org.springframework.stereotype.Service;

/**
 * 反面教材：业务代码里手写检索、拼提示词、存历史、记账。
 */
@Service
public class LegacyChatService {

    private static final Logger log = LoggerFactory.getLogger(LegacyChatService.class);

    private final ChatModel chatModel;

    private final VectorStore vectorStore;

    private final ChatMemory chatMemory;

    public LegacyChatService(ChatModel chatModel, VectorStore vectorStore, ChatMemory chatMemory) {
        this.chatModel = chatModel;
        this.vectorStore = vectorStore;
        this.chatMemory = chatMemory;
    }

    public String chat(String userId, String question) {
        // 1. 检索相关资料
        List<Document> docs = vectorStore.similaritySearch(
                SearchRequest.builder().query(question).topK(4).build());
        String context = docs.stream().map(Document::getText).collect(Collectors.joining("\n"));

        // 2. 把检索资料和历史记录拼进提示词
        String history = chatMemory.get(userId).toString();
        String prompt = "参考资料：\n" + context + "\n\n历史对话：\n" + history + "\n\n问题：" + question;

        // 3. 调模型
        ChatResponse response = chatModel.call(new Prompt(prompt));

        // 4. 存历史 + 记账
        chatMemory.add(userId, new UserMessage(question));
        log.info("本次消耗 token：{}", response.getMetadata().getUsage().getTotalTokens());

        return response.getResult().getOutput().getText();
    }
}
```

问题在哪儿？

- **每个接口都要复制一遍**。客服接口、文档问答接口、代码助手接口，三个接口三份几乎一样的代码。
- **顺序不能错，但没人拦着你错**。历史必须和检索结果一起进提示词，位置放错模型就开始胡说，编译器不会提醒你。
- **改一处要动好几处**。老板要求"所有 AI 调用都加敏感词过滤"，你就得挨个接口加一遍。

Advisor 的思路，就是把这些通用逻辑从业务代码里抽出来，做成一个个独立的小零件，再用一条链串起来。

分工是这样的：

| 关注点 | 放哪儿 |
|---|---|
| 业务逻辑（这个用户问了什么、该怎么答） | Service |
| 检索、记忆、日志、拦截、成本统计 | Advisor |

一句话：**业务代码只管"问什么"，Advisor 管"怎么问、怎么处理返回"。**

## 二、底层原理到底怎么回事

Advisor 的核心就两个接口，先把它们认全。

### 两个接口，对应两种调用方式

- `CallAdvisor`：管**非流式**调用（`chatClient.call()`），只有一个方法 `adviseCall(request, chain)`
- `StreamAdvisor`：管**流式**调用（`chatClient.stream()`），方法是 `adviseStream(request, chain)`
- `BaseAdvisor`：同时实现上面两个，并帮你把公共逻辑抽成 `before()` 和 `after()`

大多数自定义 Advisor 直接实现 `BaseAdvisor` 就够了，代码看着最清爽：

```java
public interface BaseAdvisor extends CallAdvisor, StreamAdvisor {

    // 请求经过时执行（从外往里走）
    ChatClientRequest before(ChatClientRequest request, AdvisorChain chain);

    // 响应回来时执行（从里往外走）
    ChatClientResponse after(ChatClientResponse response, AdvisorChain chain);
}
```

### 链条其实是"洋葱"，不是"流水线"

这是最容易搞反的地方。多个 Advisor 排在一起时，**order 越小越靠外**。

假设有三个 Advisor：A（order = -100）、B（order = 0）、C（order = 100），请求和响应的真实路径是：

```
请求方向 ─────────────────────────────►
A(-100) → B(0) → C(100) → [框架自带] → 模型
◄───────────────────────────── 响应方向
A ◄─────── B ◄─────── C ◄──── [框架自带] ◄── 模型
```

- order 小的：**请求先进，响应后出**（最外层）
- order 大的：**请求后进，响应先出**（最内层）
- 链条最里面那个框架自带的 Advisor（`ChatModelCallAdvisor`），才是真正把请求发给模型的人

为什么会这样？因为 `BaseAdvisor` 的默认实现就是标准的洋葱模型：

```java
default ChatClientResponse adviseCall(ChatClientRequest request, CallAdvisorChain chain) {
    ChatClientRequest processed = before(request, chain);      // 进来时干活
    ChatClientResponse response = chain.nextCall(processed);   // 交给链条的下一环
    return after(response, chain);                             // 出去时干活
}
```

这说明一件事：**你的 Advisor 必须调用 `chain.nextCall(...)`，链条才会继续往下走。** 不想让它往下走？那就干脆别调，自己造一个响应返回——这正是"敏感词拦截"的实现方式。

### 请求和响应里装了什么

`ChatClientRequest` 是个 record，两个字段：

- `prompt`：真正要发给模型的内容（系统提示词、历史消息、用户消息都在这儿）
- `context`：一个 `Map<String, Object>`，**贯穿整条链的共享状态**

`context` 是 Advisor 之间传话的暗号本。举两个真实例子：

- 对话记忆 Advisor 从 context 里读 `ChatMemory.CONVERSATION_ID`（常量值是 `chat_memory_conversation_id`），用它判断"这是哪个用户的会话"
- RAG Advisor 检索完，把文档塞进 context 的 `rag_document_context`，同时挂到响应 metadata 里，方便你事后查"这次回答到底引用了哪些资料"

`ChatClientResponse` 同理，装着 `chatResponse`（模型的回答）和 `context`。

### 官方自带的 Advisor 有哪些

不用什么都自己写，下面这些是框架送的：

| Advisor | 干什么 | 默认 order |
|---|---|---|
| `SafeGuardAdvisor` | 用户输入命中敏感词就直接拦截，压根不调模型 | 0 |
| `MessageChatMemoryAdvisor` | 读写对话记忆，把历史消息拼进 prompt | `Advisor.DEFAULT_CHAT_MEMORY_PRECEDENCE_ORDER` |
| `RetrievalAugmentationAdvisor` | 完整 RAG 流程：检索 → 拼接 → 增强提问 | 0 |
| `SimpleLoggerAdvisor` | 打印请求和响应，排查问题用 | 0 |

有个细节值得注意：`MessageChatMemoryAdvisor` 的默认 order 是 `Ordered.HIGHEST_PRECEDENCE + 200`，比框架内部的工具调用 Advisor 更靠外。为什么？因为记忆必须包住整个"工具调用循环"，否则模型调工具产生的一堆中间消息就记不全了。这个顺序是框架作者精心排的，你自己写 Advisor 时别乱插队。

### 注册方式

两种粒度，全局和单次：

```java
// 全局默认：这个 ChatClient 的所有调用都带上
ChatClient client = ChatClient.builder(chatModel)
        .defaultAdvisors(new SafeGuardAdvisor(List.of("越狱")))
        .build();

// 单次调用：只给这一次传参（比如指定会话 ID、检索过滤条件）
client.prompt()
        .user("你好")
        .advisors(a -> a.param(ChatMemory.CONVERSATION_ID, userId))
        .call()
        .content();
```

## 三、实战：手把手写代码

下面三个例子串起来就是一个能跑的完整项目。

### 3.1 依赖（pom.xml）

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
    <artifactId>ai-advisor-demo</artifactId>
    <version>0.0.1-SNAPSHOT</version>

    <properties>
        <java.version>21</java.version>
        <spring-ai.version>2.0.1</spring-ai.version>
    </properties>

    <dependencies>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-web</artifactId>
        </dependency>

        <dependency>
            <groupId>org.springframework.ai</groupId>
            <artifactId>spring-ai-starter-model-openai</artifactId>
            <version>${spring-ai.version}</version>
        </dependency>

        <dependency>
            <groupId>org.springframework.ai</groupId>
            <artifactId>spring-ai-rag</artifactId>
            <version>${spring-ai.version}</version>
        </dependency>

        <dependency>
            <groupId>org.springframework.ai</groupId>
            <artifactId>spring-ai-vector-store</artifactId>
            <version>${spring-ai.version}</version>
        </dependency>
    </dependencies>
</project>
```

三个依赖分工明确：`spring-ai-starter-model-openai` 负责接大模型，`spring-ai-rag` 是 RAG 那套 Advisor 和检索器，`spring-ai-vector-store` 里有内存版向量库 `SimpleVectorStore`，方便本地跑通。

`application.yml` 里配一下模型 key：

```yaml
spring:
  ai:
    openai:
      api-key: ${OPENAI_API_KEY}
      chat:
        options:
          model: gpt-4o-mini
```

### 3.2 自定义 Advisor：统计 Token 和花销

这是最实用的自定义 Advisor——给每次 AI 调用记账。

```java
package com.example.aiadvisor.advisor;

import java.util.concurrent.atomic.AtomicLong;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.client.ChatClientRequest;
import org.springframework.ai.chat.client.ChatClientResponse;
import org.springframework.ai.chat.client.advisor.api.AdvisorChain;
import org.springframework.ai.chat.client.advisor.api.BaseAdvisor;
import org.springframework.ai.chat.metadata.Usage;
import org.springframework.ai.chat.model.ChatResponse;

/**
 * 统计每次 AI 调用的 token 消耗并换算成钱。
 * order 越大越靠近模型，越小越靠近业务代码。
 */
public class TokenCostAdvisor implements BaseAdvisor {

    private static final Logger log = LoggerFactory.getLogger(TokenCostAdvisor.class);

    private final int order;

    // 示例单价：每 100 万 token 多少钱（换成你自己的账单价格）
    private final double promptPricePerMillion;

    private final double completionPricePerMillion;

    private final AtomicLong totalPromptTokens = new AtomicLong();

    private final AtomicLong totalCompletionTokens = new AtomicLong();

    public TokenCostAdvisor(int order) {
        this(order, 0.15, 0.60);
    }

    public TokenCostAdvisor(int order, double promptPricePerMillion, double completionPricePerMillion) {
        this.order = order;
        this.promptPricePerMillion = promptPricePerMillion;
        this.completionPricePerMillion = completionPricePerMillion;
    }

    @Override
    public ChatClientRequest before(ChatClientRequest request, AdvisorChain chain) {
        // 请求侧不改任何东西，直接放行给链条的下一环
        return request;
    }

    @Override
    public ChatClientResponse after(ChatClientResponse response, AdvisorChain chain) {
        ChatResponse chatResponse = response.chatResponse();
        if (chatResponse == null) {
            return response;
        }
        Usage usage = chatResponse.getMetadata().getUsage();
        int promptTokens = usage.getPromptTokens() == null ? 0 : usage.getPromptTokens();
        int completionTokens = usage.getCompletionTokens() == null ? 0 : usage.getCompletionTokens();

        double cost = promptTokens / 1_000_000d * promptPricePerMillion
                + completionTokens / 1_000_000d * completionPricePerMillion;

        totalPromptTokens.addAndGet(promptTokens);
        totalCompletionTokens.addAndGet(completionTokens);

        log.info("[TokenCost] 本次输入 {} tokens，输出 {} tokens，花费约 {} 元；累计输入 {}，输出 {}",
                promptTokens, completionTokens, String.format("%.6f", cost),
                totalPromptTokens.get(), totalCompletionTokens.get());

        return response;
    }

    @Override
    public int getOrder() {
        return this.order;
    }

    @Override
    public String getName() {
        return "TokenCostAdvisor";
    }
}
```

几个关键点：

- `before()` 里什么都不用干，因为记账只关心响应。但方法必须实现，原样返回 request 就行。
- `after()` 从 `chatResponse.getMetadata().getUsage()` 拿 token 数。`getPromptTokens()` 是你发出去的（用户问题 + 检索资料 + 历史），`getCompletionTokens()` 是模型生成的。
- 用 `AtomicLong` 累加，是因为一个 ChatClient 会被多个请求线程共用。

### 3.3 把 RAG、记忆、记账串成一条链

先定义向量库（内存版，重启就清空，生产请换 Redis、Milvus 这类持久化实现）：

```java
package com.example.aiadvisor.config;

import org.springframework.ai.embedding.EmbeddingModel;
import org.springframework.ai.vectorstore.SimpleVectorStore;
import org.springframework.ai.vectorstore.VectorStore;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class VectorStoreConfig {

    @Bean
    VectorStore vectorStore(EmbeddingModel embeddingModel) {
        return SimpleVectorStore.builder(embeddingModel).build();
    }
}
```

再配 ChatClient，把三个 Advisor 挂上去：

```java
package com.example.aiadvisor.config;

import java.util.List;

import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.client.advisor.MessageChatMemoryAdvisor;
import org.springframework.ai.chat.client.advisor.SafeGuardAdvisor;
import org.springframework.ai.chat.client.advisor.api.Advisor;
import org.springframework.ai.chat.memory.ChatMemory;
import org.springframework.ai.chat.memory.MessageWindowChatMemory;
import org.springframework.ai.rag.advisor.RetrievalAugmentationAdvisor;
import org.springframework.ai.rag.retrieval.search.VectorStoreDocumentRetriever;
import org.springframework.ai.vectorstore.VectorStore;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import com.example.aiadvisor.advisor.TokenCostAdvisor;

@Configuration
public class ChatClientConfig {

    @Bean
    ChatMemory chatMemory() {
        // 每个会话最多保留 20 条消息，超了就丢最早的
        return MessageWindowChatMemory.builder()
                .maxMessages(20)
                .build();
    }

    /**
     * RAG Advisor：负责检索知识库，并把资料拼进提问。
     */
    @Bean
    Advisor ragAdvisor(VectorStore vectorStore) {
        return RetrievalAugmentationAdvisor.builder()
                .documentRetriever(VectorStoreDocumentRetriever.builder()
                        .vectorStore(vectorStore)
                        .similarityThreshold(0.6)
                        .topK(4)
                        .build())
                .build();
    }

    @Bean
    ChatClient chatClient(ChatClient.Builder builder, ChatMemory chatMemory, Advisor ragAdvisor) {
        return builder
                .defaultSystem("你是一个严谨的中文技术助手，回答要基于提供的参考资料。")
                .defaultAdvisors(
                        // 敏感词拦截，order=0，放在最外圈，命中就不往下走了
                        new SafeGuardAdvisor(List.of("忽略之前的指令", "越狱")),
                        // 对话记忆：读写历史，用框架推荐的顺序
                        MessageChatMemoryAdvisor.builder(chatMemory)
                                .order(Advisor.DEFAULT_CHAT_MEMORY_PRECEDENCE_ORDER)
                                .build(),
                        // RAG 检索
                        ragAdvisor,
                        // 记账：order 很大，贴着模型，能拿到每次真实调用
                        new TokenCostAdvisor(1000))
                .build();
    }
}
```

这段的顺序设计值得琢磨：

- `SafeGuardAdvisor` order = 0，在最外圈。用户输入不干净就当场拦下，既安全又省钱。
- `MessageChatMemoryAdvisor` 用框架推荐值（`HIGHEST_PRECEDENCE + 200`），比工具调用 Advisor 靠外，保证历史完整。
- `RetrievalAugmentationAdvisor` 用默认 order = 0。注意它和 SafeGuard 的 order 撞了，同值顺序不保证。**如果你在意顺序，就显式给其中一个设不同的值。** 这里能接受，因为拦截器就算后执行也只是多花一次检索的钱，不影响正确性。
- `TokenCostAdvisor` order = 1000，最贴模型，拿到的 token 数最原始。

最后是 Controller，业务代码只剩下"我要问什么"：

```java
package com.example.aiadvisor.controller;

import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.memory.ChatMemory;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/chat")
public class ChatController {

    private final ChatClient chatClient;

    public ChatController(ChatClient chatClient) {
        this.chatClient = chatClient;
    }

    @GetMapping
    public String chat(@RequestParam String question, @RequestParam String userId) {
        return chatClient.prompt()
                .user(question)
                // 会话 ID 必须传，否则记忆 Advisor 会直接抛异常
                .advisors(a -> a.param(ChatMemory.CONVERSATION_ID, userId))
                .call()
                .content();
    }
}
```

对比第一节那段反面教材：检索、记忆、记账全没了，Controller 里只剩一行提问。这就是 Advisor 的价值。

## 四、踩坑经验和最佳实践

**1. 忘了传会话 ID，一请求就报错**

用 `MessageChatMemoryAdvisor` 却不传 `ChatMemory.CONVERSATION_ID`，请求会抛 `IllegalArgumentException: conversationId cannot be null`。这不是 bug，是它在提醒你"我该把这条消息存到哪个会话里"。养成习惯：所有带记忆的调用都显式传 userId。

**2. order 相同，顺序就是随机的**

框架写得很直白：order 值相同时，执行顺序不保证。生产代码里，**凡是顺序有语义的 Advisor，都显式指定不同的 order**，别指望它们的排列顺序。

**3. 流式调用里 `after()` 只在整段结束时触发一次**

`BaseAdvisor` 默认的流式实现中，`after()` 只在收到结束信号时执行一次。这意味着想在流式场景统计 token，得等整段流结束才能拿到汇总值，别指望在中间读到 usage。

**4. 工具调用场景下，token 容易被统计漏**

模型带工具调用时，一次用户提问可能触发好几轮"模型 → 工具 → 模型"。如果你的记账 Advisor 位置不对，只会记到最后一次。Spring AI 内部有个 `UsageAccumulator` 专门用来累加这种情况的用量，需要精确统计时可以基于它来写。

**5. `before()` 里的耗时操作会让整条链变慢**

`before()` 是同步执行的。在里面查数据库、调外部接口，慢了用户就得等。流式场景下 `BaseAdvisor` 默认用 `boundedElastic` 调度器，但别指望它救你——该加的缓存还是要加。

**6. 别把业务逻辑塞进 Advisor**

Advisor 只该做"跟调用有关的通用事"。见过的事故：有人在 Advisor 里根据用户问题去写订单、发通知，结果模型重试一次，就重复下单。记住：Advisor 可能被执行多次，必须是幂等、无副作用的。

## 五、性能对比和技术选型

三种做法摆一起对比：

| 方案 | 复用性 | 顺序可控 | 学习成本 | 适用场景 |
|---|---|---|---|---|
| 每个接口手写 | 最差，改一处动 N 处 | 靠人记 | 低 | 只有一个 AI 接口的小项目 |
| Spring AOP 切面 | 好 | 靠切点表达式 | 中 | 拦截目标有明确方法签名 |
| Spring AI Advisor | 好，且有官方生态 | 靠 order，清晰 | 低 | 一切 AI 调用的通用逻辑 |

为什么推荐 Advisor 而不是 AOP？因为 AI 调用的通用逻辑几乎都要**读写 prompt 和 context**（改提示词、加历史、塞检索结果），这些对象在 AOP 切点里根本拿不到，而 Advisor 天生就把 `ChatClientRequest`、`ChatClientResponse` 交到你手上。

选型建议：

- 只需要日志和埋点 → 直接用官方 `SimpleLoggerAdvisor`，别自己写
- 需要 RAG → `RetrievalAugmentationAdvisor`，它已经实现了"查询改写、多路检索、文档合并"整条流水线，手写很难写全
- 需要成本管控、审计 → 自己写，因为计费口径和你的账单强绑定
- 需要限流、降级 → Advisor 也能做，但更建议放在网关层，因为 Advisor 拦不住恶意流量

## 六、总结

Advisor 本质上就是把"每次 AI 调用都要做的事"从业务代码里搬出来，变成一条可以自由编排的洋葱链。三个要点记住就行：

1. **接口只有两个**：`before()` 处理请求，`after()` 处理响应，实现 `BaseAdvisor` 最省事
2. **order 越小越靠外**：请求先进后出，响应后进先出；想拦住请求就别调 `chain.nextCall()`
3. **context 是暗号本**：Advisor 之间靠它传数据，会话 ID、检索到的文档都在这儿

落地建议：先用官方的 `SafeGuardAdvisor` + `MessageChatMemoryAdvisor` + `RetrievalAugmentationAdvisor` 把骨架搭起来，再按自己的需要补一个记账 Advisor。你会发现，AI 接口的业务代码，真的可以只剩一行。

## 参考资料

- [Spring AI - Advisors API](https://docs.spring.io/spring-ai/reference/api/advisors.html)
- [Spring AI - Retrieval Augmented Generation](https://docs.spring.io/spring-ai/reference/api/retrieval-augmented-generation.html)
- [Spring AI - Chat Memory](https://docs.spring.io/spring-ai/reference/api/chat-memory.html)
- [Spring AI - ChatClient](https://docs.spring.io/spring-ai/reference/api/chatclient.html)

文 / 会编程的吕洞宾
