---
title: "LangChain4j声明式AI实战：接口即服务"
date: 2026-10-02T20:00:00+08:00
category: "AI"
tags: ["AI", "langchain4j"]
---

> 用过 LangChain4j 或 Spring AI 的人都有体会：调一次大模型，要手动拼 system prompt、手动塞历史消息、手动解析返回、手动维护会话。一段业务代码里全是字符串模板和 `List<ChatMessage>`，改一句提示词得翻三个文件。LangChain4j 的 AI Service 把这件事反过来了——你只写一个 Java 接口，框架在运行时生成实现，帮你拼 Prompt、管记忆、调工具。这篇文章讲清它背后的原理，再用三个可直接运行的示例带你落地。

## 一、手写 Prompt 的痛：AI Service 到底解决什么问题

结论先行：AI Service 的价值是把"和大模型对话"这件事，从一堆样板代码收敛成一个接口声明，让业务代码不再碰 Prompt 字符串和消息列表。

先看没有它的时候怎么写。用的是 LangChain4j 的 `ChatModel`，最朴素的一版长这样：

```java
List<ChatMessage> messages = new ArrayList<>();
messages.add(SystemMessage.from("你是一名电商客服"));
messages.add(UserMessage.from("用户问：" + question));
ChatResponse response = chatModel.chat(ChatRequest.builder().messages(messages).build());
String answer = response.aiMessage().text();
```

这段代码本身没错，问题是它会到处繁殖。一旦业务有十种对话场景，你就得写十份类似的结构；要加多轮记忆，得自己管 `List<ChatMessage>` 的增删和裁剪；要接入工具调用（让模型能查数据库、调接口），还得自己解析模型返回的 tool call、反射执行、把结果再喂回去。最后业务类里一半的代码在干"伺候模型"的活，真正跑业务的没几行。

**AI Service 换了个思路：用接口当契约。**

```java
interface Assistant {
    @SystemMessage("你是一名电商客服")
    String chat(@UserMessage String question);
}
```

你只声明"我要一个能对话的东西，系统人设是什么，用户输入放哪"。真正的实现由 `AiServices.builder()` 在运行时生成，是一个动态代理对象。调用 `assistant.chat("...")` 的时候，代理帮你去拼消息、发请求、取文本、更新记忆。

它解决的核心问题有三个：

- **消除样板代码**：Prompt 从散落的字符串，变成接口上的注解，一眼能看懂这个 AI 是干什么的。
- **记忆成为声明的一部分**：加不加记忆、窗口多大，是构建 AI Service 时的一个参数，不是散在业务里的 if-else。
- **工具调用只是多注册几个对象**：给 AI Service 挂上带 `@Tool` 注解的方法，模型就能"打电话"回来执行 Java 代码。

它适合什么场景？我推荐这几类：客服问答、内容生成、信息抽取（抽成 Java 对象）、需要挂工具的智能助手。反过来，如果你要精细控制每次请求的 `temperature`、`topP`、超时，或者要在运行时按业务动态换模型，那还是直接操作 `ChatModel` 更顺手。AI Service 是"声明式"的——声明式好用，代价是少了一部分细节控制权。

## 二、原理：一个接口是怎么变成 AI 调用的

结论先行：AI Service 本质是 JDK 动态代理 + 注解解析，代理对象在每次方法调用时，把"注解 + 参数 + 历史消息"组装成一次 ChatRequest，再把模型返回的文本转成方法声明的返回类型。

整个过程拆开只有四步，下面一步步走。

**第一步：构建阶段，扫描接口。**

`AiServices.builder(Assistant.class).chatModel(model).build()` 在启动时做两件事：一是校验配置（比如必须提供 `chatModel` 或 `streamingChatModel` 之一，否则直接报 "Please specify either chatModel or streamingChatModel"）；二是读取接口上的注解，把 `@SystemMessage` 的内容、`@UserMessage` 的模板、每个参数是 `@V` 变量还是 `@MemoryId`，都解析成一个内部的"调用计划"。这一步只做一次。

**第二步：调用阶段，本地包装成消息列表。**

