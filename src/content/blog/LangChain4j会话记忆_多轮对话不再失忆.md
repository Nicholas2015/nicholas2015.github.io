---
title: "LangChain4j会话记忆：多轮对话不再失忆"
date: 2026-10-09T20:00:00+08:00
category: "AI"
tags: ["langchain4j"]
---

> 用户刚说完「我叫张三」，下一句问「我叫什么」，AI 却回答「抱歉，我不知道」。这不是模型笨，而是你每次都给它换了一本新的记忆本。这篇文章用 LangChain4j 把会话记忆讲清楚：默认为什么会失忆、记忆是怎么被管理和淘汰的、多用户对话为什么会串台，以及怎么把记忆落到 Redis，让服务重启后还能接着聊。

## 一、AI 为什么「聊两句就忘」

**大模型本身没有记忆，它是一个无状态的服务，每次都当作第一次见你。**

这是理解会话记忆的第一前提。你调用大模型，本质上是发一段完整的文本列表过去，模型根据这段文本算出回答，算完就忘。它不会在服务器上替你存任何东西。

所以，当你的代码这样写：

```java
ChatModel model = OpenAiChatModel.builder()
        .apiKey(System.getenv("OPENAI_API_KEY"))
        .modelName("gpt-4o-mini")
        .build();

String a1 = model.chat("我叫张三");
String a2 = model.chat("我叫什么？"); // 它只会看到这一句
```

第二次调用只发了「我叫什么？」这一句，模型手里没有「张三」这段上下文，自然答不出来。

**要让模型记住上下文，唯一的办法是把之前的对话一起发过去。** 你可以自己用一个 List 存历史消息，每次调用前拼进去，再把模型的回答也追加进去。这就是所有「会话记忆」的原始形态。但手动维护很痛苦：什么时候截断、怎么按用户分开、怎么持久化，全是坑。

LangChain4j 把这些脏活包成了 ChatMemory 抽象，它解决三件事：

- 存哪些消息（窗口大小、淘汰策略）
- 存在哪里（内存、Redis、数据库）
- 哪个用户用哪本记忆（多用户隔离）

有一个容易被忽略的点：**记忆（memory）不等于历史（history）**。历史是给用户看的完整聊天记录，一条都不能少；记忆是准备喂给模型的那部分内容，它可能被裁剪、被摘要、被补充。LangChain4j 只管记忆，不管历史。想留完整记录，得自己在业务表里存。

## 二、LangChain4j 会话记忆的底层原理

**LangChain4j 把会话记忆拆成三层：ChatMemory（存哪些）、ChatMemoryStore（存哪里）、ChatMemoryProvider（谁用哪本）。**

打个比方，会话记忆就像医院的病历本：

- ChatMemoryProvider 是挂号处，你报上病历号（memoryId），它给你发一本对应的病历本；
- ChatMemory 是这次带进诊室的那几页，只包含最近的关键记录；
- ChatMemoryStore 是档案柜，病历本的完整内容存在里面，随时可以调取。

下面一层层拆开看。

**第一层：ChatMemory，决定「发给模型哪些消息」。**

它内部就是一个 List<ChatMessage>，额外做了三件事：淘汰旧消息、特殊处理 SystemMessage、特殊处理工具消息。LangChain4j 内置两种实现：

- MessageWindowChatMemory：滑动窗口，只保留最近 N 条消息。简单，适合快速验证。
- TokenWindowChatMemory：按 token 数量保留最近的消息，更贴近模型的上下文上限。

为什么要淘汰消息？三个原因：模型的上下文窗口有上限，塞太多会被截断甚至报错；每个 token 都要花钱，历史越长单次调用越贵；token 越多，模型响应越慢。

ChatMessage 有四种类型，理解它们才能看懂记忆里到底存了什么：

| 类型 | 谁产生的 | 说明 |
| --- | --- | --- |
| SystemMessage | 你（开发者） | 设定角色和规则，永远保留，同一时间只有一条 |
| UserMessage | 用户 | 用户说的话 |
| AiMessage | 模型 | 模型的回答，可能带工具调用请求 |
| ToolExecutionResultMessage | 工具 | 工具执行结果 |

SystemMessage 会被特殊照顾：一旦加入就常驻；新的同内容系统消息会被忽略；内容不同则替换旧的。如果你用 @SystemMessage 注解写系统提示，LangChain4j 每次调用都会自动重新注入，你不用自己往记忆里塞。

**第二层：ChatMemoryStore，决定「记忆存在哪」。**

它是一个只有三个方法的接口：

- getMessages(memoryId)：取出某个记忆本的全部消息。每次调用模型前会调一次。
- updateMessages(memoryId, messages)：更新某个记忆本的消息。注意是**全量覆盖**，不是追加。每轮对话它会被调用两次——一次是加入用户消息时，一次是加入模型回复时。
- deleteMessages(memoryId)：清空某个记忆本，调用 clear() 时触发。

