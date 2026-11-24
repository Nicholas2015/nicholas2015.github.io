---
title: "LangChain4j记忆持久化，别再存内存里了"
date: 2026-10-25T20:00:00+08:00
category: "AI"
tags: ["langchain4j"]
---

> 客服 AI 上线第三天，把 A 用户的退款单号报给了 B 用户。日志翻出来，代码没写错，问题出在默认配置：没给会话分 ID，所有请求共用 JVM 里同一个记忆对象，重启还会清空。这篇讲清 LangChain4j 记忆的两层结构，再用 Redis 把对话上下文搬出去，做到重启不丢、多用户不串、内存不涨。代码是完整工程，照抄能跑。

## 一、这个问题到底是什么

**LangChain4j 的"记忆"是两层东西：ChatMemory 管裁剪，ChatMemoryStore 管存储。大部分人只配了第一层，记忆就一直活在本机堆里。**

先把两层说清楚。

第一层是 `ChatMemory`，它回答一个问题：这次请求带多少条历史？模型上下文有上限，历史不可能无限往里塞，所以要有个窗口，超了就从头砍。

第二层是 `ChatMemoryStore`，它回答另一个问题：这些消息到底存在哪？内存、Redis、MySQL，都行，真正要实现的方法只有 `getMessages`、`updateMessages`、`deleteMessages` 三个。

新建一个 `MessageWindowChatMemory` 时如果不传 store，它会用默认的 `SingleSlotChatMemoryStore`。看名字就知道，一个槽位，内部就是一个 `List<ChatMessage>` 字段。进程在，历史在；进程没了，历史也没了。

单机 demo、一个用户、跑几分钟，这套东西完全够用。上生产就不行了，会依次撞上四个问题：

- **重启即失忆。** 发版、扩容、OOM 重启，用户回来第一句是"我们刚才说到哪了"，AI 一脸茫然。用户不会觉得是发版，只会觉得这产品很蠢。
- **多实例各记各的。** 网关把第一轮打到 8081，第二轮打到 8082，第二台机器上的历史是空的。用户看到的是 AI 突然失忆，运维看到的是"偶发问题"，最难查的那种。
- **会话对象只增不减。** `AiServices` 内部维护了一个 `Map<memoryId, ChatMemory>`，每个新会话往里塞一个对象。Redis 那边设了过期，这个 Map 不会跟着过期。用户量上来，堆慢慢涨。
- **越权读取。** 隔离全靠 `memoryId` 一个字符串。如果这个值是前端传上来的，改一个字符就能读到别人的聊天记录。这不是记忆问题，是安全事故。

还有一个隐性问题：很多人以为"我配了 memoryId 就隔离了"。隔离确实生效了，但只在单机内存里生效。换台机器，同一个 memoryId 也是空的。

一句话收口：**记忆不是模型的属性，是应用的状态。状态要外置。**

## 二、底层原理到底怎么回事

**大模型没有记忆。所谓多轮对话，是客户端每次把历史重新发一遍。**

这句话是所有设计的源头。模型是无状态的，它不记得上一轮说了什么。你感觉它记得，是因为每次请求都把之前几十条消息一起塞进了 prompt。

LangChain4j 干的事，就是帮你管理"要重发哪几条"。

### 一条消息进来，走了哪几步

```
用户发来第 N 轮消息
      │
      ├─ ChatMemory.messages()          读 store → 按窗口裁剪 → 返回历史
      │
      ├─ 拼成 [System, User1, Ai1, ...] 发给模型
      │
      ├─ ChatMemory.add(UserMessage)    读 store → 裁剪 → 追加 → 写回 store
      │
      ├─ 模型返回
      │
      └─ ChatMemory.add(AiMessage)      再读 → 再裁剪 → 再追加 → 再写回
```

看清这条链路，两个结论就出来了。

第一，`add()` 不是简单的 append。它每次都先把全量历史读出来，裁到窗口大小，再追加新消息，最后整体写回。为什么这么设计？因为 store 是唯一真相，内存里不留副本。进程随时可能被杀，只有 store 里的数据算数。

第二，一轮对话不是一次读写。按上面的流程数一遍：读历史 1 次，加用户消息读 1 次写 1 次，加 AI 消息读 1 次写 1 次。**每轮固定 5 次 Redis 往返，3 读 2 写。**