当你调用 `assistant.chat("Redis 和 Memcached 选哪个？")`，代理做的事情是：

- 取出 `@SystemMessage` 的文本，生成一条 `SystemMessage`。
- 按 `@UserMessage` 的模板渲染用户消息，把 `@V` 标注的参数值填进 `{{变量名}}`。
- 如果配了记忆，从 `ChatMemory` 里把这个会话的历史消息取出来，拼在 system 消息之后。
- 组装成 `ChatRequest`。

**第三步：发请求 + 存档。**

`ChatRequest` 交给 `ChatModel`（底层就是 HTTP 调用 OpenAI 兼容接口）。拿到 `ChatResponse` 后，如果配了记忆，就把"这轮用户消息 + 这轮模型回复"追加回 `ChatMemory`，供下一次使用。

记忆的裁剪逻辑在 `MessageWindowChatMemory` 里，规则比想象中细：

- 它是滑动窗口，只保留最近 N 条消息，超了就丢最旧的。
- 系统消息是"钉子户"，一旦加进去就不会被淘汰。
- 如果被淘汰的是一条带工具调用请求的模型消息，紧跟其后的工具执行结果也会一起被清掉——因为 OpenAI 这类接口不允许出现"孤儿"工具结果消息，留着会直接报错。

**第四步：处理返回值。**

方法声明返回 `String`，就取 `aiMessage().text()`；声明返回自定义类型（比如一个 record），框架会要求模型按 JSON 输出，再反序列化成对象；声明返回 `TokenStream`，就走流式路径。

**工具调用多一个循环。** 挂上 `@Tool` 之后，流程变成：模型返回的不是文本，而是一个"我要调用 `weather(北京)`"的请求 → 框架用反射找到对应 Java 方法执行 → 把执行结果包成 `ToolExecutionResultMessage` 追加进消息 → 带着结果再问模型一次 → 模型这次给出自然语言回答。这个"问—执行—再问"的循环由框架接管，你看到的只是 `assistant.ask(...)` 返回了最终答案。

一句话总结原理：**接口是壳，动态代理是发动机，注解解析负责组装请求，ChatMemory 负责记住上下文，Tool 循环负责让模型能动手。**

## 三、实战：三个能直接跑的 LangChain4j AI Service 示例

结论先行：下面三个例子从最基础到带工具、带 Spring 装配，按顺序跑一遍，你就能把 AI Service 用在自己的项目里。

依赖版本都写全了，先看 `pom.xml`：

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
    <artifactId>langchain4j-ai-service-demo</artifactId>
    <version>1.0.0</version>

    <properties>
        <java.version>21</java.version>
    </properties>

    <dependencyManagement>
        <dependencies>
            <dependency>
                <groupId>dev.langchain4j</groupId>
                <artifactId>langchain4j-bom</artifactId>
                <version>1.20.2</version>
                <type>pom</type>
                <scope>import</scope>
            </dependency>
        </dependencies>
    </dependencyManagement>

    <dependencies>
        <dependency>
            <groupId>dev.langchain4j</groupId>
            <artifactId>langchain4j</artifactId>
            <version>1.20.2</version>
        </dependency>
        <dependency>
            <groupId>dev.langchain4j</groupId>
            <artifactId>langchain4j-open-ai</artifactId>
            <version>1.20.2</version>
        </dependency>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-web</artifactId>
            <version>4.1.1</version>
        </dependency>
    </dependencies>
</project>
```

**示例一：最小可运行的带记忆助手。**

这个例子演示"声明接口 → 构建 → 对话"，第二个问题会去问上一个问题，用来验证记忆确实生效。

```java
package com.example.ai;

import dev.langchain4j.memory.chat.MessageWindowChatMemory;
import dev.langchain4j.model.chat.ChatModel;
import dev.langchain4j.model.openai.OpenAiChatModel;
import dev.langchain4j.service.AiServices;
import dev.langchain4j.service.SystemMessage;
import dev.langchain4j.service.UserMessage;

public class BasicAssistantDemo {

