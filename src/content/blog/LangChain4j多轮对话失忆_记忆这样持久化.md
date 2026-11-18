---
title: "LangChain4j多轮对话失忆，记忆这样持久化"
date: 2026-11-13T20:00:00+08:00
category: "AI"
tags: ["AI", "langchain4j"]
---

> 用户上一句刚说"我用的 MySQL 8"，下一句 AI 就开始推荐 PostgreSQL。你去查日志，发现每次请求真的只发了当前这句话。换个思路把历史全塞进去，token 账单立刻翻三倍，进程一重启历史又全没了。多轮对话的记忆问题，本质不是模型笨，是你没给它一个像样的"记忆容器"。这篇文章把 LangChain4j 1.x 的 ChatMemory 拆开讲清楚，再给你三套能直接跑的落地方案。

## 一、这个问题到底是什么

**多轮对话失忆的根因是 LLM 天生无状态，模型不会替你记住任何东西。**

每次调用大模型，你发过去的是一整个 `messages` 数组。模型读完、生成、结束，然后忘得干干净净。所谓"记得上一轮"，全靠你在下一次请求里把上一轮的消息再发一遍。

明白了这一点，常见的四种翻车就都能对号入座了。

**第一种：只发当前问题。** 代码里每次 `chatModel.chat("...")` 都是新开一段对话。用户说"再改改刚才那段代码"，模型一脸茫然——它压根没见过"刚才那段"。

**第二种：无脑全量拼接。** 有人把数据库里所有历史记录拼成字符串塞进 prompt。第一轮 200 token，第十轮 2000 token，第五十轮直接顶爆上下文窗口，接口报 `maximum context length exceeded`。更贵的是钱：每一轮都在为前面几十轮重复付费。

**第三种：多用户共用一个记忆对象。** 这是最阴的 bug。你在 Service 里写了个 `private final ChatMemory memory = MessageWindowChatMemory.withMaxMessages(20)`，单例，全应用共享。A 用户聊完，B 用户进来第一句就是"根据我们刚才说的……"，然后吐出一段别人的需求。测试环境单用户跑不出来，上线就炸。

**第四种：记忆只存在内存里。** 服务一重启、一扩缩容、一滚动发布，用户所有上下文清零。用户感知就是"这 AI 怎么又失忆了"。

还有一个容易被忽略的点：**历史（history）和记忆（memory）不是一回事**。历史是用户界面上看到的完整聊天记录，一条不能少；记忆是喂给模型的那部分内容，可以裁剪、可以摘要、可以只保留最近几条。把两者混在一个表里，要么 UI 缺记录，要么 prompt 爆掉。

LangChain4j 给出的答案很直接：`ChatMemory` 负责"喂给模型什么"，`ChatMemoryStore` 负责"存到哪"。两者拆开，你就能各管各的。

## 二、底层原理到底怎么回事

**ChatMemory 就是一个带淘汰策略的消息列表，再挂一个可替换的存储后端。**

先看它装的是什么。LangChain4j 里一条消息是 `ChatMessage`，常见四种角色：

- `SystemMessage`：系统设定，比如"你是技术助手，回答用中文"
- `UserMessage`：用户说的
- `AiMessage`：模型回的，也可能带工具调用请求
- `ToolExecutionResultMessage`：工具执行完的结果

`ChatMemory` 把这些消息按顺序存成一个 `List`，对外只暴露四个方法：拿全部消息 `messages()`、追加一条 `add()`、清空 `clear()`、拿 ID `id()`。听起来简单，但它在背后偷偷做了三件正事。

**第一件：淘汰。** 列表不能无限长，所以有滑动窗口。LangChain4j 自带两种：

- `MessageWindowChatMemory`：按**条数**保留最近 N 条。实现最简单，但一条消息可能 10 个 token，也可能 3000 个 token，所以按条数根本控不住成本。官方文档自己都说它"mostly useful for fast prototyping"，适合快速验证。
- `TokenWindowChatMemory`：按**token 数**保留最近的窗口。它需要一个 `TokenCountEstimator` 来估算每条消息占多少 token，超了就从头淘汰。消息是不可分割的最小单位，一条消息塞不进窗口就整条丢掉，不会切成两半。

这两种都是"忘掉最老的"，区别只在度量单位。

**第二件：特殊照顾 SystemMessage。** 系统提示词是全局设定，不该被窗口淘汰掉。LangChain4j 的规则是：系统消息一旦加进来就永远保留；同时只允许存在一条；内容相同就忽略，内容不同就替换。默认新系统消息排在列表末尾，如果你希望它永远在第一条（很多模型对首条系统消息更敏感），建 memory 时打开 `alwaysKeepSystemMessageFirst(true)`。

