---
title: "LangChain4j 模型路由：别再全量调贵模型"
date: 2026-11-12T20:00:00+08:00
category: "AI"
tags: ["langchain4j"]
---

> 客服系统每天三十万次调用，全打同一个大模型。翻日志才发现，七成是"订单到哪了""怎么开发票"这类短问题，小模型又快又准；剩下三成是条款比对、多步推理，确实得用大模型。钱全花在同一档配置上，首字延迟被拖着，一撞限流整站报错。这篇讲清楚模型路由解决什么，以及怎么用 LangChain4j 把分派、降级、观测做扎实。

## 一、这个问题到底是什么

结论：**把"所有请求都送进同一个模型"当成默认架构，成本、延迟、稳定性三样一起亏。**

先说成本。大模型和小模型的单价比，通常是十倍量级——同样一千个 token，大模型收的钱够小模型跑十次。而线上流量从来不是均匀分布的：一个企业内部知识库、一个电商客服、一个文档助手，短问题、寒暄、模板化查询占大头，真正的硬骨头是少数。你为那三成难题买了单，顺便给七成简单问题也付了大模型的钱。

再说延迟。大模型参数多，吐字慢，首字延迟往往是两三倍。用户问"运费多少"，等四秒和等一点五秒，体感是两个产品。

最后是稳定性。同一个模型、同一个账号的 RPM 和 TPM 有上限。全量打过去，峰值撞限额，返回 429，你的接口跟着一片红。而实际上被限流卡住的大多是那些本来就不需要大模型的请求。

有人会说：那我加个重试、加个队列、加个熔断不就完了？那是止血，不是治病。真正的病根是"请求和模型之间没有匹配环节"。所有请求一视同仁，你就只能在最贵的那档配置上做容量规划。

**模型路由**要干的事很朴素：请求进来先判断它有多难，简单问题给小模型，复杂问题给大模型，大模型挂了有备用模型接住。它是一个"派单"环节，不改变你现有的 AI Service、RAG、工具调用代码。

为什么值得认真做，而不是随手 if-else 一下？

第一，判断错了有代价。把难题派给小模型，用户拿到一段胡说八道的答案，比慢三秒严重得多。所以路由必须有兜底策略，默认往"更稳"的那边倒。

第二，路由本身也要花钱。如果你用一个大模型来判断"这个问题难不难"，那等于每次请求多付一次模型钱，还多一段延迟。判断层必须便宜，最好免费。

第三，路由结果要可观测。你总得知道昨天有多少请求走了小模型、小模型答完之后用户有没有追问、哪个路由的错误率高。没有这层数据，路由就是拍脑袋。

第四，工具调用场景有个坑：一个请求可能来回好几轮（模型说"我要查订单"，你的代码查完把结果喂回去，模型再总结）。如果每轮都重新判断难度，第一轮小模型决定用工具，第二轮可能换成大模型，上下文和工具状态对不上，行为会很怪。路由必须能"粘"住。

这四件事，自己写 if-else 也能做，但每一件都要重复造。LangChain4j 已经把这块抽成了框架能力，接口就长在 `ChatModel` 上。下面拆开讲它的设计。

## 二、底层原理到底怎么回事

结论：**路由 = 一组带描述的模型（routes）+ 一个决策器（router）+ 一条兜底路线（defaultRoute），整包仍然是一个普通的 `ChatModel`。**

先看整体形状。核心类是 `RoutingChatModel`，它实现了 `ChatModel` 接口。这句话的分量在于：你原来 `AiServices.builder(Assistant.class).chatModel(x)` 里传的是什么，现在还能传什么。RAG 的 `ContentRetriever`、AI Service 的 `@Tool`、聊天记忆，全都不用改一行。路由是"套在外面的一层"，不是"换一套框架"。

装配长这样：

```java
ChatModel routed = RoutingChatModel.builder()
        .route("small", "打招呼、订单查询、简单事实问答", smallModel)
        .route("large", "多步推理、写代码、长文分析", largeModel)
        .router(myRouter)
        .defaultRoute("large")
        .build();
```

三个部件，逐个说。

**routes**：每条路线有个名字、一段描述、一个真实的模型。描述是给"会读描述的决策器"看的，比如后面要讲的 `DecisionModelChatModelRouter`，它会把所有描述丢给一个小模型，让模型挑一条。如果你用的是纯规则决策器，描述可以不写，写 `route("small", smallModel)` 就行。

