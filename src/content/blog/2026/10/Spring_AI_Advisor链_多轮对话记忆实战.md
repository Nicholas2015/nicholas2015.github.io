---
title: "Spring AI 记忆总丢？Advisor 链来治"
date: 2026-10-30T20:00:00+08:00
category: "AI"
tags: ["spring-ai"]
---

> 用 Spring AI 写多轮对话，十有八九栽在同一件事上：历史消息全靠自己拼。第一版能跑，第二版开始到处 `if`，第三版发现两个用户串了台。这篇讲清楚 Advisor 链是怎么回事——它是 Spring AI 里统一处理记忆、日志、RAG、内容过滤的插槽机制。看完你能把散落在 Service 里的历史拼接代码全删掉，换成一个可复用、可排序、流式也不掉链子的拦截链。

## 一、这个问题到底是什么

### 手动拼历史，撑不过三版迭代

刚开始大家都这么写：从数据库查最近 10 条记录，转成 `UserMessage` / `AssistantMessage`，塞进 `Prompt`，再调模型。能跑。问题是这段代码会长大。

**坑一：会话串台。** 你按 `userId` 查历史，多个会话共用一个 `userId` 的时候（比如同一个用户开了两个话题），两段对话混在一起，模型开始答非所问。要修就得引入 `conversationId`，然后发现查询条件、缓存 key、清理逻辑全要改。

**坑二：token 悄悄失控。** 每轮都带完整历史，20 轮之后单次请求轻松上千 token。你加了个截断，写的是 `list.subList(size - 10, size)`——系统提示词被切掉了，模型立刻开始胡说。

**坑三：逻辑散落。** 记忆在 Service 里，日志在 Controller 里，RAG 检索在另一个 Helper 里，敏感词过滤又写了个 AOP。同一个请求的加工过程被拆成四份，谁先谁后全靠调用顺序，改一处炸一片。

**坑四：流式输出直接失效。** `call()` 改成 `stream()` 以后，那些基于返回值的后置处理拿不到完整响应，token 统计归零，日志只剩一个空壳。

Spring AI 给的答案是 Advisor。名字听着玄，本质就是一条拦截器链，和 Servlet Filter、Spring MVC 的 HandlerInterceptor 是一个思路：请求进模型之前，每个 Advisor 都有机会改一改；模型返回之后，每个 Advisor 都有机会看一眼。

### 什么时候该用，什么时候别用

用 Advisor 的场景很明确：**所有"每次调模型都要干一遍"的横切逻辑**。加历史、记日志、算 token、检索知识库、过滤敏感内容，都归它。

反过来，业务分支判断（这个用户能不能问这个问题、要不要转人工）不要塞进 Advisor。那不是横切逻辑，是业务规则，塞进去以后你会得到一个谁都不敢改的链。

## 二、底层原理到底怎么回事

### 一条请求的完整路径

```
chatClient.prompt().user("...").call()
        │
        ▼
ChatClientRequest（含 Prompt：system + 历史 + 本轮问题）
        │
        ▼
┌──────────────────────────────────────────┐
│  Advisor 1  order=0   （最外层，先执行）  │  ← 审计/日志
│  ┌────────────────────────────────────┐  │
│  │  Advisor 2  order=10               │  │  ← RAG 检索，往 Prompt 里插资料
│  │  ┌──────────────────────────────┐  │  │
│  │  │  Advisor 3  order=20         │  │  │  ← 记忆，往 Prompt 里插历史
│  │  │  ┌────────────────────────┐  │  │  │
│  │  │  │      ChatModel 调用    │  │  │  │
│  │  │  └────────────────────────┘  │  │  │
│  │  └──────────────────────────────┘  │  │
│  └────────────────────────────────────┘  │
└──────────────────────────────────────────┘
        │
        ▼
ChatClientResponse（含 ChatResponse + 元数据）
```

关键点：**order 数字小的在外层，先执行**，和 Spring 的 `Ordered` 语义一致。请求方向是"由外向内"逐层加工，响应方向是"由内向外"逐层回看。你的日志 Advisor 设成 0，就能看到其他 Advisor 加工完的最终 Prompt——这个顺序搞反了，日志里永远是没加历史的原始请求。

### CallAdvisor 和 StreamAdvisor 是两套链