**第三件：清理孤儿工具消息。** 如果一条带工具调用请求的 `AiMessage` 被淘汰了，后面那些对应的工具执行结果就成了"孤儿"。OpenAI 这类厂商会直接拒绝这种请求。LangChain4j 会自动把跟着的 `ToolExecutionResultMessage` 一起淘汰，省了你手工处理。

再看存储这一层。`ChatMemoryStore` 只有三个方法：

```java
List<ChatMessage> getMessages(Object memoryId);
void updateMessages(Object memoryId, List<ChatMessage> messages);
void deleteMessages(Object memoryId);
```

这里有个必须搞清楚的语义，很多人第一次写 Store 都栽在这：**`updateMessages` 收到的是全量列表，不是增量。** 一轮对话里它会被调用两次——用户消息加进去一次，模型回复加进去一次。你的实现必须能把存储里的内容**整体覆盖**成这一份列表。

还有一条更反直觉的：**被窗口淘汰的消息，也会从 Store 里消失。** 因为 `updateMessages` 传下来的列表本来就不含老消息。所以如果你要保留完整聊天记录做审计，得另外存一张 history 表，别指望 ChatMemoryStore。

最后是"怎么区分用户"。答案在 `memoryId`。`ChatMemoryStore` 的三个方法第一个参数都是它，`ChatMemory` 创建时的 `id` 也是它。上层 `AiServices` 用 `chatMemoryProvider` 按需创建：

```java
AiServices.builder(Assistant.class)
    .chatModel(chatModel)
    .chatMemoryProvider(memoryId -> MessageWindowChatMemory.builder()
        .id(memoryId)
        .maxMessages(20)
        .chatMemoryStore(store)
        .build())
    .build();
```

而接口方法上用 `@MemoryId` 标出哪个参数是身份标识：

```java
String chat(@MemoryId String userId, @UserMessage String message);
```

一个 `memoryId` 对应一个独立的记忆实例。用户 A 和用户 B 天然隔离。这就是解决"串话"的正确姿势：**别自己 new 单例 memory，交给 provider 按 id 创建。**

## 三、实战：手把手写代码

下面三段代码是一个递进关系：先跑通内存版，再换成 MySQL，最后换成 Redis 加 token 滑窗。你可以只挑自己需要的那段用。

### 示例一：内存版，先把多轮跑通

依赖只有四个：Web、LangChain4j 核心、OpenAI 集成、JDBC（后面换 MySQL 用）。版本全部写死，照抄能跑。

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
    <artifactId>chat-memory-demo</artifactId>
    <version>0.0.1-SNAPSHOT</version>

    <properties>
        <java.version>21</java.version>
        <langchain4j.version>1.23.0</langchain4j.version>
    </properties>

    <dependencies>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-web</artifactId>
            <version>4.1.2</version>
        </dependency>

        <dependency>
            <groupId>dev.langchain4j</groupId>
            <artifactId>langchain4j</artifactId>
            <version>1.23.0</version>
        </dependency>

        <dependency>
            <groupId>dev.langchain4j</groupId>
            <artifactId>langchain4j-open-ai</artifactId>
            <version>1.23.0</version>
        </dependency>

        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-jdbc</artifactId>
            <version>4.1.2</version>
        </dependency>

        <dependency>
            <groupId>com.mysql</groupId>
            <artifactId>mysql-connector-j</artifactId>
            <version>26.10.0</version>
            <scope>runtime</scope>
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

启动类没什么花活：

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

模型 Bean 单独配。注意接口名是 `ChatModel`，不是老版本里的 `ChatLanguageModel`：

```java
package com.example.chatmemory.config;

import dev.langchain4j.model.chat.ChatModel;
import dev.langchain4j.model.openai.OpenAiChatModel;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class AiConfig {

    @Bean
    public ChatModel chatModel(@Value("${app.openai.api-key}") String apiKey) {
        return OpenAiChatModel.builder()
                .apiKey(apiKey)
                .modelName("gpt-4o-mini")
                .temperature(0.7)
                .build();
    }
}
```

`api-key` 从配置里读，实际值放环境变量，别提交到仓库：

```yaml
app:
  openai:
    api-key: ${OPENAI_API_KEY}
```

助手接口只有一个方法，关键在于 `@MemoryId` 和 `@UserMessage` 这两个注解——前者告诉框架"这个参数是会话 ID"，后者告诉框架"这段文本是用户输入"。方法本身不写实现，`AiServices` 会在运行时生成代理：