**router**：一个函数式接口 `ChatModelRouter`，输入是 `ChatModelRoutingRequest`，输出是 `ChatModelRoutingResult`。输入里带着这次请求（`chatRequest()`）和所有可选路线（`routes()`），输出要么点名某条路线（`ChatModelRoutingResult.route("small")`），要么说"我拿不准，用默认的"（`ChatModelRoutingResult.defaultRoute()`）。

`ChatModelRouter` 只有一个必须实现的方法 `route(...)`，加两个有默认实现的方法：`routeAsync(...)` 和 `validate(...)`。

`routeAsync` 是给异步和流式调用准备的。默认实现直接返回一个失败的 future，抛 `AsyncNotSupportedException`。这意味着：如果你写的是纯规则路由（不查库、不调模型），顺手实现一下 `routeAsync` 返回 `CompletableFuture.completedFuture(route(request))`，异步链路才能用。忘了实现，同步接口一切正常，一上异步就炸——这是个很容易踩的坑。

`validate` 在建对象时调用，用来提前校验配置。比如"按描述挑路线"的决策器要求每条路线都有描述，没写就直接启动失败，而不是等线上第一次请求才发现。

**defaultRoute**：决策器说"用默认"的时候走哪条。也可以理解成"我判断不出来时的保守选择"。这里的选择很关键，后面踩坑那节会展开。

再往里一层，是"路由结果怎么带出来"。

`RoutingChatModel` 把选中的路线名写进两个地方。一个是本次调用的监听器属性，你的 `ChatModelListener` 里能读到，方便打点。另一个更妙：写进返回的 `AiMessage` 的 `attributes()` 里，键是常量 `RoutingChatModel.ROUTE_ATTRIBUTE`（值是字符串 `"chat_model_route"`）。

为什么写进消息里很重要？因为聊天记忆存的就是消息。下一轮请求带着历史消息回来时，框架能从上一轮那条 `AiMessage` 里读出"上次走的是 small"，然后：

- 如果这次请求的结尾是工具执行结果（`ToolExecutionResultMessage`），说明工具调用循环还没结束，直接沿用上一条消息记录的路线，不再问决策器。这就是前面说的"粘性"，多轮工具调用不会大小模型来回跳。
- 如果不是工具结果，正常重新路由。

读回路线名也就一行：

```java
String route = response.aiMessage().attribute(RoutingChatModel.ROUTE_ATTRIBUTE, String.class);
```

顺带一个副作用：路线名成了持久化数据的一部分。你把 `small` 改名成 `cheap`，历史对话里存着 `small`，读出来就是个不存在的路线。改名等于断档。

还有个细节值得单独讲：**能力过滤**。

有些请求有硬性要求，比如"必须返回符合 JSON Schema 的结构化输出"，或者"要能看图"。不同模型支持的能力不一样。`RoutingChatModel.supportedCapabilities()` 返回的是所有路线的并集；当某个请求明确需要某项能力时，框架会把候选路线缩小到声明了该能力的那几条，决策器只能在这几条里挑。如果默认路线恰好不支持这个能力，默认路线会被替换成第一条支持的路线。

这个机制避免了"路由把结构化输出请求派给了不支持 JSON Schema 的小模型，然后接口 500"。但它要求你在建模型时老实声明能力，别指望框架猜。

最后是**默认参数的处理方式**，这点最容易让人困惑。

`RoutingChatModel` 自己没有默认请求参数，`defaultRequestParameters()` 返回空。每个请求最终用的是"被选中那个模型自己的默认参数"。这带来一条硬约束：请求里只能放各家通用的参数（温度、最大输出 token 数、stop 序列这类），不要放某家特有的东西。你在大模型上配的 `reasoningEffort`，被路由到另一家的模型时就是 400。

原理说完了。一句话总结这套设计：**它是一个装饰器，把"选模型"这件事塞进了 `ChatModel` 接口内部，对外完全透明，对内用消息属性解决多轮一致性，用能力声明解决硬性要求。**

## 三、实战：手把手写代码

结论：**三段代码——建模型池、写路由规则、加降级与观测，就能上线。**

需求设定：一个知识库问答接口，两个模型（小的便宜快、大的准但贵），外加一个异构备用模型（不同厂商，防止主供应商整体故障）。