这个数字很关键。它意味着你的记忆层延迟 = 5 × 单次往返。本地 Redis 单次往返通常在亚毫秒级，5 次叠加也就 1～2 毫秒。跟一次大模型调用动辄几百毫秒到几秒比，可以忽略。但如果 Redis 跨机房，单次 20 毫秒，一轮就多出 100 毫秒，这就得算账了。

### 窗口是怎么裁的

`MessageWindowChatMemory` 按条数裁，规则比想象的细：

- `SystemMessage` 永久保留，砍谁都不砍它。而且只允许存在一条，重复添加同内容的会被忽略。
- 超窗时从索引 0 开始淘汰，但如果 0 是 SystemMessage，就从 1 开始。
- 淘汰一条带工具调用的 `AiMessage` 时，紧跟其后的 `ToolExecutionResultMessage` 会一起删掉。原因很实在：OpenAI 这类厂商会拒绝"没有对应工具调用的工具结果"，留着就报 400。

第三条是真踩过的坑。你以为是窗口裁剪，实际是把请求裁成了非法格式，报错信息还完全指不到记忆层。

按条数裁的毛病也很明显：一条消息可能只有"嗯"，也可能是一整篇 5000 字的文档。20 条的上限，内容长度可以差一百倍。所以 LangChain4j 还提供了 `TokenWindowChatMemory`，按 token 裁，接口长这样：`maxTokens(4000, tokenCountEstimator)`。这个后面踩坑那节展开。

### 序列化为什么不能自己来

有人图省事，直接拿 Jackson 序列化 `List<ChatMessage>`。跑起来就炸。

`ChatMessage` 是接口，底下有 `UserMessage`、`AiMessage`、`SystemMessage`、`ToolExecutionResultMessage`、`CustomMessage` 好几个实现。Jackson 序列化接口能输出 JSON，反序列化时它不知道该还原成哪个类，只能报错或者给你一个错误的类型。

LangChain4j 自带 `ChatMessageSerializer` 和 `ChatMessageDeserializer`。它们内部维护了 `type` 字段和多态映射，存进去是 `USER`、`AI`、`SYSTEM`、`TOOL_EXECUTION_RESULT` 这些枚举值，读出来能精确还原，包括工具调用参数这种嵌套结构。

**结论：序列化只走这两个类，别自己写 ObjectMapper。**

### 还有一层藏在框架里的缓存

`AiServices` 里有个 `ChatMemoryService`，它持有一个 `ConcurrentHashMap<Object, ChatMemory>`。第一次见到某个 memoryId，调用你的 `ChatMemoryProvider` 造一个 `MessageWindowChatMemory`，然后缓存起来。

注意区分：Redis 里存的是**消息列表**，这个 Map 里存的是**窗口对象**。对象本身很轻，但会一直累积。Redis 键过期了，Map 里的对象还在，下次同 ID 进来又接着用，读完 Redis 是空的，等于白缓存。

`ChatMemoryAccess` 接口就是为这个准备的。让 AI Service 接口继承它，就多了两个方法：`getChatMemory(id)` 和 `evictChatMemory(id)`。删会话的时候两个都删，Redis 键和 JVM 对象，一个都别留。

## 三、实战：手把手写代码

目标很明确：对话消息进 Redis，按会话隔离，7 天不动自动过期。

工程结构：

```
chat-memory-redis
├── pom.xml
└── src/main
    ├── java/com/example/chatmemory
    │   ├── ChatMemoryApplication.java
    │   ├── config/ChatAssistantConfig.java
    │   ├── memory/RedisChatMemoryStore.java
    │   ├── service/Assistant.java
    │   └── web/{ChatController,ChatRequest,ChatReply}.java
    └── resources/application.yml
```

### 3.1 依赖

`pom.xml`，坐标和版本都在，不用改父 POM 里的东西。

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
    <artifactId>chat-memory-redis</artifactId>
    <version>1.0.0</version>

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
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-data-redis</artifactId>
            <version>4.1.2</version>
        </dependency>

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

启动类没什么特别的：