```java
package com.example.chatmemory.assistant;

import dev.langchain4j.service.MemoryId;
import dev.langchain4j.service.SystemMessage;
import dev.langchain4j.service.UserMessage;

public interface Assistant {

    @SystemMessage("你是「脱凡白云阁」的技术助手。回答简洁，用中文，给能直接用的方案。")
    String chat(@MemoryId String userId, @UserMessage String message);
}
```

Service 里组装 `AiServices`。这里用的是 `MessageWindowChatMemory`，保留最近 20 条：

```java
package com.example.chatmemory.service;

import com.example.chatmemory.assistant.Assistant;
import dev.langchain4j.memory.chat.MessageWindowChatMemory;
import dev.langchain4j.model.chat.ChatModel;
import dev.langchain4j.service.AiServices;
import org.springframework.stereotype.Service;

@Service
public class ChatService {

    private final Assistant assistant;

    public ChatService(ChatModel chatModel) {
        this.assistant = AiServices.builder(Assistant.class)
                .chatModel(chatModel)
                .chatMemoryProvider(memoryId -> MessageWindowChatMemory.builder()
                        .id(memoryId)
                        .maxMessages(20)
                        .build())
                .build();
    }

    public String chat(String userId, String message) {
        return assistant.chat(userId, message);
    }
}
```

对外接口就是个普通 POST：

```java
package com.example.chatmemory.web;

import com.example.chatmemory.service.ChatService;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/chat")
public class ChatController {

    private final ChatService chatService;

    public ChatController(ChatService chatService) {
        this.chatService = chatService;
    }

    @PostMapping
    public ChatResponse chat(@RequestBody ChatRequest request) {
        return new ChatResponse(chatService.chat(request.userId(), request.message()));
    }

    public record ChatRequest(String userId, String message) {
    }

    public record ChatResponse(String answer) {
    }
}
```

跑起来之后，用同一个 `userId` 连发两轮，第二轮问"我刚才说我用的什么数据库"，它能答上来。换个 `userId` 再问，它就不知道了——这正是我们要的隔离效果。

### 示例二：换成 MySQL，重启不失忆

先建表。一条消息一行，`memory_id` 加索引，查询按自增 `id` 排序保证顺序：

```sql
CREATE TABLE chat_message (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    memory_id VARCHAR(64) NOT NULL,
    message_json TEXT NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_memory_id (memory_id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;
```

然后实现 `ChatMemoryStore`。序列化别自己写 JSON 映射，LangChain4j 自带 `ChatMessageSerializer` / `ChatMessageDeserializer`，能正确处理多态的消息类型和工具调用结构：

```java
package com.example.chatmemory.memory;

import dev.langchain4j.data.message.ChatMessage;
import dev.langchain4j.data.message.ChatMessageDeserializer;
import dev.langchain4j.data.message.ChatMessageSerializer;
import dev.langchain4j.store.memory.chat.ChatMemoryStore;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;

@Component
public class MysqlChatMemoryStore implements ChatMemoryStore {

    private final JdbcTemplate jdbcTemplate;

    public MysqlChatMemoryStore(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    @Override
    public List<ChatMessage> getMessages(Object memoryId) {
        List<String> jsons = jdbcTemplate.queryForList(
                "SELECT message_json FROM chat_message WHERE memory_id = ? ORDER BY id",
                String.class, String.valueOf(memoryId));
        return jsons.stream().map(ChatMessageDeserializer::messageFromJson).toList();
    }

    @Override
    @Transactional
    public void updateMessages(Object memoryId, List<ChatMessage> messages) {
        String key = String.valueOf(memoryId);
        jdbcTemplate.update("DELETE FROM chat_message WHERE memory_id = ?", key);
        for (ChatMessage message : messages) {
            jdbcTemplate.update(
                    "INSERT INTO chat_message (memory_id, message_json) VALUES (?, ?)",
                    key, ChatMessageSerializer.messageToJson(message));
        }
    }

    @Override
    public void deleteMessages(Object memoryId) {
        jdbcTemplate.update("DELETE FROM chat_message WHERE memory_id = ?", String.valueOf(memoryId));
    }
}
```

为什么是"先删后插"？因为 `updateMessages` 给的是全量列表，而窗口淘汰会让某些消息从列表里消失，只做插入的话数据库里会残留老消息，下次 `getMessages` 又把它们捞回来，窗口就白设了。删干净再按顺序插，数据库里的内容和内存里的窗口才一致。

代价是写放大：每条新消息都触发一次全表重写。20 条消息的会话还好，几百条就明显了。后面第五节讲怎么优化。

配置改动很小，把 `chatMemoryStore` 挂上就行：