### 3.1 第一步：依赖和两个模型

`pom.xml`：

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
    <artifactId>model-routing-demo</artifactId>
    <version>1.0.0</version>

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

`application.yml`，把三个模型端点做成配置，换模型不用改代码：

```yaml
llm:
  small:
    base-url: https://api.openai.com/v1
    api-key: ${OPENAI_API_KEY}
    model-name: gpt-4.1-mini
  large:
    base-url: https://api.openai.com/v1
    api-key: ${OPENAI_API_KEY}
    model-name: gpt-4.1
  backup:
    base-url: https://api.deepseek.com/v1
    api-key: ${DEEPSEEK_API_KEY}
    model-name: deepseek-chat
```

对应两个类。配置类承接 yml：

```java
package com.example.routing.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties(prefix = "llm")
public class LlmProperties {

    private Endpoint small = new Endpoint();
    private Endpoint large = new Endpoint();
    private Endpoint backup = new Endpoint();

    public Endpoint getSmall() {
        return small;
    }

    public void setSmall(Endpoint small) {
        this.small = small;
    }

    public Endpoint getLarge() {
        return large;
    }

    public void setLarge(Endpoint large) {
        this.large = large;
    }

    public Endpoint getBackup() {
        return backup;
    }

    public void setBackup(Endpoint backup) {
        this.backup = backup;
    }

    public static class Endpoint {

        private String baseUrl;
        private String apiKey;
        private String modelName;
        private int timeoutSeconds = 60;
        private int maxRetries = 0;

        public String getBaseUrl() {
            return baseUrl;
        }

        public void setBaseUrl(String baseUrl) {
            this.baseUrl = baseUrl;
        }

        public String getApiKey() {
            return apiKey;
        }

        public void setApiKey(String apiKey) {
            this.apiKey = apiKey;
        }

        public String getModelName() {
            return modelName;
        }

        public void setModelName(String modelName) {
            this.modelName = modelName;
        }

        public int getTimeoutSeconds() {
            return timeoutSeconds;
        }

        public void setTimeoutSeconds(int timeoutSeconds) {
            this.timeoutSeconds = timeoutSeconds;
        }

        public int getMaxRetries() {
            return maxRetries;
        }

        public void setMaxRetries(int maxRetries) {
            this.maxRetries = maxRetries;
        }
    }
}
```

模型工厂把配置变成三个 `ChatModel` bean：

```java
package com.example.routing.config;

import dev.langchain4j.model.chat.ChatModel;
import dev.langchain4j.model.openai.OpenAiChatModel;
import java.time.Duration;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
@EnableConfigurationProperties(LlmProperties.class)
public class ModelConfig {

    @Bean
    public ChatModel smallModel(LlmProperties properties) {
        return build(properties.getSmall());
    }

    @Bean
    public ChatModel largeModel(LlmProperties properties) {
        return build(properties.getLarge());
    }

    @Bean
    public ChatModel backupModel(LlmProperties properties) {
        return build(properties.getBackup());
    }

    private ChatModel build(LlmProperties.Endpoint endpoint) {
        return OpenAiChatModel.builder()
                .baseUrl(endpoint.getBaseUrl())
                .apiKey(endpoint.getApiKey())
                .modelName(endpoint.getModelName())
                .timeout(Duration.ofSeconds(endpoint.getTimeoutSeconds()))
                // 重试交给上层的降级逻辑，模型层重试会让延迟翻倍
                .maxRetries(endpoint.getMaxRetries())
                .build();
    }
}
```

注意 `maxRetries(0)`。SDK 默认可重试几次，但配合降级时，模型层自己重试三次、再切备用模型，用户要等十几秒。让模型层"一次失败立刻抛"，把重试决策权交给上层，延迟才可控。

### 3.2 第二步：写路由规则

判断逻辑就是业务规则的翻译。这里的取舍很现实：规则能覆盖的场景，绝不上模型。

