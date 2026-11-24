---
title: "Spring AI 2.1 会话记忆：别再把历史塞进 context，改成检索"
date: 2026-11-23 18:42:34
tags: ["AI", "Spring AI", "Agent", "会话记忆"]
categories: ai
---

# Spring AI 2.1 会话记忆：别再把历史塞进 context，改成检索

多轮对话跑长一点就出事：要么历史塞满窗口，模型开始忘前面说过什么；要么你写个摘要策略，把 30 轮压缩成三句话，然后用户问"我上次说的那个订单号是多少"，模型答不出来了。

这两件事的根子是同一个——你把"记住"和"能查到"当成一回事了。Spring AI 2.1 把它们拆开：历史是追加写入的日志，模型看到的是日志上的一个视图，而日志本身随时可以搜。

## 先说个坏消息

`ChatMemory` 那套 API——它的 repository、`MessageChatMemoryAdvisor`、连同对应的自动配置——**从 2.1.0 起废弃，3.0.0 移除**。官方给的替代是 Session Memory。

所以如果你现在还在用 `MessageChatMemoryAdvisor`，这不是"要不要升"的问题，是"这两年得搬"的问题。

`VectorStoreChatMemoryAdvisor` 没废弃，可以继续用。

## Session 跟 ChatMemory 差在哪

`ChatMemory` 干的事很简单：按 conversationId 存一个平铺的消息 List，取出来拼进 prompt。用完就完。

Session 换成**追加式事件日志**：

- 每条消息都是一个 `SessionEvent`，带 id、时间戳、所属 session 和 metadata，工具调用、压缩边界这些也记在同一个日志里
- 模型看到的 prompt 是日志的一个**视图**，不是全部
- 压缩只改视图，日志一个字不动

第三条是整个设计的支点。压缩不是"把旧消息删了、存个摘要"，而是往日志末尾追加一条 `COMPACTION` 事件，里面写着新的边界。视图是从最新边界往后投影出来的。旧消息全部还在。

这意味着两件事：**历史永远可追溯**，**压缩是可逆的**——出问题你能退回上一个边界。

## 上手

依赖就一个：

```xml
<dependency>
    <groupId>org.springframework.ai</groupId>
    <artifactId>spring-ai-starter-model-session-jdbc</artifactId>
    <version>2.1.0</version>
</dependency>
```

classpath 上有 DataSource 时，Spring Boot 会自动建 `JdbcSessionRepository` 和 `SessionService`，从数据库元数据里识别 SQL 方言。用 MySQL 或 PostgreSQL 在开发环境跑，得手动建表：

```properties
spring.ai.session.repository.jdbc.initialize-schema=always
```

接进 ChatClient：

```java
@Bean
ChatClient chatClient(ChatModel chatModel, SessionService sessionService) {
    return ChatClient.builder(chatModel)
        .defaultAdvisors(SessionAdvisors.builder(sessionService)
            .compaction(new TurnCountTrigger(20),
                        WindowCompactionStrategy.builder().lastTurns(10).build())
            .build())
        .build();
}

String answer = chatClient.prompt()
    .user("你好")
    .advisors(SessionAdvisors.session("session-abc"))
    .call()
    .content();
```

注意最后一行：**sessionId 每次调用必须传**。没有兜底。官方说得很直接——给个默认 session 会把不同用户的历史悄悄混在一起。

## 压缩：为什么必须按轮切

`TurnCountTrigger(20)` 是"攒到 20 轮就压一次"，`lastTurns(10)` 是"视图里留最近 10 轮"。

听起来像 `if (turns > 20) keepLast(10)`，但真正讲究的地方在切割点。

窗口给的是**原始切割线**，实际切之前要做两次修正：

1. **往前挪到下一轮的起点。** 切在轮中间，模型就会看到"一个没有结果的工具调用"或者"一个没有问题的回答"——这两样都能让模型崩。
2. **如果这一挪把全部内容都盖住了，就往回退到最新一轮的起点。** 最新一轮必须留着，哪怕它自己就超了窗口（一次很长的工具循环很容易这样）。

所以压缩不管怎么调，永远有两条保证：**视图从一轮的开头开始**，**最新一轮一定在**。

还有个细节容易踩：system message 处理。最新存的那条 system message 会被钉在视图最前面，永不参与摘要；更早的 system message 会被后来的取代，压缩时一起出视图。如果你把 system prompt 存在 session 里，token 预算得先扣掉它的份额，不然钉住的东西可能把正常对话挤没。

## 检索：这才是重点

历史能存下来不稀奇，麻烦的是**用户问的东西不在当前视图里**。

编译策略把前 20 轮压成摘要，用户突然问"我上次填的那个地址是哪个区"——摘要里不会有这么细的东西。ChatMemory 时代这里只能靠更大的窗口硬扛，或者上向量库另存一份。

2.1 的 Recall 直接给了一个关键词检索，把 `conversation_search` 当作工具交给模型：

```java
ChatClient client = ChatClient.builder(chatModel)
    .defaultAdvisors(SessionAdvisors.builder(sessionService)
        .sessionIdInToolContext(true)
        .build())
    .defaultTools(SessionRecallTools.builder(sessionService).build())
    .build();

String reply = client.prompt()
    .user("我之前说的那个收货地址是哪个区？")
    .advisors(SessionAdvisors.session(sessionId))
    .call()
    .content();
```