默认实现是内存存储，进程一重启全没了，多实例部署也各存各的。生产环境必须换成 Redis、MySQL 这类外部存储。好在 LangChain4j 提供了 ChatMessageSerializer / ChatMessageDeserializer 两个工具类，能直接把消息列表转成 JSON 字符串，序列化基本不用自己动脑。

还有个细节：被淘汰出 ChatMemory 的消息，也会从 Store 里一起删掉。靠的就是 updateMessages 传进来的那份「已经不含旧消息」的列表。

**第三层：ChatMemoryProvider，决定「谁用哪本」。**

它本质是一个函数：输入 memoryId，返回对应的 ChatMemory。AiServices 在每次方法调用前，会用 @MemoryId 标注的参数值去问 Provider 要记忆本。同一个 memoryId 拿到同一本，不同 memoryId 各拿各的——多用户隔离就是靠它实现的。

理解这三层，很多「记忆」相关的问题就能自己对号入座了：对话串台是 memoryId 用错了，重启丢记忆是 Store 用了默认内存实现，token 爆炸是 Memory 的淘汰策略没配。下面动手写代码。

## 三、实战：写一个不丢记忆的多用户对话服务

**目标是搭一个 Spring Boot 服务：多个用户各聊各的，互不串台，对话记忆存 Redis，重启也不丢。** 下面从依赖开始，一步步搭起来。

### 3.1 引入依赖

完整 pom.xml 如下，依赖版本全部写全，照抄能跑：

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
    <artifactId>chat-memory-demo</artifactId>
    <version>0.0.1-SNAPSHOT</version>
    <name>chat-memory-demo</name>

    <properties>
        <java.version>21</java.version>
    </properties>

    <dependencies>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-web</artifactId>
            <version>4.1.1</version>
        </dependency>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-data-redis</artifactId>
            <version>4.1.1</version>
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

### 3.2 第一步：先让单次对话记住上下文

先用最小代码验证「记忆」到底怎么工作。这个类不依赖 Spring，直接跑 main 方法：

```java
package com.example.demo.memory;

import dev.langchain4j.data.message.UserMessage;
import dev.langchain4j.memory.ChatMemory;
import dev.langchain4j.memory.chat.MessageWindowChatMemory;
import dev.langchain4j.model.chat.ChatModel;
import dev.langchain4j.model.chat.response.ChatResponse;
import dev.langchain4j.model.openai.OpenAiChatModel;

public class ChatMemoryDemo {

    public static void main(String[] args) {
        ChatModel model = OpenAiChatModel.builder()
                .apiKey(System.getenv("OPENAI_API_KEY"))
                .modelName("gpt-4o-mini")
                .build();

        // 记忆本：最多保留最近 10 条消息
        ChatMemory memory = MessageWindowChatMemory.builder()
                .maxMessages(10)
                .build();

        // 第一轮：用户自我介绍
        memory.add(UserMessage.from("我叫张三，是一名 Java 后端"));
        ChatResponse first = model.chat(memory.messages());
        memory.add(first.aiMessage());
        System.out.println("AI: " + first.aiMessage().text());

        // 第二轮：考验它记不记得
        memory.add(UserMessage.from("我叫什么？用什么语言？"));
        ChatResponse second = model.chat(memory.messages());
        memory.add(second.aiMessage());
        System.out.println("AI: " + second.aiMessage().text());
    }
}
```

这段代码在做三件事：创建模型；创建一个最多保留 10 条消息的记忆本；把用户消息和模型回复轮流塞进记忆本。关键点是 model.chat(memory.messages())——每次都把记忆本里的全部消息一起发给模型，所以第二轮它才答得出「你叫张三」。跑一下，第二句回答里会出现「张三」，说明记忆生效了。

这里每次都要手动 memory.add(...)，还是有点啰嗦。下面用 AiServices 把它也省掉。

### 3.3 第二步：多用户隔离

先定义一个 AI 服务接口。所有和模型的交互都收在这个接口里，业务代码只管调方法：

```java
package com.example.demo.service;

import dev.langchain4j.service.MemoryId;
import dev.langchain4j.service.SystemMessage;
import dev.langchain4j.service.UserMessage;

@SystemMessage("你是一个中文技术助手，回答简洁，并且记住用户之前说过的信息。")
public interface Assistant {

    String chat(@MemoryId String userId, @UserMessage String message);
}
```

@MemoryId 标在 userId 参数上，AI Service 就会拿这个值去要记忆本。@UserMessage 标注哪句话是用户输入。@SystemMessage 是系统提示，每轮自动注入。

再写配置类，把 Assistant 装配成 Spring Bean：