```java
package com.example.chatmemory;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class ChatMemoryApplication {

    public static void main(String[] args) {
        SpringApplication.run(ChatMemoryApplication.class, args);
    }
}
```

### 3.2 把消息写进 Redis

整个存储层只有一个类。关键在于：**序列化交给 LangChain4j，我们只管 key 和 TTL。**

```java
package com.example.chatmemory.memory;

import dev.langchain4j.data.message.ChatMessage;
import dev.langchain4j.data.message.ChatMessageDeserializer;
import dev.langchain4j.data.message.ChatMessageSerializer;
import dev.langchain4j.store.memory.chat.ChatMemoryStore;
import org.springframework.data.redis.core.StringRedisTemplate;

import java.time.Duration;
import java.util.ArrayList;
import java.util.List;

public class RedisChatMemoryStore implements ChatMemoryStore {

    private static final String KEY_PREFIX = "chat:memory:";

    private final StringRedisTemplate redisTemplate;
    private final Duration ttl;

    public RedisChatMemoryStore(StringRedisTemplate redisTemplate, Duration ttl) {
        this.redisTemplate = redisTemplate;
        this.ttl = ttl;
    }

    @Override
    public List<ChatMessage> getMessages(Object memoryId) {
        String json = redisTemplate.opsForValue().get(key(memoryId));
        if (json == null || json.isBlank()) {
            return new ArrayList<>();
        }
        return new ArrayList<>(ChatMessageDeserializer.messagesFromJson(json));
    }

    @Override
    public void updateMessages(Object memoryId, List<ChatMessage> messages) {
        String json = ChatMessageSerializer.messagesToJson(messages);
        redisTemplate.opsForValue().set(key(memoryId), json, ttl);
    }

    @Override
    public void deleteMessages(Object memoryId) {
        redisTemplate.delete(key(memoryId));
    }

    private String key(Object memoryId) {
        return KEY_PREFIX + memoryId;
    }
}
```

几个设计点，逐个说。

**用 `StringRedisTemplate` 而不是 `RedisTemplate<String, Object>`。** 因为值本来就是 JSON 字符串，交给 LangChain4j 的 codec 处理。再套一层 JDK 序列化，存进去就是一堆乱码，出问题连肉眼都查不了。

**`getMessages` 返回空 `ArrayList`，不返回 null。** 接口文档要求不能为 null，而且 `MessageWindowChatMemory` 拿到结果会直接 `new LinkedList<>(stored)`，null 会当场空指针。

**外层再包一个 `new ArrayList<>()`。** 反序列化出来的可能是不可变列表，后续要往列表里追加消息，不可变就炸。多复制一次，省一类偶发 bug。

**TTL 每次写都刷新。** `set(key, value, ttl)` 会在每次更新时重置过期时间，实际效果是"滑动过期"：只要用户还在聊，历史就在；7 天没动静，键自动消失。绝大多数客服、助手场景要的就是这个行为。如果业务要求"会话创建 7 天后强制失效"，那得另存一个 created_at，不能用 TTL。

### 3.3 装配 AI Service

接口定义，注意它继承了 `ChatMemoryAccess`，这是为了后面手动清理 JVM 缓存。

```java
package com.example.chatmemory.service;

import dev.langchain4j.service.MemoryId;
import dev.langchain4j.service.SystemMessage;
import dev.langchain4j.service.UserMessage;
import dev.langchain4j.service.memory.ChatMemoryAccess;

public interface Assistant extends ChatMemoryAccess {

    @SystemMessage("""
            你是一名电商售后客服。
            回答控制在 120 字以内，先给结论，再给操作步骤。
            用户没有提供订单号时，主动询问。
            不知道的事就说不知道，不要编造订单信息和物流状态。
            """)
    String chat(@MemoryId String memoryId, @UserMessage String message);
}
```

`@MemoryId` 标在哪个参数上，哪个参数就用来取记忆。没有这个注解，所有请求共用 `"default"` 这一个会话，串号就是这么来的。

配置类把三样东西串起来：存储、窗口策略、模型。

