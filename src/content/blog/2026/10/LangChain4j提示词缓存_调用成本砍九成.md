---
title: "LangChain4j 提示词缓存，调用成本砍九成"
date: 2026-10-13T20:00:00+08:00
category: "AI"
tags: ["langchain4j"]
---

**摘要：** 在 Java 里用 LangChain4j 给 Anthropic 模型开启提示词缓存，让重复的系统提示词和工具定义不再每次重新计费。本文讲清缓存原理，用 cacheSystemMessages、cacheTools、cacheAutomatically 三个开关落地，附完整可运行代码和 token 账单实测。

> 你写了个客服机器人：一段两千字的系统提示词，外加二十个工具定义，用户每问一句，这堆东西就原封不动重发一遍。用户问十句，它就发十遍，每遍都按输入 token 计费。对话越长、工具越多，账单涨得越快，首字响应也一直慢。最冤的是，这段前缀每次一模一样，模型却每次都在从头算。LangChain4j 给 Anthropic 模型接上了提示词缓存，开几个开关就能让服务端把这段前缀记下来复用，重复部分的输入价格能掉到约十分之一。

## 一、这个问题到底是什么

大模型的账单按 token 算，而且是每发一次请求，就要把所有上下文从头到尾重新算一遍。

token 是模型处理文本的最小单位。一个英文单词大约一到两个 token，一个汉字通常一到两个 token。你发过去的每一段文字——系统提示词、工具说明书、历史对话、用户这一句提问——都要先被读进去，这部分叫输入 token；模型吐回来的回答叫输出 token。两者分开计价，输入通常便宜，输出通常贵。

真正的麻烦在于，大模型本身是**无状态**的。它不记得你上一句说过什么，每次请求本质上都是一份完整的、从零开始的输入。你想让它扮演"按公司规范回答的 Java 售后助手"，就得把那段规范每次重新贴给它。

重复的量有多大？算一笔账：

- 系统提示词：约 2000 token
- 工具定义（20 个）：约 1500 token
- 历史对话：约 3000 token
- 用户这一句：约 100 token

一次请求输入约 6600 token。每天一万次请求，其中约 3500 token 的前缀是固定不变的，等于每天白花三千五百万 token 的钱。这些 token 不是买到了更好的答案，只是让模型重新确认一遍"我是谁、我能用什么工具"。

延迟也一起被拖累。模型处理输入要先把整段内容算成内部状态，再开始逐字生成。前缀越长，这个准备阶段越久，用户盯着转圈的时间就越长。而对于一个 Agent 应用，一轮对话里模型可能被调用五次、十次，每次都要把这堆前缀重算一遍——重复的乘法，就是这么来的。

**这类开销是可以消掉的**，前提是那段前缀本身足够稳定。系统提示词、工具列表、开头几轮对话，往往在整段会话里都不变，这正是提示词缓存能发挥作用的地方。

## 二、底层原理到底怎么回事

**提示词缓存的本质，是让模型服务商把"不变的前缀"只算一次，把中间结果存下来，下次遇到相同开头直接搬用。**

模型处理一次输入分两个阶段：先把整段输入算成内部的中间状态，这段计算量最大，叫 prefill；再从最后一个 token 开始，一个一个字往外吐，叫 decode。缓存省掉的就是 prefill。

服务端不会自己猜"哪一段该缓存"。它靠你在提示词里插**断点**（cache breakpoint）。断点之前的内容会被存进缓存，下次请求只要开头逐字一致，就直接从缓存读，跳过重算。

几个必须记住的规则：

**匹配是严格前缀匹配。** 从头开始，一个 token 都不能差。顺序固定为 工具 → 系统提示词 → 消息列表。你在系统提示词里塞了一句当前时间，或者工具顺序换了一下，那处往后的内容全部作废，缓存命中直接归零。

**有最小长度门槛。** 太短的提示词不值得存。官方要求前缀达到模型专属的最小长度，不同模型在 512 到 4096 token 之间。一段几百字的提示词，很可能压根不参与缓存。