```java
package com.example.demo.config;

import com.example.demo.service.Assistant;
import dev.langchain4j.memory.chat.MessageWindowChatMemory;
import dev.langchain4j.model.chat.ChatModel;
import dev.langchain4j.model.openai.OpenAiChatModel;
import dev.langchain4j.service.AiServices;
import dev.langchain4j.store.memory.chat.ChatMemoryStore;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class AiConfig {

    @Bean
    public ChatModel chatModel() {
        return OpenAiChatModel.builder()
                .apiKey(System.getenv("OPENAI_API_KEY"))
                .modelName("gpt-4o-mini")
                .build();
    }

    @Bean
    public Assistant assistant(ChatModel chatModel, ChatMemoryStore chatMemoryStore) {
        return AiServices.builder(Assistant.class)
                .chatModel(chatModel)
                .chatMemoryProvider(memoryId -> MessageWindowChatMemory.builder()
                        .id(memoryId)
                        .maxMessages(20)
                        .chatMemoryStore(chatMemoryStore)
                        .build())
                .build();
    }
}
```

重点看 chatMemoryProvider：它是一个 lambda，来一个 memoryId，就现场造一本以它编号、上限 20 条、底层存进 chatMemoryStore 的记忆本。传进来的 chatMemoryStore 就是下一步要写的 Redis 实现。

### 3.4 第三步：把记忆存进 Redis

这是整件事里最值得自己写的一段。实现 ChatMemoryStore 三个方法，用 StringRedisTemplate 读写即可：

```java
package com.example.demo.memory;

import dev.langchain4j.data.message.ChatMessage;
import dev.langchain4j.data.message.ChatMessageDeserializer;
import dev.langchain4j.data.message.ChatMessageSerializer;
import dev.langchain4j.store.memory.chat.ChatMemoryStore;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Component;

import java.time.Duration;
import java.util.List;

@Component
public class RedisChatMemoryStore implements ChatMemoryStore {

    private static final String KEY_PREFIX = "chat:memory:";
    private static final Duration TTL = Duration.ofDays(7);

    private final StringRedisTemplate redis;

    public RedisChatMemoryStore(StringRedisTemplate redis) {
        this.redis = redis;
    }

    @Override
    public List<ChatMessage> getMessages(Object memoryId) {
        String json = redis.opsForValue().get(KEY_PREFIX + memoryId);
        if (json == null || json.isBlank()) {
            return List.of();
        }
        return ChatMessageDeserializer.messagesFromJson(json);
    }

    @Override
    public void updateMessages(Object memoryId, List<ChatMessage> messages) {
        String json = ChatMessageSerializer.messagesToJson(messages);
        redis.opsForValue().set(KEY_PREFIX + memoryId, json, TTL);
    }

    @Override
    public void deleteMessages(Object memoryId) {
        redis.delete(KEY_PREFIX + memoryId);
    }
}
```

三个方法各司其职：getMessages 读 JSON 再反序列化成消息列表；updateMessages 把整份消息序列化成 JSON 写回，顺便刷新 7 天过期时间；deleteMessages 直接删 key。序列化全部交给官方的 ChatMessageSerializer / ChatMessageDeserializer，避免自己拼 JSON 出错。

### 3.5 第四步：对外接口和配置

写一个 REST 接口，把 userId 和消息传进去，再提供一个清空记忆的接口：

```java
package com.example.demo.web;

import com.example.demo.service.Assistant;
import dev.langchain4j.store.memory.chat.ChatMemoryStore;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

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
    public Map<String, String> chat(@RequestParam String userId,
                                    @RequestParam String message) {
        String answer = assistant.chat(userId, message);
        return Map.of("userId", userId, "answer", answer);
    }

    @DeleteMapping("/{userId}")
    public Map<String, String> clear(@PathVariable String userId) {
        chatMemoryStore.deleteMessages(userId);
        return Map.of("userId", userId, "status", "cleared");
    }
}
```

启动类和配置文件：

```java
package com.example.demo;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class DemoApplication {

    public static void main(String[] args) {
        SpringApplication.run(DemoApplication.class, args);
    }
}
```

```yaml
spring:
  data:
    redis:
      host: localhost
      port: 6379
      timeout: 2s
```

Redis 里跑起来（本地没装的话，用 docker run -p 6379:6379 redis:7 起一个），然后验证多用户隔离：

```bash
curl -X POST "http://localhost:8080/api/chat?userId=u1&message=我叫张三"
curl -X POST "http://localhost:8080/api/chat?userId=u1&message=我叫什么？"
curl -X POST "http://localhost:8080/api/chat?userId=u2&message=我叫什么？"
```

前两句里，u1 的第二问能答出「张三」；第三句换成 u2，它就答不上来了。这就说明记忆按 userId 各存各的，不会串台。用 `redis-cli keys "chat:memory:*"` 还能看到每个用户一条 key。

