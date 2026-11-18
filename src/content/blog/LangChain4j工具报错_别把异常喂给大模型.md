---
title: "LangChain4j工具报错，别把异常喂给大模型"
date: 2026-11-01T20:00:00+08:00
category: "AI"
tags: ["langchain4j"]
---

> 线上客服助手接了查订单的工具。某天数据库抖了一下，工具抛了异常。用户问「我的单到哪了」，模型很诚实地回答：「系统提示 Communications link failure: jdbc:mysql://10.0.3.7:3306/order_db?user=order_svc」——内网 IP、库名、账号，全念给了用户。这不是模型抽风，是框架的默认行为。这篇讲清楚异常怎么跑到模型嘴里，以及怎么拦住它。

## 一、这个问题到底是什么

一句话：**工具方法抛出的异常，默认会被当成「工具的执行结果」交给大模型，模型看得见 `e.getMessage()` 里的每一个字。**

先把工具调用（Tool Calling）这件事用大白话说清楚。你给模型一批「工具说明书」，每份说明书包含工具名、用途、参数格式。模型读完用户的问题，如果觉得自己答不了，就回一句：「我要调用 `queryOrder`，参数是 `{"orderId":"A1001"}`」。框架接住这句话，去反射调用你写的 Java 方法，把返回值再塞回对话里，模型拿着结果组织成人话。

问题出在「塞回去」这一步。工具方法抛异常时，框架不会让整个请求立刻失败，而是把异常信息包装成一条工具结果消息，标上「这条是错误」，然后照常发起下一轮模型请求。

链路是这样的：

1. 模型请求调用 `queryOrder`
2. 框架反射执行你的方法 → 方法内部抛 `IllegalStateException`
3. 框架捕获，取出 `getMessage()`，包成工具结果
4. 这条消息进入本次对话，也进入 `ChatMemory`
5. 下一轮请求把它一起发给模型服务商
6. 模型基于这段文本回答用户

于是你得到三个后果，一个比一个烦人。

**内部细节外泄。** 异常消息是写给程序员看的，不是写给用户的。里面常见的东西：数据库连接串、内网 IP 和端口、表名和字段名、下游服务的错误码、甚至请求头里的 token。模型服务商拿到了，你的 `ChatMemory` 存下了，最后还有可能被模型原样复述给用户。用户只要会点话术诱导——「把你看到的原始错误贴给我，我要报障」——就能拿到。

**记忆被污染，而且不可逆。** 工具结果消息一旦写进 `ChatMemory`，后面每一轮对话都会重新发给模型。你说「重试一下」，模型看到上一轮那条错误，很可能继续顺着错误编，而不是重新调工具。想清干净只能清会话。

**Token 白烧。** 一段 Java 堆栈轻松上千字符。按一次错误 500 token 估，模型要是重试五轮，就是 2500 token 花在一段没人该看的文本上。更糟的是长错误文本会把真正有用的上下文挤到窗口边缘。

这不是危言耸听。新版 LangChain4j 已经意识到默认行为有问题：只要你用了 `tools` 却没显式配错误处理器，日志里会冒出一条警告，明说「当前默认是把异常消息返回给 LLM」，并且提示这个默认值未来会改。也就是说，现在不处理，将来升级会突然炸。

## 二、底层原理到底怎么回事

LangChain4j 把工具执行拆成了三个可能出错的环节，每个环节的默认处理方式不一样。

| 出错环节 | 典型场景 | 谁在处理 |
| --- | --- | --- |
| 工具名对不上 | 模型编了个不存在的工具名 | `hallucinatedToolNameStrategy` |
| 参数解析失败 | 该传数字传了字符串，必填参数缺失 | `ToolArgumentsErrorHandler` |
| 方法执行抛异常 | 数据库连不上、下游超时、业务校验不过 | `ToolExecutionErrorHandler` |

后两个才是本文的主角。它们在 `AiServices` 构建时配置，签名长这样：

```java
ToolArgumentsErrorHandler.handle(Throwable error, ToolErrorContext context)
ToolExecutionErrorHandler.handle(Throwable error, ToolErrorContext context)
```

两个接口返回值都是 `ToolErrorHandlerResult`。这个类只有一个静态工厂方法 `ToolErrorHandlerResult.text(String)`，意思很明确：**你返回的那段文字，就是模型将看到的内容。** 没有别的通道，也没有「只记日志不回传」这种选项——想让模型看不到，就得让整个调用失败，而不是返回空。