    interface Assistant {
        @SystemMessage("你是一名资深 Java 技术顾问，回答要简短、直接、先给结论。")
        String chat(@UserMessage String question);
    }

    public static void main(String[] args) {
        ChatModel model = OpenAiChatModel.builder()
                .apiKey(System.getenv("OPENAI_API_KEY"))
                .modelName("gpt-4o-mini")
                .logRequests(true)
                .logResponses(true)
                .build();

        Assistant assistant = AiServices.builder(Assistant.class)
                .chatModel(model)
                .chatMemory(MessageWindowChatMemory.withMaxMessages(20))
                .build();

        System.out.println(assistant.chat("Redis 和 Memcached 选哪个？"));
        System.out.println(assistant.chat("我刚才问的是什么？"));
    }
}
```

关键点：`chatMemory(...)` 一加，同一个 Assistant 实例的两轮对话就共享上下文了。`logRequests` / `logResponses` 建议在开发期打开，能直接看到框架帮你拼好的完整 Prompt，排查问题非常省事。

**示例二：多用户会话隔离。**

客服、IM 这类场景，一个 AI Service 要同时服务成百上千个用户，每个人的上下文不能串。答案是用 `@MemoryId` 加 `chatMemoryProvider`。

```java
package com.example.ai;

import dev.langchain4j.memory.chat.MessageWindowChatMemory;
import dev.langchain4j.model.chat.ChatModel;
import dev.langchain4j.model.openai.OpenAiChatModel;
import dev.langchain4j.service.AiServices;
import dev.langchain4j.service.MemoryId;
import dev.langchain4j.service.SystemMessage;
import dev.langchain4j.service.UserMessage;
import dev.langchain4j.store.memory.chat.ChatMemoryStore;
import dev.langchain4j.store.memory.chat.InMemoryChatMemoryStore;

public class MultiUserMemoryDemo {

    interface SupportAgent {
        @SystemMessage("你是电商客服，记住当前用户说过的话，不要重复追问已经说过的信息。")
        String reply(@MemoryId String userId, @UserMessage String message);
    }

    public static void main(String[] args) {
        ChatModel model = OpenAiChatModel.builder()
                .apiKey(System.getenv("OPENAI_API_KEY"))
                .modelName("gpt-4o-mini")
                .build();

        ChatMemoryStore store = new InMemoryChatMemoryStore();

        SupportAgent agent = AiServices.builder(SupportAgent.class)
                .chatModel(model)
                .chatMemoryProvider(userId -> MessageWindowChatMemory.builder()
                        .id(userId)
                        .maxMessages(15)
                        .chatMemoryStore(store)
                        .build())
                .build();

        System.out.println(agent.reply("u-1001", "我上周买的那双跑鞋要退货"));
        System.out.println(agent.reply("u-1001", "订单号你还记得吗？"));
        System.out.println(agent.reply("u-2002", "你好，我想咨询开发票"));
    }
}
```

关键点说明：

- `@MemoryId` 标注的参数不会被当成用户输入，而是作为会话标识。框架拿它去 `chatMemoryProvider` 要一个对应的记忆对象。
- `chatMemoryProvider` 只在某个 id 第一次出现时被调用一次，之后复用。
- 这里传了共享的 `InMemoryChatMemoryStore`，所有用户的记忆存在一个 store 里、按 id 分区。`InMemoryChatMemoryStore` 重启即丢；要持久化，实现一个自己的 `ChatMemoryStore` 接 Redis 或数据库即可，AI Service 那行代码一个字都不用改。

**示例三：挂上工具 + Spring Boot 装配。**

这个例子让模型能查天气：模型自己决定什么时候调用 Java 方法，返回值也由 Java 方法给。

工具类：

```java
package com.example.ai.tool;

import dev.langchain4j.agent.tool.P;
import dev.langchain4j.agent.tool.Tool;
import org.springframework.stereotype.Component;

import java.util.Map;

@Component
public class WeatherTools {

    private static final Map<String, String> WEATHER = Map.of(
            "北京", "晴，18℃，北风 3 级",
            "上海", "多云，22℃，东南风 2 级",
            "深圳", "雷阵雨，27℃，南风 4 级"
    );