这是最容易踩的坑。`call()` 走的是 `CallAdvisor` 链，`stream()` 走的是 `StreamAdvisor` 链。**只实现了 `CallAdvisor` 的类，在流式调用里根本不会被触发。**

这不是设计缺陷，是返回类型决定的：非流式返回一个 `ChatClientResponse`，流式返回 `Flux<ChatClientResponse>`，一个能拿到完整结果，一个只能拿到一串增量。想两边都覆盖，就实现两个接口，或者写一个类同时 `implements CallAdvisor, StreamAdvisor`。

### 记忆 Advisor 到底干了什么

`MessageChatMemoryAdvisor` 的职责非常窄，就三件事：

1. 从请求参数里取 `conversationId`（常量是 `ChatMemory.CONVERSATION_ID`，值是 `chat_memory_conversation_id`）；
2. 拿这个 id 去 `ChatMemory` 里查历史消息；
3. 把历史**塞到本轮用户消息之前**，然后把加工后的 Prompt 交给下一环。

模型返回之后，它再把"本轮问题 + 模型回答"这一对存回去。

注意第 3 步的位置：历史是插在 system 提示词之后的，system 永远在最前面。这就是为什么用 Advisor 不会出现"系统提示被裁掉"的问题——裁剪发生在 `ChatMemory` 内部，它只裁历史，不碰 system。

### 窗口记忆是怎么裁的

`MessageWindowChatMemory` 按**消息条数**保留，不是按 token。`maxMessages(20)` 意思是留最近 20 条（一问一答算 2 条），超出的老消息从头部丢弃，system 提示词不参与计数。

按条数裁有个明显后果：**一轮对话 30 字和一轮 3000 字，占的名额一样**。真要控 token，得用摘要式记忆，或者自己按 token 估。这点后面选型再展开。

### conversationId 的隔离靠的是仓库，不是 Advisor

`ChatMemory` 本身不存数据，它只负责"裁剪策略"。真正落盘的是 `ChatMemoryRepository`：`InMemoryChatMemoryRepository` 用 `ConcurrentHashMap<String, List<Message>>`，key 就是 `conversationId`。所以隔离性是仓库给的，你只要保证每个会话传进去的 id 不一样，就不会串台。

换存储只要换仓库实现，`MessageWindowChatMemory` 和 `MessageChatMemoryAdvisor` 一行都不用动。这就是这套抽象最值钱的地方。

## 三、实战：手把手写代码

### 依赖

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
    <artifactId>spring-ai-advisor-demo</artifactId>
    <version>1.0.0</version>

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
            <artifactId>spring-ai-starter-model-openai</artifactId>
            <version>2.0.2</version>
        </dependency>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-test</artifactId>
            <version>4.1.2</version>
            <scope>test</scope>
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

配置只写必要项。`base-url` 改了就能接任何 OpenAI 兼容服务，本地 Ollama、通义、DeepSeek 都是这么接：

```yaml
server:
  port: 8080

spring:
  ai:
    openai:
      api-key: ${OPENAI_API_KEY}
      base-url: https://api.openai.com
      chat:
        options:
          model: gpt-4o-mini
          temperature: 0.3
```

### 例子一：30 行搞定带记忆的对话

```java
package com.example.advisor;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class AdvisorDemoApplication {

    public static void main(String[] args) {
        SpringApplication.run(AdvisorDemoApplication.class, args);
    }
}
```

```java
package com.example.advisor;

import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.client.advisor.MessageChatMemoryAdvisor;
import org.springframework.ai.chat.memory.ChatMemory;
import org.springframework.ai.chat.memory.InMemoryChatMemoryRepository;
import org.springframework.ai.chat.memory.MessageWindowChatMemory;
import org.springframework.stereotype.Service;

@Service
public class ChatService {

    private final ChatClient chatClient;

    public ChatService(ChatClient.Builder builder) {
        ChatMemory chatMemory = MessageWindowChatMemory.builder()
                .chatMemoryRepository(new InMemoryChatMemoryRepository())
                .maxMessages(20)
                .build();

        this.chatClient = builder
                .defaultSystem("你是 Java 技术助手，回答不超过 200 字，不写废话。")
                .defaultAdvisors(MessageChatMemoryAdvisor.builder(chatMemory).build())
                .build();
    }

    public String chat(String conversationId, String question) {
        return chatClient.prompt()
                .user(question)
                .advisors(a -> a.param(ChatMemory.CONVERSATION_ID, conversationId))
                .call()
                .content();
    }
}
```