**一次请求最多 4 个断点。** 超了会被拒绝。

**缓存有生命周期。** 默认存 5 分钟，每次命中都会把这个计时器刷新。请求间隔经常超过 5 分钟的场景（用户慢慢打字、离线批处理），可以用 1 小时档。

**读写价格不一样。** 写入缓存比普通输入贵一点：5 分钟档大约是 1.25 倍，1 小时档大约是 2 倍。读取缓存则便宜得多，大约是普通输入价的十分之一。所以缓存只在"同一段前缀被反复使用"时才划算——只调用一次的提示词，写缓存纯属倒贴钱。

LangChain4j 没有重新发明一套概念，它只是把 Anthropic 的断点翻译成了几个开关：

- `cacheSystemMessages(true)`：给最后一条系统消息打上断点标记，它之前的内容（也就是系统提示词）会被缓存。
- `cacheTools(true)`：给最后一个工具定义打断点。
- 这两个断点位置每次请求都一样，所以哪怕对话没有历史、每次都独立调用，它们也照样生效。因为工具排在系统消息前面，系统消息这个断点其实已经顺带把工具缓存了；单独再开工具断点，是为了在系统消息偶尔变动时仍保住工具那一段。
- `cacheAutomatically(true)`：断点放在请求的最后一块，并随对话变长自动往前挪。这样每一轮请求都能读到上一轮发过的全部内容。它只在"本轮请求以完整的历史开头"时才划算，用滑动窗口把老消息挤掉的内存策略，开了反而更贵。
- 想手动标某一条消息，用户消息有可变的 attributes 表：`userMessage.attributes().put("cache_control", "ephemeral")`；模型消息和工具结果消息的 attributes 不可变，得用 `toBuilder().attributes(Map.of("cache_control", "ephemeral"))` 重新构造。

效果怎么看？Anthropic 返回的用量对象里多两个字段：**cacheCreationInputTokens**（这一轮写进缓存的 token 数）和 **cacheReadInputTokens**（这一轮从缓存读到的 token 数）。前者只在第一次出现，后者从第二轮开始就该涨起来。这两个数字就是你判断缓存有没有生效的唯一依据。

## 三、实战：手把手写代码

### 例一：最小可跑，缓存系统提示词

先看依赖。LangChain4j 的核心接口和实现拆在不同 artifact 里，Anthropic 的实现在 `langchain4j-anthropic`。

```xml
<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
    <modelVersion>4.0.0</modelVersion>

    <groupId>com.example</groupId>
    <artifactId>lc4j-prompt-cache-demo</artifactId>
    <version>1.0.0</version>

    <properties>
        <maven.compiler.source>21</maven.compiler.source>
        <maven.compiler.target>21</maven.compiler.target>
        <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
    </properties>

    <dependencies>
        <dependency>
            <groupId>dev.langchain4j</groupId>
            <artifactId>langchain4j</artifactId>
            <version>1.22.0</version>
        </dependency>
        <dependency>
            <groupId>dev.langchain4j</groupId>
            <artifactId>langchain4j-anthropic</artifactId>
            <version>1.22.0</version>
        </dependency>
        <dependency>
            <groupId>org.slf4j</groupId>
            <artifactId>slf4j-simple</artifactId>
            <version>2.0.20</version>
        </dependency>
    </dependencies>

    <build>
        <plugins>
            <plugin>
                <groupId>org.codehaus.mojo</groupId>
                <artifactId>exec-maven-plugin</artifactId>
                <version>3.6.4</version>
                <configuration>
                    <mainClass>com.example.cache.MinimalCachingDemo</mainClass>
                </configuration>
            </plugin>
        </plugins>
    </build>
</project>
```

下面这个类，把同一段系统提示词发三遍，每遍打印一次用量，你就能亲眼看到第二轮起缓存命中。