```java
package com.example.chatmemory.config;

import com.example.chatmemory.memory.RedisChatMemoryStore;
import com.example.chatmemory.service.Assistant;
import dev.langchain4j.memory.chat.ChatMemoryProvider;
import dev.langchain4j.memory.chat.MessageWindowChatMemory;
import dev.langchain4j.model.chat.ChatModel;
import dev.langchain4j.model.openai.OpenAiChatModel;
import dev.langchain4j.service.AiServices;
import dev.langchain4j.store.memory.chat.ChatMemoryStore;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.data.redis.core.StringRedisTemplate;

import java.time.Duration;

@Configuration
public class ChatAssistantConfig {

    @Bean
    public ChatMemoryStore chatMemoryStore(StringRedisTemplate redisTemplate,
                                           @Value("${app.memory.ttl:7d}") Duration ttl) {
        return new RedisChatMemoryStore(redisTemplate, ttl);
    }

    @Bean
    public ChatMemoryProvider chatMemoryProvider(ChatMemoryStore chatMemoryStore,
                                                 @Value("${app.memory.max-messages:20}") int maxMessages) {
        return memoryId -> MessageWindowChatMemory.builder()
                .id(memoryId)
                .maxMessages(maxMessages)
                .chatMemoryStore(chatMemoryStore)
                .build();
    }

    @Bean
    public Assistant assistant(ChatMemoryProvider chatMemoryProvider,
                               @Value("${app.llm.base-url}") String baseUrl,
                               @Value("${app.llm.api-key}") String apiKey,
                               @Value("${app.llm.model}") String modelName) {

        ChatModel chatModel = OpenAiChatModel.builder()
                .baseUrl(baseUrl)
                .apiKey(apiKey)
                .modelName(modelName)
                .build();

        return AiServices.builder(Assistant.class)
                .chatModel(chatModel)
                .chatMemoryProvider(chatMemoryProvider)
                .build();
    }
}
```

`ChatMemoryProvider` 是个函数式接口，入参是 memoryId，返回一个绑定了该 ID 的 ChatMemory。注意每个会话拿到的都是新对象，但底层 store 是同一个单例，所以数据是共享的，隔离靠 `id`。

`baseUrl` 单独抽出来，是为了兼容国内那些 OpenAI 兼容接口。换成别的厂商，只改配置，代码不动。

### 3.4 对外接口

```java
package com.example.chatmemory.web;

import com.example.chatmemory.service.Assistant;
import dev.langchain4j.memory.ChatMemory;
import dev.langchain4j.store.memory.chat.ChatMemoryStore;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/chat")
public class ChatController {

    private final Assistant assistant;
    private final ChatMemoryStore chatMemoryStore;

    public ChatController(Assistant assistant, ChatMemoryStore chatMemoryStore) {
        this.assistant = assistant;
        this.chatMemoryStore = chatMemoryStore;
    }

    @PostMapping
    public ChatReply chat(@RequestBody ChatRequest request) {
        String answer = assistant.chat(request.memoryId(), request.message());

        ChatMemory memory = assistant.getChatMemory(request.memoryId());
        int cachedMessages = memory == null ? 0 : memory.messages().size();

        return new ChatReply(request.memoryId(), answer, cachedMessages);
    }

    @DeleteMapping("/{memoryId}")
    public void reset(@PathVariable String memoryId) {
        assistant.evictChatMemory(memoryId);
        chatMemoryStore.deleteMessages(memoryId);
    }
}
```

`reset` 里两行都不能少。第一行清 JVM 里的窗口对象，第二行删 Redis 键。只删 Redis，Map 里的对象还占着；只清 Map，Redis 里的历史下次还会被读回来。

两个 DTO 用 record，Java 21 直接写：

```java
package com.example.chatmemory.web;

public record ChatRequest(String memoryId, String message) {
}
```

```java
package com.example.chatmemory.web;

public record ChatReply(String memoryId, String answer, int messagesInWindow) {
}
```

`messagesInWindow` 只是给调试用的，能直观看到窗口有没有按预期增长和裁剪。生产环境可以去掉。

### 3.5 配置和验证

`application.yml`：

```yaml
server:
  port: 8080

spring:
  data:
    redis:
      host: 127.0.0.1
      port: 6379

app:
  llm:
    base-url: https://api.openai.com/v1
    api-key: ${OPENAI_API_KEY}
    model: gpt-4o-mini
  memory:
    max-messages: 20
    ttl: 7d
```