    @Tool("查询指定城市的实时天气")
    public String weather(@P("城市名，例如：北京") String city) {
        return WEATHER.getOrDefault(city, city + "：暂无数据");
    }
}
```

AI Service 接口：

```java
package com.example.ai;

import dev.langchain4j.service.SystemMessage;
import dev.langchain4j.service.UserMessage;
import dev.langchain4j.service.V;

public interface TravelAssistant {

    @SystemMessage("你是一名出行助手。问到天气必须调用工具查询，不要凭记忆编造。")
    @UserMessage("用户的问题是：{{question}}")
    String ask(@V("question") String question);
}
```

Spring 配置，把模型和 AI Service 都做成 Bean：

```java
package com.example.ai;

import com.example.ai.tool.WeatherTools;
import dev.langchain4j.memory.chat.MessageWindowChatMemory;
import dev.langchain4j.model.chat.ChatModel;
import dev.langchain4j.model.openai.OpenAiChatModel;
import dev.langchain4j.service.AiServices;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class AiConfig {

    @Bean
    public ChatModel chatModel(@Value("${ai.openai.api-key}") String apiKey,
                               @Value("${ai.openai.base-url}") String baseUrl,
                               @Value("${ai.openai.model-name}") String modelName) {
        return OpenAiChatModel.builder()
                .apiKey(apiKey)
                .baseUrl(baseUrl)
                .modelName(modelName)
                .temperature(0.2)
                .build();
    }

    @Bean
    public TravelAssistant travelAssistant(ChatModel chatModel, WeatherTools weatherTools) {
        return AiServices.builder(TravelAssistant.class)
                .chatModel(chatModel)
                .chatMemory(MessageWindowChatMemory.withMaxMessages(12))
                .tools(weatherTools)
                .build();
    }
}
```

对外暴露的 REST 接口：

```java
package com.example.ai.web;

import com.example.ai.TravelAssistant;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class ChatController {

    private final TravelAssistant assistant;

    public ChatController(TravelAssistant assistant) {
        this.assistant = assistant;
    }

    @GetMapping("/chat")
    public String chat(@RequestParam("q") String question) {
        return assistant.ask(question);
    }
}
```

配置文件 `application.yml`：

```yaml
ai:
  openai:
    api-key: ${OPENAI_API_KEY}
    base-url: https://api.openai.com/v1
    model-name: gpt-4o-mini