```java
package com.example.advisor;

import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class ChatController {

    private final ChatService chatService;

    public ChatController(ChatService chatService) {
        this.chatService = chatService;
    }

    @PostMapping("/chat")
    public String chat(@RequestParam String conversationId,
                       @RequestParam String question) {
        return chatService.chat(conversationId, question);
    }
}
```

逐段说清楚。

`MessageWindowChatMemory.builder()` 配上 `InMemoryChatMemoryRepository`，等于"存在内存里，最多留 20 条"。进程重启数据就没了，开发阶段够用。

`.defaultAdvisors(...)` 把这个 Advisor 挂成默认，所有走这个 `ChatClient` 的请求都自动带记忆。如果只想在某次调用加，就写到 `.advisors()` 里。

`.advisors(a -> a.param(ChatMemory.CONVERSATION_ID, conversationId))` 是**必写**的一行。不传会怎样？记忆 Advisor 找不到 id 就跳过历史注入，你的多轮对话退化成单轮——不报错，只是"记不住"，最难查的那种。

`ChatClient.Builder` 是 Spring AI 自动装配好的 Bean，直接注入，不用自己 new。

验证方式：同一个 `conversationId` 先问"我叫什么名字，记住我是老王"，再问"我叫什么"，能答出老王就通了。换个 `conversationId` 再问，应该答不出来——答出来了说明你 id 传错了。

### 例子二：自定义 Advisor 做审计

内置 Advisor 覆盖不到的需求，自己写一个。这个统计每次调用的耗时、送进去多少条消息、消耗多少 token：

```java
package com.example.advisor;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.client.advisor.api.CallAdvisor;
import org.springframework.ai.chat.client.advisor.api.CallAdvisorChain;
import org.springframework.ai.chat.client.advisor.api.ChatClientRequest;
import org.springframework.ai.chat.client.advisor.api.ChatClientResponse;
import org.springframework.ai.chat.metadata.Usage;

public class AuditAdvisor implements CallAdvisor {

    private static final Logger log = LoggerFactory.getLogger(AuditAdvisor.class);

    private final int order;

    public AuditAdvisor(int order) {
        this.order = order;
    }

    @Override
    public ChatClientResponse adviseCall(ChatClientRequest request, CallAdvisorChain chain) {
        int instructionCount = request.prompt().getInstructions().size();
        long start = System.nanoTime();

        ChatClientResponse response = chain.nextCall(request);

        long costMs = (System.nanoTime() - start) / 1_000_000;
        Usage usage = response.chatResponse() == null
                ? null
                : response.chatResponse().getMetadata().getUsage();

        log.info("耗时={}ms 送入消息数={} promptTokens={} completionTokens={}",
                costMs,
                instructionCount,
                usage == null ? -1 : usage.getPromptTokens(),
                usage == null ? -1 : usage.getCompletionTokens());

        return response;
    }

    @Override
    public String getName() {
        return "auditAdvisor";
    }

    @Override
    public int getOrder() {
        return order;
    }
}
```

两个细节必须解释。

`chain.nextCall(request)` 是"放行"。这行之前是前置逻辑，之后是后置逻辑。忘了写 `return`，或者不调 `nextCall` 直接返回自己造的响应，整条链就断了——模型根本不会被调用，而且不报错。

`getOrder()` 返回 0，意味着它排在最外层。这样 `instructionCount` 统计到的是**所有 Advisor 加工完之后**的最终消息数，包含历史。想要原始请求数，就把 order 设成比记忆 Advisor 大的值。

### 例子三：流式输出 + SSE，别让审计失效

流式接口用 `Flux` 直接推给浏览器，前端 `EventSource` 就能一个字一个字地显示：