```java
package com.example.routing.routing;

import dev.langchain4j.data.message.ChatMessage;
import dev.langchain4j.data.message.UserMessage;
import dev.langchain4j.model.chat.request.ChatRequest;
import dev.langchain4j.model.chat.router.ChatModelRouter;
import dev.langchain4j.model.chat.router.ChatModelRoutingRequest;
import dev.langchain4j.model.chat.router.ChatModelRoutingResult;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

@Component
public class TaskRouter implements ChatModelRouter {

    private static final Logger log = LoggerFactory.getLogger(TaskRouter.class);

    /** 出现这些词，基本可以判定是要动脑子的活 */
    private static final Set<String> HARD_HINTS = Set.of(
            "为什么", "报错", "异常", "分析", "对比", "区别", "方案", "设计",
            "代码", "sql", "重构", "优化", "推理", "计算", "推演");

    /** 超过这个长度，按复杂问题处理 */
    private static final int LONG_TEXT_CHARS = 400;

    /** 短于这个长度且不含难点词，按简单问题处理 */
    private static final int SHORT_TEXT_CHARS = 40;

    @Override
    public ChatModelRoutingResult route(ChatModelRoutingRequest request) {
        ChatRequest chatRequest = request.chatRequest();

        // 1. 请求里带了工具定义，说明可能是多步任务，交给大模型更稳
        if (!chatRequest.toolSpecifications().isEmpty()) {
            return pick("large", "has-tools");
        }

        String text = lastUserText(chatRequest.messages());
        if (text == null || text.isBlank()) {
            return ChatModelRoutingResult.defaultRoute();
        }

        // 2. 超长文本通常是文档问答、合同比对
        if (text.length() > LONG_TEXT_CHARS) {
            return pick("large", "long-text");
        }

        // 3. 命中难点词
        String lower = text.toLowerCase(Locale.ROOT);
        for (String hint : HARD_HINTS) {
            if (lower.contains(hint)) {
                return pick("large", "hard-hint:" + hint);
            }
        }

        // 4. 短问题，小模型足够
        if (text.length() <= SHORT_TEXT_CHARS) {
            return pick("small", "short-text");
        }

        // 5. 中间地带判断不了，交给默认路由
        return ChatModelRoutingResult.defaultRoute();
    }

    @Override
    public CompletableFuture<ChatModelRoutingResult> routeAsync(ChatModelRoutingRequest request) {
        // 纯内存判断，不阻塞，直接给结果，异步链路才不会报 AsyncNotSupportedException
        return CompletableFuture.completedFuture(route(request));
    }

    private ChatModelRoutingResult pick(String route, String reason) {
        log.debug("route selected: {} ({})", route, reason);
        return ChatModelRoutingResult.route(route);
    }

    private String lastUserText(List<ChatMessage> messages) {
        for (int i = messages.size() - 1; i >= 0; i--) {
            if (messages.get(i) instanceof UserMessage userMessage) {
                return userMessage.singleText();
            }
        }
        return null;
    }
}
```

逐条解释几个决定：

`toolSpecifications()` 非空就上大模型。工具调用往往是多步任务（查订单、查物流、再汇总），小模型容易选错工具或者漏参数。

按**字符数**而不是 token 数判断，因为算 token 要么调接口要么引分词器，成本不划算。中文场景下 400 字大概对应几百 token，作为粗筛阈值够用了。

难点词表里塞的是"意图信号"，不是"领域词"。`为什么`、`对比`、`推导` 这类词出现，说明用户要的是解释和推理，不是查事实。这比按业务分类靠谱得多。

中间地带（40 到 400 字，没命中难点词）直接认输，交给默认路由。**规则路由最大的价值是"快速放过明显的简单请求"，不是"精确分类所有请求"**。想用规则覆盖全部，词表会膨胀到没人敢改。

### 3.3 第三步：装配、降级、观测

装配层把路由模型包起来，外面再套一层故障转移：