```java
package com.example.cache;

import dev.langchain4j.data.message.SystemMessage;
import dev.langchain4j.data.message.UserMessage;
import dev.langchain4j.model.anthropic.AnthropicChatModel;
import dev.langchain4j.model.anthropic.AnthropicTokenUsage;
import dev.langchain4j.model.chat.ChatModel;
import dev.langchain4j.model.chat.request.ChatRequest;
import dev.langchain4j.model.chat.response.ChatResponse;
import dev.langchain4j.model.output.TokenUsage;

import java.util.List;

public class MinimalCachingDemo {

    // 真实项目里这里通常是上千字的产品规范。
    // 注意：提示词本身要超过模型的最小可缓存长度，太短的话开开关也没用。
    private static final String SYSTEM_PROMPT = """
            你是一名 Java 后端技术顾问，只回答与 Java、Spring 生态相关的问题。
            回答要求：
            1. 先给结论，再给理由，最后给可运行的最小代码示例；
            2. 涉及版本时以 Maven Central 上的 GA 版本为准，不推荐 RC 或 SNAPSHOT；
            3. 不确定的内容要明确说"不确定"，不要编造 API；
            4. 不要使用"众所周知""显而易见"这类词；
            5. 代码必须包含完整的 import，禁止写省略号占位。
            输出语言：简体中文。语气：直接、克制，像一个同事在给你讲技术。
            如果问题超出 Java 技术范围，礼貌拒答，并说明你只负责 Java 方向。
            """;

    public static void main(String[] args) {
        ChatModel model = AnthropicChatModel.builder()
                .apiKey(System.getenv("ANTHROPIC_API_KEY"))
                .modelName("claude-sonnet-4-5")
                .maxTokens(512)
                .cacheSystemMessages(true)   // 系统提示词作为缓存断点
                .cacheTools(true)            // 工具定义也作为缓存断点
                .logRequests(true)
                .logResponses(true)
                .build();

        String[] questions = {
                "值不值得给一个内部工具开缓存？",
                "如果提示词里带了当前时间，会发生什么？",
                "一次请求最多能标几个缓存断点？"
        };

        for (int i = 0; i < questions.length; i++) {
            ChatRequest request = ChatRequest.builder()
                    .messages(List.of(
                            SystemMessage.from(SYSTEM_PROMPT),
                            UserMessage.from(questions[i])))
                    .build();

            ChatResponse response = model.chat(request);
            printUsage(i + 1, response);
        }
    }

    private static void printUsage(int round, ChatResponse response) {
        TokenUsage usage = response.tokenUsage();

        int cacheWrite = 0;
        int cacheRead = 0;
        if (usage instanceof AnthropicTokenUsage anthropicUsage) {
            cacheWrite = orZero(anthropicUsage.cacheCreationInputTokens());
            cacheRead = orZero(anthropicUsage.cacheReadInputTokens());
        }

        System.out.printf(
                "第 %d 轮 | 输入 %d | 输出 %d | 写缓存 %d | 读缓存 %d%n",
                round,
                orZero(usage.inputTokenCount()),
                orZero(usage.outputTokenCount()),
                cacheWrite,
                cacheRead);
    }

    private static int orZero(Integer value) {
        return value == null ? 0 : value;
    }
}
```

运行：

```bash
ANTHROPIC_API_KEY=你的密钥 mvn -q compile exec:java
```

预期输出大致是这样（数字随模型和提示词长度浮动）：

```text
第 1 轮 | 输入 1180 | 输出 96 | 写缓存 1105 | 读缓存 0
第 2 轮 | 输入 1180 | 输出 74 | 写缓存 0    | 读缓存 1105
第 3 轮 | 输入 1180 | 输出 88 | 写缓存 0    | 读缓存 1105
```

第一轮把系统提示词写进缓存，读缓存是 0；第二轮起写缓存归零、读缓存稳定在 1105，这就是缓存命中的样子。注意**输入总 token 数没变**，变的是这堆 token 的计价方式——读取价只有原价的一成左右。