```java
package com.example.advisor;

import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.client.advisor.MessageChatMemoryAdvisor;
import org.springframework.ai.chat.memory.ChatMemory;
import org.springframework.ai.chat.memory.InMemoryChatMemoryRepository;
import org.springframework.ai.chat.memory.MessageWindowChatMemory;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class ChatClientConfig {

    @Bean
    public ChatMemory chatMemory() {
        return MessageWindowChatMemory.builder()
                .chatMemoryRepository(new InMemoryChatMemoryRepository())
                .maxMessages(30)
                .build();
    }

    @Bean
    public ChatClient chatClient(ChatClient.Builder builder, ChatMemory chatMemory) {
        return builder
                .defaultSystem("你是 Java 技术助手，回答不超过 200 字。")
                .defaultAdvisors(
                        new AuditAdvisor(0),
                        new StreamAuditAdvisor(0),
                        MessageChatMemoryAdvisor.builder(chatMemory).build())
                .build();
    }
}
```

```java
package com.example.advisor;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.client.advisor.api.ChatClientRequest;
import org.springframework.ai.chat.client.advisor.api.ChatClientResponse;
import org.springframework.ai.chat.client.advisor.api.StreamAdvisor;
import org.springframework.ai.chat.client.advisor.api.StreamAdvisorChain;
import reactor.core.publisher.Flux;

import java.util.concurrent.atomic.AtomicBoolean;

public class StreamAuditAdvisor implements StreamAdvisor {

    private static final Logger log = LoggerFactory.getLogger(StreamAuditAdvisor.class);

    private final int order;

    public StreamAuditAdvisor(int order) {
        this.order = order;
    }

    @Override
    public Flux<ChatClientResponse> adviseStream(ChatClientRequest request, StreamAdvisorChain chain) {
        long start = System.nanoTime();
        AtomicBoolean firstChunk = new AtomicBoolean(true);

        return chain.nextStream(request)
                .doOnNext(response -> {
                    if (firstChunk.compareAndSet(true, false)) {
                        log.info("首字延迟={}ms", (System.nanoTime() - start) / 1_000_000);
                    }
                })
                .doOnComplete(() -> log.info("流结束，总耗时={}ms",
                        (System.nanoTime() - start) / 1_000_000))
                .doOnError(ex -> log.warn("流式调用失败", ex));
    }

    @Override
    public String getName() {
        return "streamAuditAdvisor";
    }

    @Override
    public int getOrder() {
        return order;
    }
}
```

```java
package com.example.advisor;

import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.memory.ChatMemory;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import reactor.core.publisher.Flux;

@RestController
public class StreamChatController {

    private final ChatClient chatClient;

    public StreamChatController(ChatClient chatClient) {
        this.chatClient = chatClient;
    }

    @GetMapping(value = "/chat/stream", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public Flux<String> stream(@RequestParam String conversationId,
                               @RequestParam String question) {
        return chatClient.prompt()
                .user(question)
                .advisors(a -> a.param(ChatMemory.CONVERSATION_ID, conversationId))
                .stream()
                .content();
    }
}
```

`ChatClientConfig` 里同时注册了 `AuditAdvisor` 和 `StreamAuditAdvisor`。因为两条链独立，`call()` 只触发前者，`stream()` 只触发后者，各管各的，互不干扰。

`doOnNext` 里的 `compareAndSet` 是拿"第一个数据块到达"的时刻当首字延迟。为什么要原子布尔？流式数据可能在多个线程上推，`compareAndSet` 保证只打一次日志。

`produces = TEXT_EVENT_STREAM_VALUE` 这一行不能省。少了它浏览器会把响应当普通文本读完再显示，打字机效果直接没有。

## 四、踩坑经验和最佳实践

**坑一：不传 conversationId，记忆静默失效。** 最典型的表现是"单轮能用，多轮就傻"。不报异常，因为 Advisor 找不到 id 时选择跳过而不是抛错。建议在 Service 入口加断言，id 为空直接抛 `IllegalArgumentException`。

**坑二：用 userId 当 conversationId。** 用户开两个窗口聊两个话题，历史混在一起，模型开始张冠李戴。正确做法是前端生成一个会话 id（UUID 就行），跟用户 id 分开存。

**坑三：order 设反，日志看到的是半成品。** 审计 Advisor 想统计最终消息数，order 必须比记忆 Advisor 小。想统计原始请求，order 就得比它大。我一般固定两个：`0` 给审计，`100` 之后给业务加工。

**坑四：把 `InMemoryChatMemoryRepository` 带上生产。** 重启丢历史，多实例部署时每个实例各存一份，用户刷新到另一台机器就失忆。上生产换 `JdbcChatMemoryRepository` 或自己写个 Redis 实现，接口就四个方法，不难。