## 四、踩坑经验和最佳实践

**会话记忆的坑，八成集中在「隔离、容量、持久化」这三个字上。**

**坑一：所有用户共用一本记忆。** 最常见的错误——chatMemoryProvider 里无脑返回同一个 ChatMemory 实例，结果 A 用户的问题，B 用户能接着聊。必须按 memoryId 生成独立记忆本。

**坑二：memoryId 直接用用户传入的原始字符串拼 Redis key。** 用户完全可以传一个带冒号、带换行的值，构造出意料之外的 key，甚至覆盖别人的记忆。做法是加固定前缀 + 校验格式，或者换成服务端生成的、不可猜测的会话 ID。

**坑三：不给记忆设上限。** 全程保留所有消息，几轮之后 token 暴涨，成本失控，还容易被超长上下文截断。至少配一个 maxMessages，重要的应用直接上 TokenWindowChatMemory。

**坑四：生产环境还在用默认的内存 Store。** 服务一重启，用户突然发现 AI 失忆；多实例负载均衡时，两次请求落到不同机器，记忆对不上。生产必须换 Redis/MySQL 这类外部存储。

**坑五：Redis key 不设过期。** 老会话越堆越多，内存被吃光。方案就是上面代码里的 TTL，比如 7 天没互动自动清理。

**坑六：自己手写消息的 JSON 序列化。** 消息类型多、字段多，手写极易解析失败。用官方的 ChatMessageSerializer / ChatMessageDeserializer，省心且稳定。

**坑七：异步或流式场景里，Store 阻塞了线程。** 官方的 ChatMemoryStore 有异步版本接口，高并发下值得实现异步方法，别让一次 Redis 读写卡住整条链路。

**坑八：同一个 memoryId 并发写。** updateMessages 是全量覆盖，两个请求同时写就可能互相盖掉、丢消息。必要时按 memoryId 加分布式锁，或者选用本身支持这种语义的存储方案。

归纳一下最佳实践：memoryId 按「用户 + 会话」维度拼（如 userId + ":" + conversationId）；一定设淘汰上限和 TTL；序列化用官方工具；生产别用内存 Store。

## 五、MessageWindow 与 TokenWindow 对比：记忆淘汰策略怎么选

**原型阶段用 MessageWindowChatMemory，生产环境更推荐 TokenWindowChatMemory，存储层一律换成 Redis 或数据库。**

| 维度 | MessageWindowChatMemory | TokenWindowChatMemory |
| --- | --- | --- |
| 淘汰依据 | 消息条数 | token 数量 |
| 配置项 | maxMessages | maxTokens + TokenCountEstimator |
| 优点 | 简单、零额外依赖 | 精准贴合上下文窗口，成本可控 |
| 缺点 | 每条消息长度不一，条数难控准 | 需要一个 token 计数器 |
| 适用场景 | 快速验证、消息长度均匀 | 生产、长文本、多工具调用 |

选型建议：

- 刚开始做 Demo，先用 MessageWindowChatMemory，把条数设保守一点（比如 10～20 条）。
- 上线且对话长短差异大，换 TokenWindowChatMemory，用所选模型的 token 计数器估算，把 maxTokens 控制在上下文窗口的七八成，留出输出空间。
- 存储层不要犹豫：内存 Store 只能用于本地验证，生产用 Redis 或 JDBC 持久化。
- 想省 token，还可以在记忆层做摘要压缩，把久远的对话压成一句话再保留，但这属于进阶玩法，先把窗口策略配对更重要。

## 六、总结

会话记忆的本质，是把「无状态的模型」包装出「好像记得你」的效果。LangChain4j 用三层把它拆得很清楚：ChatMemory 管存哪些消息，ChatMemoryStore 管存在哪里，ChatMemoryProvider 管谁用哪本。

动手路径也很简单：先用 ChatMemory 把上下文喂回模型，再用 @MemoryId 加 chatMemoryProvider 做多用户隔离，最后实现一个 RedisChatMemoryStore 把记忆持久化。三步做完，一个能记住上下文、不串台、重启不丢的多用户对话服务就成了。

真要说最容易翻车的地方，就一句话：**别让所有人共用一本记忆，也别把记忆只留在内存里。** 这两点做好，你已经躲过了八成的记忆类事故。

文 / 会编程的吕洞宾

## 参考资料

- [LangChain4j 官方文档：Chat Memory](https://docs.langchain4j.dev/tutorials/chat-memory/)
- [LangChain4j 官方文档：AI Services](https://docs.langchain4j.dev/tutorials/ai-services)
- [LangChain4j 官方文档：OpenAI 集成](https://docs.langchain4j.dev/integrations/language-models/open-ai)