### 例二：多轮对话，让断点跟着对话走

单次对话还不够典型。多轮问答和 Agent 工具循环，才是缓存省钱的主战场。关键是把 `cacheAutomatically` 打开，让断点自动前移。

```java
package com.example.cache;

import dev.langchain4j.data.message.AiMessage;
import dev.langchain4j.data.message.ChatMessage;
import dev.langchain4j.data.message.SystemMessage;
import dev.langchain4j.data.message.UserMessage;
import dev.langchain4j.model.anthropic.AnthropicChatModel;
import dev.langchain4j.model.anthropic.AnthropicTokenUsage;
import dev.langchain4j.model.chat.ChatModel;
import dev.langchain4j.model.chat.request.ChatRequest;
import dev.langchain4j.model.chat.response.ChatResponse;
import dev.langchain4j.model.output.TokenUsage;

import java.util.ArrayList;
import java.util.List;

public class MultiTurnCachingDemo {

    private static final String SYSTEM_PROMPT = """
            你是一名为 Java 团队做技术评审的顾问。
            每次回答都要包含：结论、依据、风险点三部分。
            回答尽量短，超过 200 字就分点。
            只为 Java / Spring 生态的问题提供意见。
            """;

    public static void main(String[] args) {
        ChatModel model = AnthropicChatModel.builder()
                .apiKey(System.getenv("ANTHROPIC_API_KEY"))
                .modelName("claude-sonnet-4-5")
                .maxTokens(1024)
                .cacheSystemMessages(true)
                .cacheTools(true)
                .cacheAutomatically(true)  // 断点跟着对话增长自动前移
                .cacheTtl("1h")            // 用户回消息间隔较长，用 1 小时档
                .build();

        List<ChatMessage> messages = new ArrayList<>();
        messages.add(SystemMessage.from(SYSTEM_PROMPT));

        String[] turns = {
                "我们打算把接口签名从 token 换成 API Key，你觉得风险在哪？",
                "那如果把旧 token 保留三个月做兼容，会有什么问题？",
                "按你说的，给我一个灰度下线的步骤。"
        };

        for (int i = 0; i < turns.length; i++) {
            messages.add(UserMessage.from(turns[i]));

            ChatResponse response = model.chat(
                    ChatRequest.builder().messages(messages).build());

            AiMessage aiMessage = response.aiMessage();
            // 把模型回答追加回历史，下一轮请求就是"以完整历史开头"，缓存才读得到
            messages.add(aiMessage);

            report(i + 1, messages.size(), response.tokenUsage());
        }
    }

    private static void report(int turn, int messageCount, TokenUsage usage) {
        int cacheRead = 0;
        int cacheWrite = 0;
        if (usage instanceof AnthropicTokenUsage anthropicUsage) {
            cacheRead = orZero(anthropicUsage.cacheReadInputTokens());
            cacheWrite = orZero(anthropicUsage.cacheCreationInputTokens());
        }
        System.out.printf(
                "第 %d 轮 | 消息数 %d | 输入 %d | 写缓存 %d | 读缓存 %d%n",
                turn, messageCount,
                orZero(usage.inputTokenCount()), cacheWrite, cacheRead);
    }

    private static int orZero(Integer value) {
        return value == null ? 0 : value;
    }
}
```

这里有两个细节决定成败。

一是**必须把模型的回答追加回 `messages`**。自动缓存的逻辑是"本轮请求以上一轮发过的完整内容开头"，如果你每轮都只发系统提示词 + 当前问题，历史根本不在请求里，缓存自然读不到。

二是**别在每轮请求里改动前缀**。系统提示词里写"当前时间：<实时时刻>"，下一轮就变成了新时间，前缀从此处断开，前面全部作废。动态信息要么放在用户消息里，要么放在系统提示词的最末尾之后。

### 例三：Spring Boot 里做成 Bean