**坑五：`maxMessages` 设太大当保险。** 设成 200 条看着安全，实际每次请求都顶到 token 上限，延迟和费用一起飙。20 到 30 条对大多数客服、助手类场景够用。

**坑六：在 Advisor 里做阻塞 IO。** 流式链路跑在 Reactor 线程上，在 `adviseStream` 里同步查一次数据库，整个流的吞吐就废了。要查库用 `Mono.fromCallable(...).subscribeOn(Schedulers.boundedElastic())` 包一层，或者干脆别在流式 Advisor 里查库。

几条实践建议，都是踩过之后总结的：

- conversationId 别用自增数字，用 UUID，避免被猜到别人的会话；
- 记忆条数按场景定，问答类 10 到 20 条，长文档分析 30 条以上，别看别人写多少就抄多少；
- 自定义 Advisor 只做无状态的横切逻辑，需要状态就放仓库里，Advisor 本身保持无状态才好复用；
- 上线前把 `AuditAdvisor` 的日志留一周，token 消耗的异常增长基本都能从这里看出来。

## 五、性能对比和技术选型

### 自己拼 vs Advisor

| 维度 | 手写拼历史 | Advisor 链 |
|---|---|---|
| 代码位置 | 散落在 Service / Controller | 集中在一个配置类 |
| 多会话隔离 | 自己维护查询条件 | 传 `conversationId` 即可 |
| 换存储 | 改 Service | 换 `ChatMemoryRepository` 实现 |
| 流式支持 | 每处单独处理 | 实现 `StreamAdvisor` 一次搞定 |
| 前置/后置顺序 | 靠调用顺序，隐式 | `getOrder()` 显式声明 |

### 记忆存储怎么选

| 实现 | 适用场景 | 代价 |
|---|---|---|
| `InMemoryChatMemoryRepository` | 本地开发、单实例 demo | 重启即失，不能多实例 |
| `JdbcChatMemoryRepository` | 已有 MySQL/PG，要审计留痕 | 每次请求两次 SQL |
| 自写 Redis 仓库 | 高并发、会话有 TTL 需求 | 要自己处理序列化 |

### token 账怎么算

按 20 轮对话、每轮问答合计约 300 token 估：

- 无记忆：每轮只发本轮问题，约 50 token；
- 窗口记忆 20 条（10 轮）：最后一轮约 50 + 10×300 = 3050 token；
- 窗口记忆 30 条（15 轮）：约 4550 token。

从 3050 涨到 4550，多出来的钱买的是"模型还记得更早的事"。值不值取决于场景：客服机器人记 3 轮就够，代码助手可能真需要 15 轮。**先按最小可用条数上线，被用户投诉"忘了"再加，别一上来就拉满。**

摘要式记忆是另一条路：老对话压缩成一段摘要，token 恒定但会丢细节。实现成本高（要多调一次模型），除非对话轮次特别多，否则不划算。

## 六、总结

Advisor 不是一个新概念，它就是拦截器链换了个名字装进 Spring AI。但装得挺对：记忆、日志、RAG、内容过滤这些"每次都要干一遍"的事，全都能挂上去，而且能排序、能流式、能换实现。

记住四件事就够用了：

1. `order` 小的在外层，请求由外向内，响应由内向外；
2. `call()` 和 `stream()` 是两条独立的链，审计要写两遍；
3. `conversationId` 必须显式传，不传不报错但会失忆；
4. 隔离靠 `ChatMemoryRepository`，换存储不用动业务代码。

剩下的是工程判断：条数设多少、存哪儿、要不要摘要。这些没有标准答案，取决于你的用户能忍多久的"你刚才说什么"。

我自己的习惯是：新项目一律先上 Advisor 链，哪怕只有记忆一个 Advisor。等需求长出来再加，比事后把手写逻辑拆出来省事得多。

文 / 会编程的吕洞宾

## 参考资料

- [ChatClient - Spring AI Reference](https://docs.spring.io/spring-ai/reference/api/chatclient.html)
- [Advisors - Spring AI Reference](https://docs.spring.io/spring-ai/reference/api/advisors.html)
- [Chat Memory - Spring AI Reference](https://docs.spring.io/spring-ai/reference/api/chat-memory.html)