```java
package com.example.routing.routing;

import dev.langchain4j.exception.InternalServerException;
import dev.langchain4j.exception.RateLimitException;
import dev.langchain4j.exception.TimeoutException;
import dev.langchain4j.model.chat.ChatModel;
import dev.langchain4j.model.chat.ChatRequestOptions;
import dev.langchain4j.model.chat.request.ChatRequest;
import dev.langchain4j.model.chat.request.ChatRequestParameters;
import dev.langchain4j.model.chat.response.ChatResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * 主模型不可用时切到备用模型。只对"换个模型可能就好了"的错误生效。
 */
public class FailoverChatModel implements ChatModel {

    private static final Logger log = LoggerFactory.getLogger(FailoverChatModel.class);

    private final ChatModel primary;
    private final ChatModel backup;

    public FailoverChatModel(ChatModel primary, ChatModel backup) {
        this.primary = primary;
        this.backup = backup;
    }

    @Override
    public ChatResponse chat(ChatRequest chatRequest, ChatRequestOptions options) {
        try {
            return primary.chat(chatRequest, options);
        } catch (RateLimitException | TimeoutException | InternalServerException e) {
            // 这三类错误和请求内容无关，换模型有意义；参数错误、认证失败换模型也没用
            log.warn("primary model failed ({}), falling back to backup: {}",
                    e.getClass().getSimpleName(), e.getMessage());
            return backup.chat(chatRequest, options);
        }
    }

    @Override
    public ChatResponse doChat(ChatRequest chatRequest) {
        return chat(chatRequest, ChatRequestOptions.EMPTY);
    }

    @Override
    public ChatRequestParameters defaultRequestParameters() {
        // 参数合并由被委托的模型自己完成，这里不掺和
        return primary.defaultRequestParameters();
    }
}
```

关键点是**只拦三类异常**：限流、超时、服务端 5xx。这三类跟请求内容无关，换个供应商大概率能过。而参数错误（`InvalidRequestException`）、认证失败（`AuthenticationException`）换模型也是白换，直接抛出去让上游看到真问题。

顺带一句：这三个异常在 LangChain4j 里都继承自 `RetriableException`，你要是懒得列，直接 `catch (RetriableException e)` 效果一样，以后框架新增可重试异常也能自动覆盖。

然后是装配：

```java
package com.example.routing.routing;

import dev.langchain4j.model.chat.ChatModel;
import dev.langchain4j.model.chat.router.RoutingChatModel;
import java.util.List;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class RoutingConfig {

    @Bean
    public ChatModel routingChatModel(@Qualifier("smallModel") ChatModel smallModel,
                                      @Qualifier("largeModel") ChatModel largeModel,
                                      @Qualifier("backupModel") ChatModel backupModel,
                                      TaskRouter taskRouter) {

        ChatModel routed = RoutingChatModel.builder()
                .route("small", "打招呼、订单和物流查询、退换货流程、简单事实问答", smallModel)
                .route("large", List.of(
                        "多步推理和计算",
                        "写代码、看报错、改 SQL",
                        "长文档分析和条款比对"), largeModel)
                .router(taskRouter)
                .defaultRoute("large")
                .build();

        return new FailoverChatModel(routed, backupModel);
    }
}
```

`defaultRoute("large")` 是刻意的：判断不出来的时候，宁可多花钱也别答错。这条线以后可以按业务调，但新上线一律先保守。

最后是入口。用 `ChatModel` 直接调，好处是能拿到路线名和 token 用量：

```java
package com.example.routing.web;

import dev.langchain4j.data.message.UserMessage;
import dev.langchain4j.model.chat.ChatModel;
import dev.langchain4j.model.chat.request.ChatRequest;
import dev.langchain4j.model.chat.response.ChatResponse;
import dev.langchain4j.model.chat.router.RoutingChatModel;
import dev.langchain4j.model.output.TokenUsage;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/chat")
public class ChatController {

    private final ChatModel routingChatModel;

    public ChatController(@Qualifier("routingChatModel") ChatModel routingChatModel) {
        this.routingChatModel = routingChatModel;
    }

    @PostMapping
    public ChatReply chat(@RequestBody ChatRequestDto request) {
        ChatRequest chatRequest = ChatRequest.builder()
                .messages(UserMessage.from(request.message()))
                .build();

        ChatResponse response = routingChatModel.chat(chatRequest);

        String route = response.aiMessage()
                .attribute(RoutingChatModel.ROUTE_ATTRIBUTE, String.class);

        TokenUsage usage = response.tokenUsage();

        return new ChatReply(
                route == null ? "unknown" : route,
                response.aiMessage().text(),
                usage == null ? null : usage.inputTokenCount(),
                usage == null ? null : usage.outputTokenCount());
    }

    public record ChatRequestDto(String message) {
    }

    public record ChatReply(String route, String answer, Integer inputTokens, Integer outputTokens) {
    }
}
```

`route` 打回前端或者写进日志，你立刻就能看到"这个月 68% 的请求走了小模型"。有了这个数，成本优化的效果才是可验证的，而不是拍脑袋说"应该省了不少"。

如果现有代码是 AI Service 风格（接口 + 注解），装配方式完全一样，把 `routingChatModel` 这个 bean 传进去就行：