Spring 项目里的做法是把配好缓存的模型注册成一个 Bean，各处注入即可。这里不引额外的 starter，纯手工装配，避免多一层自动配置的黑盒。

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
    <artifactId>lc4j-cache-spring-demo</artifactId>
    <version>1.0.0</version>

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
            <groupId>dev.langchain4j</groupId>
            <artifactId>langchain4j-anthropic</artifactId>
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

配置类和控制器：

```java
package com.example.cache.spring;

import dev.langchain4j.model.anthropic.AnthropicChatModel;
import dev.langchain4j.model.chat.ChatModel;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class ChatModelConfig {

    // 一份固定不变的系统提示词，是全应用共享的缓存前缀
    static final String SYSTEM_PROMPT = """
            你是公司内部的 Java 技术助手，只回答 Java、Spring、Redis 相关问题。
            回答格式：结论 / 依据 / 示例代码。
            代码必须是完整类，不能有省略号。
            不确定就不要编，直接说不知道。
            """;

    @Bean
    public ChatModel cachedChatModel(@Value("${anthropic.api-key}") String apiKey) {
        return AnthropicChatModel.builder()
                .apiKey(apiKey)
                .modelName("claude-sonnet-4-5")
                .maxTokens(1024)
                .cacheSystemMessages(true)
                .cacheTools(true)
                .build();
    }
}
```

```java
package com.example.cache.spring;

import dev.langchain4j.data.message.SystemMessage;
import dev.langchain4j.data.message.UserMessage;
import dev.langchain4j.model.anthropic.AnthropicChatRequestParameters;
import dev.langchain4j.model.chat.ChatModel;
import dev.langchain4j.model.chat.request.ChatRequest;
import dev.langchain4j.model.chat.response.ChatResponse;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

@RestController
@RequestMapping("/chat")
public class ChatController {

    private final ChatModel chatModel;

    public ChatController(ChatModel chatModel) {
        this.chatModel = chatModel;
    }

    @PostMapping
    public String chat(@RequestParam("q") String question) {
        // 模型级开关已经打开，这里演示按次覆盖：这次调用强制缓存系统提示词
        AnthropicChatRequestParameters parameters = AnthropicChatRequestParameters.builder()
                .cacheSystemMessages(true)
                .cacheTools(true)
                .build();

        ChatRequest request = ChatRequest.builder()
                .messages(List.of(
                        SystemMessage.from(ChatModelConfig.SYSTEM_PROMPT),
                        UserMessage.from(question)))
                .parameters(parameters)
                .build();

        ChatResponse response = chatModel.chat(request);
        return response.aiMessage().text();
    }
}
```

`application.yml` 里放密钥，别硬编码：

```yaml
anthropic:
  api-key: ${ANTHROPIC_API_KEY}
```

跑起来以后，同一个进程里连着问几个问题，第二问开始就是读缓存。这种"一个应用、一份系统提示词、大量用户请求"的结构，是缓存收益最明显的场景。

## 四、踩坑经验和最佳实践

**别把动态内容塞进缓存前缀。** 这是最常见的翻车点。系统提示词里写了当前时间、请求 ID、用户昵称，前缀每轮都在变，缓存命中率直接为零。动态信息一律放到用户消息里。

**工具定义的顺序和内容要稳定。** 用反射扫出来的 `@Tool` 方法，如果扫描顺序不稳定，工具列表每轮都可能不一样，缓存同样失效。生产环境最好显式指定工具集合，别依赖"刚好是那个顺序"。

**用了滑动窗口内存就别开自动缓存。** `MessageWindowChatMemory` 把老消息挤掉之后，本轮请求不再以完整历史开头，自动缓存只会让每轮都按写入价付费，读不回来，比不开还贵。这种情况只开 `cacheSystemMessages` 和 `cacheTools`。

**一次性调用别开自动缓存。** 没有历史、调用完就结束的场景，自动缓存没有任何东西可读，白白多付写入价。