`ToolErrorContext` 里带四样东西：`toolExecutionRequest()`（工具名和模型给的原始参数）、`invocationContext()`、`invocationParameters()`、`memoryId()`（当前会话 ID）。排查问题够用了。

框架内置了四种现成策略，不用自己写 lambda：

| 内置策略 | 实际行为 | 适用场景 |
| --- | --- | --- |
| `sendExceptionMessageToLlm()` | 异常消息原样回传给模型 | **当前默认值**，也是事故源头 |
| `failInvocation()` | 直接抛异常，整轮调用失败 | 内部批处理，错就该停 |
| `failInvocationUnlessVisibleToLlm()` | 除非异常实现了 `ToolErrorVisibleToLlm`，否则整轮失败 | 严格模式 |
| `sendGenericMessageToLlmUnlessVisibleToLlm("兜底文案")` | 白名单异常回传自己的话术，其余统一换兜底文案 | **生产环境推荐** |

最后一个值得多说两句，它背后是个挺聪明的设计。

`ToolErrorVisibleToLlm` 是个标记接口，配套的 `ToolErrorVisibleToLlmException` 通过静态方法 `ToolErrorVisibleToLlm.from("没有找到订单 A1001")` 创建。你在业务代码里主动抛这个异常，就等于给这条消息盖了个章：「这段话我确认过，可以给模型看，也可以给用户看」。其它任何异常——`NullPointerException`、`SQLException`、`HttpTimeoutException`——都没盖章，一律换成你写死的兜底文案。

这就是白名单思路：默认不信任，显式放行。反过来做黑名单（拿 `getMessage()` 跑正则删密码、删 IP）几乎必漏，因为异常还有 `cause`，还有框架自己拼的前缀。

还有个容易忽略的点：**配了自定义 handler 之后，框架原来那条「Tool execution failed」日志就不打了。** 因为它默认认为你已经接管了。所以 handler 里必须自己记日志，否则线上出问题你什么都看不到。

还有两个坑不在 handler 管辖范围内，但同样会咬人。模型编工具名走 `hallucinatedToolNameStrategy`，不配的话整轮直接失败；模型反复调同一个失败的工具，靠 `maxSequentialToolsInvocations` 兜底。这两个参数跟错误处理是一套组合拳，后面踩坑部分细说。

## 三、实战：手把手写代码

依赖先摆全，照着抄就能跑。

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
    <artifactId>tool-error-demo</artifactId>
    <version>1.0.0</version>

    <properties>
        <java.version>21</java.version>
    </properties>

    <dependencies>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter</artifactId>
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
    </dependencies>
</project>
```

### 示例一：把事故复现出来

先看默认行为到底有多裸。这个类能直接跑，`main` 方法里没有任何错误处理配置。

```java
package com.example.tooldemo;

import dev.langchain4j.agent.tool.Tool;
import dev.langchain4j.model.chat.ChatModel;
import dev.langchain4j.model.openai.OpenAiChatModel;
import dev.langchain4j.service.AiServices;

public class DefaultLeakDemo {

    public static void main(String[] args) {
        ChatModel model = OpenAiChatModel.builder()
                .apiKey(System.getenv("OPENAI_API_KEY"))
                .modelName("gpt-4o-mini")
                .build();

        OrderAssistant assistant = AiServices.builder(OrderAssistant.class)
                .chatModel(model)
                .tools(new OrderTools())
                .build();

        System.out.println(assistant.chat("帮我看看订单 A1001 什么时候发货"));
    }

    interface OrderAssistant {
        String chat(String userMessage);
    }

    static class OrderTools {

        @Tool("根据订单号查询订单的物流状态，返回当前状态和预计发货时间")
        public String queryOrder(String orderId) {
            // 模拟数据库连接失败
            throw new IllegalStateException(
                    "Communications link failure: jdbc:mysql://10.0.3.7:3306/order_db"
                            + "?user=order_svc");
        }
    }
}
```

跑完你会看到模型客客气气地把连接串复述了一遍。它没有恶意，它只是把你给它的文本读了出来。

关键点在于：`tools(new OrderTools())` 这一步就是把方法注册成工具，`@Tool` 的字符串是给模型看的说明书。方法体里抛什么，模型就吃什么，中间没有任何过滤。

### 示例二：一行配置堵住大部分口子

生产环境最省事的写法是直接用内置策略。

```java
package com.example.tooldemo;