模型觉得需要翻旧账时自己会调这个工具。它接受三个参数：

- `query`：一个或多个关键词，逗号分隔。`invoice, refund` 是两个词；`invoice refund` 是这一个短语
- `match`：`any`（默认）还是 `all`
- `page`：第几页，0 开始

返回 JSON，从旧到新，带 `nextPage`。

**检索范围跟视图完全是两回事**，这点必须说清楚：

| | 视图（喂 prompt） | 检索 |
|---|---|---|
| 范围 | 最新边界之后 | 整个日志 |
| 内容 | 全部事件类型 | 只有消息的文本 |
| 跨 session | 单 session | 单 session |

所以压缩盖掉的东西，检索还能找到。这是这套设计的价值所在——压缩省 token，检索补回精度，两者不冲突。

不过也有几个必须知道的限制：

**工具调用的结果搜不到。** 检索只看消息文本，而 tool result 的数据不在文本里。想搜工具返回值，得自己先把必要信息写进消息里。

**摘要搜不到。** 只有原始消息能命中。摘要本身不进索引。

**第一次检索最多翻到第 1000 条**，更后面的页直接拒绝。这是给单次查询成本封顶。

**非 ASCII 靠数据库排序规则。** MySQL/MariaDB 默认忽略重音，`cafe` 能搜到 `café`，PostgreSQL 搜不到。中文分词取决于存储层，这块别指望开箱即用。

**搜索结果会把问题本身搜出来。** 因为检索覆盖当前轮，你在问的那句也在日志里，可能命中自己。

## sessionIdInToolContext 的坑

上面代码里那个 `.sessionIdInToolContext(true)` 不是随便加的。

工具要从 tool context 里拿 sessionId，默认情况下得你自己每次塞：

```java
.advisors(SessionAdvisors.session(sessionId))
.toolContext(Map.of(SessionRecallTools.SESSION_ID_CONTEXT_KEY, sessionId))
```

开了这个开关，turn advisor 会自动帮你放，只传一次。听起来是纯收益，但官方把话说得很清楚：**tool context 不是会话工具专用的，它会发给这次调用的每一个工具**。

后果有两条：

- 所有吃 `ToolContext` 的工具都能看到 sessionId
- **MCP server 会收到它**——Spring AI 把 tool context 的条目当工具调用的 metadata 发过去

第二条挺要命。如果 session id 里有用户信息，等于你每个 MCP 工具调用都在往外抖用户标识。要堵的话，自己声明一个转换器把它摘掉：

```java
@Bean
ToolContextToMcpMetaConverter toolContextToMcpMetaConverter() {
    ToolContextToMcpMetaConverter defaults = ToolContextToMcpMetaConverter.defaultConverter();
    return toolContext -> {
        Map<String, Object> meta = new HashMap<>(defaults.convert(toolContext));
        meta.remove(SessionRecallTools.SESSION_ID_CONTEXT_KEY);
        return meta;
    };
}
```

另一个副作用反着想其实算好处：没开这个开关时，工具带 `ToolContext` 参数而调用没给 context，Spring AI 会直接抛 `IllegalArgumentException`；开了之后 context 永远不空，工具能跑，只是里面除了 sessionId 啥也没有。要不要接受这个，看你的工具依赖多少 context 里的东西。

## 生产上还得配的几件事

**摘要模型单独配。** 默认摘要走主 ChatModel，长对话里这个开销不小。`ChatModelSummarizer` 支持单独指定 `ChatOptions`，换个小模型：

```java
.summarizer(ChatModelSummarizer.builder(chatModel)
    .chatOptions(ChatOptions.builder().model("small-model").build())
    .overlapSize(2)
    .build())
```

摘要调用不经过 advisor，也不会被存成对话——它是一次性内部调用。

**摘要失败不能丢历史。** 模型调用挂了，或者返回空，日志里只记 WARN，视图不变。`onSummarizationFailure` 可以挂个回调做告警。这条设计很稳：宁可这一轮多花 token，也不能把上下文搞丢。

**跨实例**。视图是从日志投影出来的，日志在 JDBC 里，所以这一轮可以在 A 实例跑，下一轮在 B 实例跑。@Transactional 别把整个 turn 包太死，压缩是写日志，别和业务事务搅一起。

**别自己写内存实现上生产。** `InMemorySessionRepository` 明说了只用于测试和演示：重启就丢，多实例不共享。

## 什么时候还用不上

如果你的场景是客服机器人，一轮一问一答，没有跨轮引用，那 `VectorStoreChatMemoryAdvisor` 就够，别为了新 API 上这套。Session 复杂度换的是"长对话 + 需要回溯"的能力。

真的长对话、真的需要用户提到三天前的事、真的跑多个实例——那这套是对症的。

## 参考资料

- [Session Memory](https://docs.spring.io/spring-ai/reference/api/session.html)
- [Chat Memory（含迁移动线）](https://docs.spring.io/spring-ai/reference/api/chat-memory.html)
- [Recall：会话检索与 conversation_search 工具](https://docs.spring.io/spring-ai/reference/api/session/recall.html)
- [Compaction：触发、窗口与摘要](https://docs.spring.io/spring-ai/reference/api/session/compaction.html)
- [Spring AI 2.1.0 发布说明](https://github.com/spring-projects/spring-ai/releases/tag/v2.1.0)