```

启动后访问 `/chat?q=北京今天天气怎么样`，会看到模型返回带温度的天气描述——这个数据不是模型编的，是你 `WeatherTools.weather()` 返回的。

## 四、踩坑经验：AI Service 最容易翻车的五个地方

结论先行：下面这些坑我都踩过，绝大多数报错都不是模型的问题，是配置和参数标注的问题。

**坑一：`chatMemory` 和 `chatMemoryProvider` 只能二选一。** 单会话用 `chatMemory`，多会话用 `chatMemoryProvider`。两个都配会直接抛异常。而且只要方法参数里出现了 `@MemoryId`，就必须用 `chatMemoryProvider`。

**坑二：多参数方法不标 `@V` 会出事。** 只有一个参数时，它会被默认当成用户消息。一旦有两个及以上参数，就必须用 `@V("名字")` 标注，并且在 `@UserMessage` 里用 `{{名字}}` 引用，否则框架不知道怎么把它们拼进 Prompt。

**坑三：记忆默认活在内存里。** 不传自定义 `ChatMemoryStore` 时，默认只用单槽的内存 store，应用一重启，会话全清空。上线前一定要换成 Redis/数据库实现，否则用户会觉得"AI 失忆了"。

**坑四：工具方法抛异常，整轮对话会崩。** 模型误传参数、你的工具方法空指针，都会让这次调用失败。两点建议：工具方法的入参永远做空值和边界校验，业务动作要幂等——模型有可能对同一个请求重复调用工具。框架提供了 `compensateOnToolErrors`、`hallucinatedToolNameStrategy` 等配置来兜底，但最可靠的还是工具自己写得稳。

**坑五：想流式却声明成了 `String`。** 流式必须在构建时给 `streamingChatModel(...)`，接口方法返回 `TokenStream`，然后这样消费：

- `onPartialResponse(Consumer<String>)` 收增量文本；
- `onCompleteResponse(Consumer<ChatResponse>)` 收完整响应；
- `onError(Consumer<Throwable>)` 处理异常；
- 最后别忘了调用 `start()`，不调用不会真正发起请求。

另外提一句顺手的事：AI Service 的接口方法名、参数名对模型没有语义影响，但**给人看很重要**。把 `chat` 改成 `answerCustomerQuestion`，半年后的你会感谢现在的你。

## 五、性能对比与技术选型：AI Service、ChatClient 还是手写

结论先行：AI Service 的性能开销可以忽略，选型的分界线不是性能，而是"你要不要精细控制每次请求"。

**性能。** 动态代理每次调用多一次反射和注解解析，量级在微秒级；而一次大模型 HTTP 请求通常几百毫秒到几秒，还受网络和模型排队影响。这部分开销占比不到千分之一，完全不用权衡。真正影响成本的是 Token 数量，而记忆窗口大小（`maxMessages`）直接决定每轮带多少历史——这个参数才是你该盯的。

**三种写法的分界：**

| 写法 | 适合 | 不适合 |
| --- | --- | --- |
| AI Service（接口声明式） | 场景固定、要记忆、要工具、追求可读性 | 需要按请求动态改参数、动态换模型 |
| 手写 `ChatModel` 调用 | 完全掌控每次 `ChatRequest` | 代码重复多，记忆和工具要自己写 |
| Spring AI `ChatClient` | 同样是链式、声明式风格，生态是 Spring | 需要 LangChain4j 特有的 AI Service/Tool 体系 |

**我的建议：** 业务代码一律优先 AI Service，把它当成"和大模型交互的防腐层"。它挡在业务和具体模型 SDK 之间，将来从 OpenAI 换到别的兼容接口，改的只是 `AiConfig` 里那个 Bean。只有在需要逐请求调参、做 A/B 分流、或实现自定义路由时，才降级到直接操作 `ChatModel`。

**一个现实提醒：** 如果你打算用 LangChain4j 官方的 Spring Boot starter 自动装配，目前它的版本仍带 beta 标识。企业项目里我倾向于像示例三那样，自己用 `@Bean` 装配 `ChatModel` 和 AI Service——依赖版本完全可控，出问题也定位得到。

## 六、总结

结论先说：LangChain4j 的 AI Service 把"调模型"从一堆样板代码，变成了一个接口声明。记住四件事就够了。

1. **接口是契约。** `@SystemMessage` 定义人设，`@UserMessage` 定义输入模板，`@V` 填变量，`@MemoryId` 划会话。
2. **构建靠 `AiServices.builder()`。** 模型、记忆、工具，三样东西在这里注册。
3. **记忆要持久化就得自定义 `ChatMemoryStore`。** 默认的内存实现撑得过开发，撑不过上线。
4. **工具是让 AI"能动手"的关键。** 带 `@Tool` 的方法，模型会自己决定何时调用，但你要保证它稳、幂等、能兜异常。

这套东西的价值不在"省几行代码"，而在于它给业务和模型之间加了一层清晰的边界。Prompt 有地方放，记忆有地方管，工具按对象注册——代码终于长得像个正常项目了。

想继续深入，官方文档的 AI Services 和 Tools 两页值得完整读一遍。

## 参考资料

- [LangChain4j 官方文档：AI Services](https://docs.langchain4j.dev/tutorials/ai-services)
- [LangChain4j 官方文档：Chat Memory](https://docs.langchain4j.dev/tutorials/chat-memory)
- [LangChain4j 官方文档：Tools (Function Calling)](https://docs.langchain4j.dev/tutorials/tools)
- [LangChain4j GitHub Releases](https://github.com/langchain4j/langchain4j/releases)

文 / 会编程的吕洞宾