**注意最小长度门槛。** 提示词太短不缓存。同一个功能在测试环境跑得好，上了生产却没省到钱，很可能就是提示词本身没到门槛。

**排查没命中用它。** LangChain4j 提供了 `returnCacheDiagnostics(true)`，开启后能拿到 Anthropic 的缓存诊断信息，告诉你这次为什么没命中（模型不对、前缀不匹配、长度不够等）。怀疑自己写错了前缀，开这个开关比猜快得多。

**1 小时档要用在刀刃上。** 只有"同一段前缀在一小时内会被读取好几次"才值得付 2 倍的写入价。用户十几分钟才回一句的客服场景，值得；一次性的批处理，不值得。

**兼容网关要留个心眼。** 自动缓存是通过请求顶层的 cache_control 字段下发的。有些 Anthropic 兼容网关或代理不认这个字段，可能直接报错或者忽略。遇到这种情况，退回手动标记系统消息、工具和具体消息，路径会更稳。

## 五、性能对比和技术选型

| 方案 | 输入 token 计费方式 | 首字延迟 | 适用场景 |
| --- | --- | --- | --- |
| 不开缓存 | 全部按原价 | 基线 | 一次性调用，前缀每次都不同 |
| 只开 cacheSystemMessages + cacheTools | 前缀按约 0.1 倍读取 | 明显下降 | 所有共享同一段系统提示词和工具定义的应用 |
| 再加 cacheAutomatically | 历史也走缓存读取 | 进一步下降 | 多轮对话、Agent 工具循环 |

三个开关不是绑定的，按需组合。经验上：

- 应用有一套固定的系统提示词和工具，无论有没有多轮对话，前两个都该开，这是纯赚。
- 有真正的多轮上下文，且每轮都带上完整历史，再考虑自动缓存。
- 对话历史会被裁剪、前缀会变的系统，自动缓存是净亏，别开。

选型上还有一层：**不是所有厂商都要你手动配**。OpenAI 的提示词缓存是自动生效的，输入超过一定长度就自动打折，代码不用改；DeepSeek 也有磁盘级上下文缓存，命中的部分按更低价格计费。Anthropic 则需要你显式打断点。这不是谁好谁坏，而是取舍：显式标记更可控，能精确控制缓存哪一段、存多久，代价是多写几行配置。

## 六、总结

提示词缓存解决的是一个很具体的问题：**同一段前缀被反复重算，重复付钱、重复等待。**

真正要记住的只有三件事。

第一，缓存是**严格前缀匹配**。前缀里任何一处变动，从变动点往后的内容全部作废。这决定了你的系统提示词必须"干净"——固定内容在前，动态内容在后。

第二，LangChain4j 用三个开关而不是一套新 API 来暴露这个能力：`cacheSystemMessages`、`cacheTools` 管固定前缀，`cacheAutomatically` 管增长的历史。谁该开、谁不该开，取决于你的前缀稳不稳定。

第三，**验证靠数字，不靠感觉**。盯住 `cacheReadInputTokens`，它从第二起重就应该涨起来；没涨，就是前缀没对齐。

缓存不是万能药。前缀只用到一次的场景，它就是个成本项。但只要你做的是面向很多用户的 AI 应用，"一份系统提示词、被成千上万次请求复用"几乎是必然结构，这时候把缓存打开，是投入产出比最高的一次优化。

## 参考资料

- [LangChain4j Anthropic 集成文档（含 Caching 章节）](https://docs.langchain4j.dev/integrations/language-models/anthropic)
- [LangChain4j 1.22.0 发布说明](https://github.com/langchain4j/langchain4j/releases/tag/1.22.0)
- [Anthropic 官方提示词缓存文档](https://docs.claude.com/en/docs/build-with-claude/prompt-caching)
- [DeepSeek 上下文硬盘缓存文档](https://api-docs.deepseek.com/guides/kv_cache)

文 / 会编程的吕洞宾