```java
import dev.langchain4j.service.AiServices;

Assistant assistant = AiServices.builder(Assistant.class)
        .chatModel(routingChatModel)
        .build();
```

`Assistant` 是个普通接口，方法上挂 `@SystemMessage`、`@UserMessage`、`@Tool` 都照旧。路由对它是透明的。

### 3.4 想让模型自己判断？换一个决策器

规则搞不定的场景（话题特别杂、用户表达很绕），可以上 `DecisionModelChatModelRouter`：它把每条路线的描述和用户问题一起丢给一个小模型，让模型选。

```java
import dev.langchain4j.model.chat.router.ChatModelRouter;
import dev.langchain4j.model.chat.router.DecisionModelChatModelRouter;
import dev.langchain4j.model.decision.DecisionModel;
import dev.langchain4j.model.openai.OpenAiDecisionModel;

DecisionModel judge = OpenAiDecisionModel.builder()
        .baseUrl("https://api.openai.com/v1")
        .apiKey(System.getenv("OPENAI_API_KEY"))
        .modelName("gpt-4.1-mini")
        .build();

ChatModelRouter semanticRouter = DecisionModelChatModelRouter.builder()
        .decisionModel(judge)
        .minProbability(0.6)
        .fallbackStrategy(DecisionModelChatModelRouter.FallbackStrategy.DEFAULT_ROUTE)
        .build();
```

两个参数值得说。`minProbability(0.6)` 是置信度门槛，模型给的概率低于它就当你没说。`fallbackStrategy(DEFAULT_ROUTE)` 是决策模型自己挂了怎么办，选 `DEFAULT_ROUTE` 就落到默认路线，选 `FAIL` 就把异常抛出去。生产环境我推荐 `DEFAULT_ROUTE`——分类器是辅助组件，它挂了不该拖着主流程一起挂。

代价也要说清楚：这是一次额外的模型调用。延迟加几百毫秒，成本加一次小模型的钱。所以我的建议是两级——先跑规则，规则认输的那部分再交给它。

## 四、踩坑经验和最佳实践

结论：**路由的坑几乎都不在"怎么分类"，而在"分类之后的一致性"。**

**别把默认路由设成小模型。** 决策器返回 `defaultRoute()` 的时机比你想的多：规则没命中、模型置信度不够、决策模型超时、消息为空。这些都是"信息不足"的时刻，信息不足时该往稳的方向倒。设成小模型，等于在系统最没把握的时候做最冒险的选择。

**路由名当作数据库字段对待。** 路线名会跟着 `AiMessage` 进聊天记忆、进日志、进你导出的分析报表。上线后改名字，历史会话读出来的路线名就是野值，统计直接断档。想调整语义就加新路线，别改老名字。

**自己裁剪消息时，别把 attributes 丢掉。** 工具调用的"粘性"依赖上一条 `AiMessage` 里记的路线名。有些团队为了省 token，手工重建消息列表、只留 `text()`，属性就没了。这时候第二轮会重新路由，小模型刚发起工具调用、大模型接手看结果——行为不一定错，但你会很难排查。用框架的 `ChatMemory` 实现不会有这个问题。

**请求参数只用通用项。** 温度、最大输出 token、stop 序列，这些各家都认。`reasoningEffort`、`serviceTier`、`logitBias` 这种是厂商私货，写进 `ChatRequest` 的公共参数里，一旦被路由到别家就是 400。要传私货，配在具体模型的 builder 上，而不是请求上。