import dev.langchain4j.agent.tool.P;
import dev.langchain4j.agent.tool.Tool;
import dev.langchain4j.exception.ToolErrorVisibleToLlm;
import dev.langchain4j.model.chat.ChatModel;
import dev.langchain4j.model.openai.OpenAiChatModel;
import dev.langchain4j.service.AiServices;
import dev.langchain4j.service.tool.ToolArgumentsErrorHandler;
import dev.langchain4j.service.tool.ToolExecutionErrorHandler;

public class SafeConfigDemo {

    public static void main(String[] args) {
        ChatModel model = OpenAiChatModel.builder()
                .apiKey(System.getenv("OPENAI_API_KEY"))
                .modelName("gpt-4o-mini")
                .build();

        OrderAssistant assistant = AiServices.builder(OrderAssistant.class)
                .chatModel(model)
                .tools(new OrderTools())
                // 业务异常（实现了 ToolErrorVisibleToLlm）原样放行，其它异常统一换话术
                .toolExecutionErrorHandler(
                        ToolExecutionErrorHandler.sendGenericMessageToLlmUnlessVisibleToLlm(
                                "查询服务暂时不可用，请稍后再试。不要重复调用这个工具。"))
                // 参数错误直接让整轮失败，不猜、不重试
                .toolArgumentsErrorHandler(ToolArgumentsErrorHandler.failInvocation())
                .maxSequentialToolsInvocations(5)
                .build();

        System.out.println(assistant.chat("订单 A9999 到哪了"));
    }

    interface OrderAssistant {
        String chat(String userMessage);
    }

    static class OrderTools {

        @Tool("根据订单号查询订单的物流状态")
        public String queryOrder(@P("订单号，例如 A1001") String orderId) {
            if ("A9999".equals(orderId)) {
                // 主动抛：这段话经过确认，可以给模型和用户看
                throw ToolErrorVisibleToLlm.from("没有找到订单 " + orderId + "，请让用户核对订单号。");
            }
            throw new IllegalStateException(
                    "Communications link failure: jdbc:mysql://10.0.3.7:3306/order_db");
        }
    }
}
```

三种走向，对照着看：

- 订单不存在 → 抛白名单异常 → 模型收到「没有找到订单 A9999，请让用户核对订单号」，能正常引导用户
- 数据库炸了 → 普通异常 → 模型只收到「查询服务暂时不可用」，内部细节一个字都出不去
- 模型把 `A1001` 传成了数字 `1001` 且反序列化失败 → 参数 handler 直接抛异常，整轮失败，你在日志里看到完整堆栈

`maxSequentialToolsInvocations(5)` 是另一道保险。模型有时候会「再试一次」，试五次还不行就该停，别让它把一次故障放大成五次计费。

### 示例三：Spring Boot 里带上日志和脱敏

真实项目需要的比一行配置多：日志要能定位到是哪个会话、哪个工具、什么参数；错误文案要能随业务调整。用自定义 handler 最直接。

```java
package com.example.tooldemo;

import dev.langchain4j.exception.ToolErrorVisibleToLlm;
import dev.langchain4j.memory.chat.MessageWindowChatMemory;
import dev.langchain4j.model.chat.ChatModel;
import dev.langchain4j.model.openai.OpenAiChatModel;
import dev.langchain4j.service.AiServices;
import dev.langchain4j.service.tool.ToolArgumentsErrorHandler;
import dev.langchain4j.service.tool.ToolErrorHandlerResult;
import dev.langchain4j.service.tool.ToolExecutionErrorHandler;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import java.time.Duration;

@Configuration
public class AssistantConfig {

    private static final Logger log = LoggerFactory.getLogger(AssistantConfig.class);

    @Bean
    ChatModel chatModel(@Value("${ai.openai.api-key}") String apiKey,
                        @Value("${ai.openai.model:gpt-4o-mini}") String modelName) {
        return OpenAiChatModel.builder()
                .apiKey(apiKey)
                .modelName(modelName)
                .timeout(Duration.ofSeconds(30))
                .build();
    }