`ttl` 写 `7d` 是 Spring 的 Duration 简写，`7d`、`30m`、`10s` 都认。

启动后连发两轮，看它记不记得：

```bash
curl -s -X POST http://localhost:8080/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"memoryId":"user-1001:session-a","message":"我上周买的降噪耳机，想退货"}'
```

```bash
curl -s -X POST http://localhost:8080/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"memoryId":"user-1001:session-a","message":"刚才那个订单，退款要几天到账？"}'
```

第二句里没有任何"耳机""退货"的字眼，如果回答能接上"耳机退货"，说明历史确实进 prompt 了。

再去看 Redis：

```bash
redis-cli KEYS 'chat:memory:*'
redis-cli TTL chat:memory:user-1001:session-a
redis-cli GET chat:memory:user-1001:session-a
```

`TTL` 应该接近 604800 秒。`GET` 出来是一段 JSON 数组，每条消息带一个 `type` 字段，取值是 `USER`、`AI`、`SYSTEM`、`TOOL_EXECUTION_RESULT`，正文在内容数组里。看到这个结构就说明序列化走对了；如果看到的是一堆 `java.lang.String` 之类的东西，说明有人套了 JDK 序列化。

换个 memoryId 再发一句，历史应该是空的。这一步必须测，串号 bug 都是漏了这一步。

## 四、踩坑经验和最佳实践

**memoryId 绝对不能直接用前端传的值。**

这是最容易出事的一条。上面示例里前端传 `user-1001:session-a`，是为了演示方便。真实项目里，memoryId 必须由服务端从登录态推导：`userId + ":" + conversationId`，并且校验 conversationId 是否属于这个 userId。否则改个字符串就能读别人的聊天记录，Redis 里躺着的可能是手机号、地址、订单号。

**会话关闭要主动 evict，不能只靠 TTL。**

Redis 的 TTL 管不到 JVM 里的 `ConcurrentHashMap`。在线客服这种场景，一天几万个会话 ID，Map 里就是几万个对象，每个还挂着窗口配置。跑一周内存曲线就上去了。做法很简单：会话结束、用户登出、后台清理任务，都调一次 `evictChatMemory`。

**同一个 memoryId 并发请求会丢消息。**

`add()` 是"读全量 → 改 → 写回"，不是原子操作。两个请求同时进来，后写的覆盖先写的，用户发的话凭空消失。单机可以用 `ConcurrentHashMap<String, Lock>` 按 ID 分段加锁；多实例得上 Redis 分布式锁，或者干脆在网关层保证同一会话串行。别指望 Redis 事务，`WATCH` 重试写起来比重构还麻烦。

**按条数裁窗口，迟早被长文本打爆。**

20 条消息，如果用户粘贴了三段合同文本，一次请求就是几万 token，直接超上下文。这时候换 `TokenWindowChatMemory`：把 `ChatAssistantConfig` 里的 `MessageWindowChatMemory.builder()` 换成 `TokenWindowChatMemory.builder()`，把 `.maxMessages(maxMessages)` 换成 `.maxTokens(4000, new RoughTokenCountEstimator())`，其余不动。

LangChain4j 自带 `OpenAiTokenCountEstimator`，但它内部按模型名查编码表，遇到不认识的模型名（很多国产兼容接口的模型名它就没收录）会直接抛异常。用非 OpenAI 模型时，自己写一个估算器更稳：

```java
package com.example.chatmemory.memory;

import dev.langchain4j.data.message.ChatMessage;
import dev.langchain4j.data.message.ChatMessageSerializer;
import dev.langchain4j.model.TokenCountEstimator;

public class RoughTokenCountEstimator implements TokenCountEstimator {

    private static final int CHARS_PER_TOKEN = 4;

    @Override
    public int estimateTokenCountInText(String text) {
        if (text == null || text.isEmpty()) {
            return 0;
        }
        return (text.length() + CHARS_PER_TOKEN - 1) / CHARS_PER_TOKEN;
    }

    @Override
    public int estimateTokenCountInMessage(ChatMessage message) {
        return estimateTokenCountInText(ChatMessageSerializer.messageToJson(message));
    }

    @Override
    public int estimateTokenCountInMessages(Iterable<ChatMessage> messages) {
        int total = 0;
        for (ChatMessage message : messages) {
            total += estimateTokenCountInMessage(message);
        }
        return total;
    }
}
```