**结构化输出要声明能力。** 小模型如果不支持 JSON Schema，建模型时就得在 `supportedCapabilities` 里如实声明（支持的才写）。否则一个"必须返回 JSON"的请求被派给小模型，拿回来的是一段带 ```json 围栏的散文，你的反序列化直接崩。声明了能力，框架会自动把这类请求过滤到大模型那边。

**流式要用 `RoutingStreamingChatModel`。** `RoutingChatModel` 只做同步和异步，不支持 `StreamingChatModel`。你要 SSE 输出，就得单独建一个 `RoutingStreamingChatModel`，装配方式类似，决策器还是同一个。

**规则阈值用生产流量校准，别拍脑袋。** 我一开始把短文本阈值定在 60 字，上线后发现 40 到 60 字这一档里有大量"帮我对比一下 A 和 B 的退款政策"这种要推理的问题，全被小模型接了。后来降到 40，并且把"对比"加进难点词，小模型答完被追问的比例明显下降。**衡量路由好坏的核心指标不是"小模型占比"，而是"小模型答完之后用户追问/转人工的比例"。**

**先埋点，再调参。** 上线第一版路由，规则尽量笨、默认路由尽量保守，先把"路线分布 + 各路线错误率 + 追问率"跑一周。没有这三个数，任何精细化调整都是赌博。

## 五、性能对比和技术选型

结论：**大多数业务用"规则路由 + 保守默认"就够了；只有话题极其分散、规则维护成本超过收益时，才值得引入模型判定。**

几种做法摆在一起看：

| 方案 | 额外延迟 | 额外成本 | 分类准确度 | 维护成本 | 适用场景 |
| --- | --- | --- | --- | --- | --- |
| 全量走大模型 | 无 | 高 | 不涉及 | 无 | 流量小、质量优先、上线初期 |
| 纯规则路由 | 微秒级 | 0 | 取决于规则质量 | 中，词表要养 | 绝大多数业务系统 |
| 模型判定路由 | 一次小模型调用，通常几百毫秒 | 一次小模型费用 | 较高，能理解语义 | 低，改描述即可 | 话题分散、表达多变 |
| 规则 + 模型两级 | 少量 | 低 | 高 | 中 | 流量大且场景杂 |

成本量级上给个参考：小模型单价通常是大模型的十分之一上下（各家差异不小，按你自己的价目表算）。如果七成请求能下沉到小模型，整体模型账单大致能压到原来的四成左右。这个数字随流量结构浮动很大，别当成承诺，拿自己的日志跑一遍最准。

延迟收益更直接：小模型首字延迟往往只有大模型的一半甚至更低。对"查订单""查运费"这种高频短问，体感差异比成本差异更值钱。

我的选型建议，按顺序：

1. **先上全量大模型 + 完整埋点**，把流量结构摸清楚。连"七成是简单问题"这个前提都没验证，谈路由是空的。
2. **加规则路由，默认路由设大模型**，跑两周，看追问率和小模型错误率。
3. **只对规则认输的那部分**考虑 `DecisionModelChatModelRouter`。如果这部分占比低于 10%，别加——多一次调用的延迟和成本不值。
4. **异构备用模型**独立于路由，任何时候都该有。同厂商同区域的两个模型，故障时往往一起挂。

还有一句实话：`RoutingChatModel` 目前挂着 `@Experimental` 标注，API 有变动可能，升级前看一眼 release notes。但它的设计很薄——就是个装饰器——真遇到破坏性变更，照着这套思路自己写百来行也不难。别因为"实验性"三个字不敢用，也别把它当成不会变的基础设施。

## 六、总结

模型路由的本质不是省钱技巧，是**给不同价值的请求分配不同的资源**。你的系统里，一次"你好"和一次"帮我分析这份合同的违约条款"，本来就不该走同一条链路。

LangChain4j 这套实现有三处设计值得记住：

路由结果写进 `AiMessage` 的属性，让多轮工具调用粘在同一个模型上——这是把"一致性"问题解决在数据结构里，而不是靠调用方自己记。

能力声明驱动候选过滤，让"必须返回 JSON"这种硬要求在建模型时就落地，避免运行时惊喜。

整个东西是个 `ChatModel` 装饰器，所以接入成本几乎为零：现有 AI Service、RAG、记忆组件都不用动，换一个 bean 就完事。

落地顺序别搞反：先埋点看流量结构，再上规则路由，默认路由保守，异构备用兜底，最后才考虑让模型自己判断。跑一周看三个数——路线分布、各路线错误率、小模型答完后的追问率。前两个告诉你系统稳不稳，第三个告诉你省下来的钱是不是用体验换的。

如果第三个数字在涨，说明你的规则太激进了，把难题派给了小模型。这时候该往回收，而不是继续压成本。

文 / 会编程的吕洞宾

## 参考资料

- [LangChain4j 官方文档](https://docs.langchain4j.dev/)
- [LangChain4j 1.23.0 Release Notes](https://github.com/langchain4j/langchain4j/releases/tag/1.23.0)
- [Spring Boot 4.1.2 Release Notes](https://github.com/spring-projects/spring-boot/releases/tag/v4.1.2)