```java
@Bean
public Assistant assistant(ChatModel chatModel, ChatMemoryStore chatMemoryStore) {
    return AiServices.builder(Assistant.class)
            .chatModel(chatModel)
            .chatMemoryProvider(memoryId -> MessageWindowChatMemory.builder()
                    .id(memoryId)
                    .maxMessages(30)
                    .chatMemoryStore(chatMemoryStore)
                    .build())
            .build();
}
```

`Assistant` 变成 Bean 之后，`ChatService` 直接注入它，构造方法里那堆 `AiServices.builder` 就可以删了。

数据库连接配置：

```yaml
spring:
  datasource:
    url: jdbc:mysql://localhost:3306/chat_demo?useUnicode=true&characterEncoding=utf8mb4
    username: root
    password: ${MYSQL_PASSWORD}
```

现在重启服务，同一个 `userId` 继续聊，它还记得前面说过什么。

### 示例三：Redis 存储 + 按 token 裁剪

客服、问答这类场景，用户量一大，"按条数"就控不住成本了。换成 `TokenWindowChatMemory`，同时把存储换成 Redis，读写都在毫秒级。

先写 Redis 版的 Store。一条会话用 Redis List 存，每个元素是一条消息的 JSON，顺便挂个 7 天过期，避免僵尸会话一直占内存：

```java
package com.example.chatmemory.memory;

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

    private static final Duration TTL = Duration.ofDays(7);

    private final StringRedisTemplate redis;

    public RedisChatMemoryStore(StringRedisTemplate redis) {
        this.redis = redis;
    }

    private String key(Object memoryId) {
        return "chat:memory:" + memoryId;
    }

    @Override
    public List<ChatMessage> getMessages(Object memoryId) {
        List<String> jsons = redis.opsForList().range(key(memoryId), 0, -1);
        if (jsons == null || jsons.isEmpty()) {
            return List.of();
        }
        return jsons.stream().map(ChatMessageDeserializer::messageFromJson).toList();
    }

    @Override
    public void updateMessages(Object memoryId, List<ChatMessage> messages) {
        String key = key(memoryId);
        redis.delete(key);
        if (messages.isEmpty()) {
            return;
        }
        List<String> jsons = messages.stream()
                .map(ChatMessageSerializer::messageToJson)
                .toList();
        redis.opsForList().rightPushAll(key, jsons);
        redis.expire(key, TTL);
    }

    @Override
    public void deleteMessages(Object memoryId) {
        redis.delete(key(memoryId));
    }
}
```

再改记忆策略。`maxTokens(3000, estimator)` 的意思是：窗口里所有消息加起来不超过 3000 token，超了就从最老的开始丢。估算器要和模型匹配，gpt-4o-mini 就用它自己的：

```java
@Bean
public Assistant assistant(ChatModel chatModel, ChatMemoryStore chatMemoryStore) {
    TokenCountEstimator estimator = new OpenAiTokenCountEstimator("gpt-4o-mini");

    return AiServices.builder(Assistant.class)
            .chatModel(chatModel)
            .chatMemoryProvider(memoryId -> TokenWindowChatMemory.builder()
                    .id(memoryId)
                    .maxTokens(3000, estimator)
                    .chatMemoryStore(chatMemoryStore)
                    .alwaysKeepSystemMessageFirst(true)
                    .build())
            .build();
}
```

需要补的依赖：

```xml
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-data-redis</artifactId>
    <version>4.1.2</version>
</dependency>
```

3000 token 大约能装下十几轮正常对话。如果你的系统提示词很长（比如带了一堆 RAG 指令），记得给它留出预算，别把窗口全占满。

## 四、踩坑经验和最佳实践

**别把 `ChatMemory` 做成单例字段。** 这是出现频率最高的错误，前面说过，后果是用户之间串话。正确做法永远是 `chatMemoryProvider` 加 `@MemoryId`，让框架按 ID 建实例。如果你不用 `AiServices`，而是自己手动 `chatMemory.add(...)`，那就在每次请求时用 store 按 `userId` 取，别缓存成成员变量。

**`memoryId` 的格式必须全局统一。** 我见过一个项目，写入时用 `userId.toString()`，读取时用了 `"user:" + userId`，结果读到的永远是空列表，AI 表现就是"每一轮都失忆"，日志还看不出错。建议在 Store 里做一个私有 `key()` 方法统一拼前缀，外面别碰。

**同一个 `memoryId` 的并发请求要加锁。** 两个请求同时进来，都读到 10 条旧消息，各自加一条新消息，然后各自全量覆盖——后写的把先写的覆盖掉，丢消息。单机可以用 `ConcurrentHashMap<String, Lock>` 按 ID 分段加锁；多实例部署就得用 Redis 分布式锁，锁的 key 跟 memoryId 绑。别用 `synchronized`，那玩意锁的是整个方法，吞吐直接崩。