    @Bean
    OrderAssistant orderAssistant(ChatModel chatModel, OrderTools orderTools) {

        ToolExecutionErrorHandler onExecutionError = (error, context) -> {
            log.error("工具执行失败 tool={} args={} memoryId={}",
                    context.toolExecutionRequest().name(),
                    context.toolExecutionRequest().arguments(),
                    context.memoryId(),
                    error);
            // 白名单异常：文案已确认，直接放行
            if (error instanceof ToolErrorVisibleToLlm visible) {
                return ToolErrorHandlerResult.text(visible.messageForLlm());
            }
            // 其它异常：只回传写死的话术，绝不回传 error.getMessage()
            return ToolErrorHandlerResult.text("查询服务暂时不可用，请稍后再试，不要重复调用这个工具。");
        };

        ToolArgumentsErrorHandler onArgumentsError = (error, context) -> {
            log.warn("工具参数不合法 tool={} args={}",
                    context.toolExecutionRequest().name(),
                    context.toolExecutionRequest().arguments(),
                    error);
            return ToolErrorHandlerResult.text(
                    "参数不合法。orderId 必须是字符串，例如 \"A1001\"，请修正后重新调用。");
        };

        return AiServices.builder(OrderAssistant.class)
                .chatModel(chatModel)
                .tools(orderTools)
                .toolExecutionErrorHandler(onExecutionError)
                .toolArgumentsErrorHandler(onArgumentsError)
                .chatMemoryProvider(memoryId -> MessageWindowChatMemory.withMaxMessages(10))
                .maxSequentialToolsInvocations(5)
                .build();
    }
}
```

对应三个配套类，一个装工具，一个定义助手接口，再加一个启动类：

```java
package com.example.tooldemo;

import dev.langchain4j.agent.tool.P;
import dev.langchain4j.agent.tool.Tool;
import dev.langchain4j.exception.ToolErrorVisibleToLlm;
import org.springframework.stereotype.Component;

import java.util.Map;

@Component
public class OrderTools {

    // 演示用，真实项目换成数据库查询
    private static final Map<String, String> ORDERS = Map.of(
            "A1001", "已发货，预计 11 月 3 日送达",
            "A1002", "待出库，预计 11 月 5 日发货"
    );

    @Tool("根据订单号查询订单的物流状态，返回当前状态和预计发货时间")
    public String queryOrder(@P("订单号，例如 A1001") String orderId) {
        String status = ORDERS.get(orderId);
        if (status == null) {
            throw ToolErrorVisibleToLlm.from("没有找到订单 " + orderId + "，请让用户核对订单号。");
        }
        return "订单 " + orderId + " 当前状态：" + status;
    }
}
```

```java
package com.example.tooldemo;

import dev.langchain4j.service.MemoryId;
import dev.langchain4j.service.SystemMessage;
import dev.langchain4j.service.UserMessage;

public interface OrderAssistant {

    @SystemMessage("你是电商客服助手。需要订单信息时必须调用工具查询，不要凭空猜测。")
    String chat(@MemoryId String conversationId, @UserMessage String userMessage);
}
```

```java
package com.example.tooldemo;

import org.springframework.boot.CommandLineRunner;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.Bean;

@SpringBootApplication
public class DemoApplication {

    public static void main(String[] args) {
        SpringApplication.run(DemoApplication.class, args);
    }