`TokenCountEstimator` 不是函数式接口，三个方法都得实现，别想着用 lambda 糊过去。上面这个实现把消息转成 JSON 再数字符，中文按 4 字符 ≈ 1 token 粗算，误差有，用来卡上限够了。

**别把 ChatMemory 当聊天记录表。**

它是有损的：超窗就删，删了找不回来。要做审计、要做质检、要分析用户问了什么，得另建一张消息表，异步落库。记忆和留痕是两件事，混在一起早晚出问题。

**敏感信息别明文进 Redis。**

`GET` 一下就能看到全部对话。身份证、银行卡、手机号，要么入库前脱敏，要么整段加密。别等安全扫描提工单才想起来。

**`SystemMessage` 只有一条。**

用 `@SystemMessage` 注解就够了。手动往 memory 里再 `add` 一条不同的 SystemMessage，会把原来那条挤掉，提示词莫名其妙失效，查起来很费劲。

## 五、性能对比和技术选型

| 方案 | 重启后还在 | 多实例共享 | 每轮额外开销 | 清理方式 | 适用场景 |
|---|---|---|---|---|---|
| `InMemoryChatMemoryStore` | 否 | 否 | 0 | 随进程消失 | 单机 demo、单元测试 |
| Redis（本文方案） | 是 | 是 | 5 次网络往返 | TTL 自动 + 主动删除 | 生产环境默认选择 |
| MySQL / PostgreSQL | 是 | 是 | 5 次数据库往返 | 定时归档 | 需要审计、合规留痕 |
| 向量库 | 是 | 是 | 检索开销 | 手动 | 不适合，语义检索不等于对话历史 |

延迟这块给个量级参考：本地或同可用区 Redis，单次往返亚毫秒，5 次叠加 1～2 毫秒；一次大模型调用通常几百毫秒起步。记忆层的开销在这个量级下可以忽略。真正要小心的是跨机房部署，20 毫秒的 RTT 乘 5 就是 100 毫秒，用户能感觉到"这 AI 反应有点慢"。

选型建议很直接：

- 单机 POC、写单元测试，用 `InMemoryChatMemoryStore`，别折腾。
- 上生产就用 Redis。TTL 天然适配会话生命周期，运维成本几乎为零。
- 有合规要求，Redis 存热数据，异步写一份到 MySQL 做审计。别为了省一个组件，把审计和上下文混在一张表里。
- 向量库存对话是常见误区。它解决的是"找相似内容"，不是"按时间顺序还原这段对话"。两回事。

## 六、总结

记忆这件事，拆开看就三样东西：**窗口策略、存储介质、隔离键**。

窗口策略决定带多少历史，按条数还是按 token，取决于你的内容长度分布。存储介质决定重启和多实例下还在不在，Redis 是性价比最高的答案。隔离键决定谁会看到谁的历史，它必须来自可信的服务端上下文，不能来自请求参数。

LangChain4j 把这三点分得很干净。`ChatMemory` 管策略，`ChatMemoryStore` 管介质，`memoryId` 管隔离。换存储只需要实现三个方法，业务代码一行不用改。这也是我推荐用它而不是自己拼 prompt 的原因——自己拼，早晚要在某个需求里重写一遍窗口逻辑，然后踩一遍工具消息成对删除的坑。

上线前把这三件事做了：给 key 设 TTL、删会话时 evict JVM 缓存、同会话请求串行。剩下的，就是别忘了序列化要用官方那两个类。

## 参考资料

- [LangChain4j 官方文档：Chat memory](https://docs.langchain4j.dev/tutorials/chat-memory)
- [LangChain4j 官方文档：AI Services](https://docs.langchain4j.dev/tutorials/ai-services)
- [Redis 官方文档：EXPIRE](https://redis.io/docs/latest/commands/expire/)
- [Spring Boot 官方文档：NoSQL（Redis）](https://docs.spring.io/spring-boot/reference/data/nosql.html)

文 / 会编程的吕洞宾