**别把 `ChatMemoryStore` 当聊天记录表用。** 窗口淘汰的消息会同步从 Store 消失。产品经理哪天要"查看用户完整对话"，你翻数据库会发现只有最近 20 条。审计、风控、训练数据这些需求，从一开始就单独建 history 表，全量追加，永不删除。

**token 估算器不匹配会翻车。** `OpenAiTokenCountEstimator` 用的是 OpenAI 的分词器，你拿它去估算 DeepSeek 或通义千问的 token，误差可能有 10% 到 30%。窗口设 3000，实际可能发出去 3800，然后报超限。保守一点，给模型真实上下文窗口留 20% 余量；国产模型如果有官方 tokenizer，优先用官方的。

**`maxMessages` 设太大等于没设。** 我见过有人直接写 200，觉得"多记点总没错"。结果每轮请求都带着上万 token，延迟从 1 秒涨到 5 秒，账单也翻倍。正常客服场景 20 到 30 条足够，代码助手这种需要长上下文的，按 token 算更合适，别拍脑袋填数字。

**系统提示词别写在用户消息里。** 有人为了"省事"，每轮都在用户消息前面拼一段"你是某某助手"。这会把系统设定变成普通对话内容，窗口一淘汰就丢，而且模型对它的遵循度明显下降。用 `@SystemMessage`，LangChain4j 会保证它不被淘汰。

## 五、性能对比和技术选型

**选型先看两个维度：记忆放哪、窗口怎么裁。**

存储层的对比：

| 方案 | 读写延迟 | 重启保留 | 多实例共享 | 适用场景 |
| --- | --- | --- | --- | --- |
| 内存（默认） | 纳秒级 | 否 | 否 | 本地调试、单机 Demo |
| MySQL | 几毫秒 | 是 | 是 | 会话量中等、要和业务数据放一起 |
| Redis | 亚毫秒 | 是（配持久化） | 是 | 高并发在线对话、要 TTL 自动过期 |

窗口策略的对比：

- `MessageWindowChatMemory`：实现简单，按条数淘汰。适合快速验证和消息长度比较均匀的场景。
- `TokenWindowChatMemory`：成本可控，按 token 淘汰。在线服务我推荐这个，尤其是模型按 token 计费的时候。
- 摘要式记忆（自己实现）：把老对话压成一段摘要再塞回去。省 token 效果最好，但要多调一次模型，延迟和成本都得算进去，而且摘要有信息损失。除非对话特别长（比如几十轮的顾问式咨询），否则没必要上。

存储层我的建议很直接：**单机 Demo 用内存，正式项目用 Redis，需要跟订单、工单这些业务数据做关联查询就用 MySQL。** 两者也可以组合——Redis 存热会话，MySQL 存归档。

还有一个容易忽略的性能点：`updateMessages` 每轮调用两次，如果你的 Store 里做的是"删全表再插全表"，消息越多越慢。优化办法有两个：一是把整个会话序列化成一个 JSON 存一行，一次读写搞定；二是做增量 diff，只插新增的消息、只删被淘汰的消息。前者简单，后者快，看你的会话长度选。

## 六、总结

多轮对话失忆，从来不是模型能力问题，是你没给它记忆。LangChain4j 把这件事拆成了两层：`ChatMemory` 决定"喂给模型什么"，`ChatMemoryStore` 决定"存在哪里"。

记住四个要点就够了：

- 记忆不是一个全局变量，是**按 `memoryId` 隔离的实例**，用 `chatMemoryProvider` 建，用 `@MemoryId` 指定。
- 窗口一定要设，按条数适合原型，**按 token 适合上线**。
- `updateMessages` 传的是**全量列表**，实现要整体覆盖，被淘汰的消息也会从存储里消失。
- 要完整聊天记录，**另建 history 表**，别指望 ChatMemoryStore。

代码都在上面，三段可以直接拼起来跑。真正要动手的时候，先把 `@MemoryId` 和 `chatMemoryProvider` 这两处改对，剩下的就是换个 Store 实现的事。

文 / 会编程的吕洞宾

## 参考资料

- [LangChain4j Chat Memory 官方文档](https://docs.langchain4j.dev/tutorials/chat-memory/)
- [LangChain4j AI Services 官方文档](https://docs.langchain4j.dev/tutorials/ai-services)
- [LangChain4j GitHub 仓库](https://github.com/langchain4j/langchain4j)