    @Bean
    CommandLineRunner run(OrderAssistant assistant) {
        return args -> {
            System.out.println(assistant.chat("session-1", "订单 A1001 到哪了"));
            System.out.println(assistant.chat("session-1", "那 A9999 呢"));
        };
    }
}
```

`@MemoryId` 是为了让 handler 的 `context.memoryId()` 能拿到会话 ID，多租户下排查「哪个用户在什么时候把工具搞挂了」很有用。注意只写进日志，别拼进回传给模型的文案里。

日志里打印 `error` 是故意的——完整堆栈进你的 ELK，不进模型上下文。两条通道彻底分开，这是整套方案的核心。

## 四、踩坑经验和最佳实践

**handler 自己抛异常，等于没配。** 这是最常见的翻车。handler 里写 `throw new RuntimeException("...")`，整个调用直接失败，而且你会以为「我配了啊」。handler 必须百分百兜住，任何分支都要返回 `ToolErrorHandlerResult`。

**不要在 handler 里查数据库、调远程。** handler 跑在工具执行链路上，多一次 IO 就是多一份延迟和一份新的失败点。它该干的事只有三件：记日志、脱敏、返回话术。

**别对 `getMessage()` 做正则清洗。** 也许你只想删掉密码，但异常消息里还有 `cause` 的 message、框架拼的前缀、JDBC 驱动自己加的参数。黑名单永远列不全。要回传给模型的只能是常量字符串。

**业务失败优先用返回值，别动不动抛异常。** 「订单不存在」「库存不足」这类结果，直接 `return "没有找到订单 A1001，请让用户核对订单号"` 就行，它是正常的工具结果。只有必须中断后续逻辑、或者你希望框架层面感知失败时，才抛 `ToolErrorVisibleToLlm`。分不清这两者，模型会收到一堆 `isError=true` 的消息，回答质量明显下降——它真的会以为系统坏了。

**`ToolErrorVisibleToLlm` 的 message 是给人看的，不是给日志看的。** 别在里面塞订单详情、手机号、金额。它最终会出现在用户屏幕上。

**模型编工具名是另一条路。** 上面两个 handler 管不到。模型幻觉出一个不存在的工具时走 `hallucinatedToolNameStrategy`，默认行为是直接失败。如果想温和点，可以在这里也返回一句「没有这个工具，可用工具是：……」，但要注意别把工具清单全暴露给终端用户。

**用并发执行工具时，handler 可能不在请求线程上跑。** 依赖 `ThreadLocal` 塞进去的 traceId、租户信息会丢。要传就显式从 `ToolErrorContext` 里取，或者用支持上下文传播的日志框架。

**兜底文案要带明确指令。** 「服务暂时不可用」模型可能还会再试一次；「服务暂时不可用，请稍后再试，不要重复调用这个工具」明显更能止住重试。一个句子的差别，能省掉好几次模型往返。

## 五、性能对比和技术选型

按一次工具故障的代价粗略算笔账。假设一段 JDBC 异常消息加堆栈 1.5KB，折算下来 300～500 token；换成兜底文案 20 token 左右。

| 策略 | 单次错误 token | 是否多一轮模型请求 | 泄露风险 | 适用场景 |
| --- | --- | --- | --- | --- |
| 默认（回传异常） | 300～500 | 是 | 高 | 只在本地调试开 |
| 通用兜底文案 | 约 20 | 是 | 无 | 面向用户的问答、客服 |
| 白名单异常 + 兜底 | 20～60 | 是 | 可控 | 有明确业务错误的对外服务 |
| `failInvocation()` | 0 | 否 | 无 | 内部批处理、数据管道 |

省下的不只是 token。多一轮模型请求意味着多 1～3 秒延迟；如果模型选择重试工具，延迟和费用按次数翻倍。`maxSequentialToolsInvocations(5)` 把最坏情况锁死，这是最便宜的一道保险。

选型我一般这么定：

- 对外服务，用户能感知到失败的 → `sendGenericMessageToLlmUnlessVisibleToLlm`，业务错误用 `ToolErrorVisibleToLlm` 显式放行
- 内部任务、离线跑批 → `failInvocation`，出错就抛，让上层重试或告警
- 需要精确日志和指标 → 自定义 handler，同时打日志和埋点
- 只想快速验证 → 默认行为先用着，但别上线

上面这几个内置策略覆盖八成场景，剩下两成靠自定义 handler 补日志。真没必要从零写。

## 六、总结

工具调用的错误处理，本质是**决定哪些文本有资格进入模型上下文**。默认配置把这个决定权交给了异常消息，而异常消息是写给程序员的。

要改的就三件事：

1. `toolExecutionErrorHandler` 配一个不回传原始异常的策略
2. 业务异常改抛 `ToolErrorVisibleToLlm.from(...)`，给可公开的信息盖章
3. `maxSequentialToolsInvocations` 设个上限，别让模型把一次故障试成五次

代码加起来不到二十行。但省下的是内网地址、数据库账号、一段永远清不掉的会话记忆，以及账单上那些没人看的 token。

先去翻翻你项目里的 `AiServices.builder(...)`，看看有没有配这两个 handler。没配的话，那行警告日志现在应该正躺在你的日志文件里。

文 / 会编程的吕洞宾

## 参考资料

- [LangChain4j 官方文档：Tools（含 Error handling 一节）](https://docs.langchain4j.dev/tutorials/tools)
