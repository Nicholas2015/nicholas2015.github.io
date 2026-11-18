---
title: "Agent 死循环烧钱？Java 手写循环更可控"
date: 2026-11-02T20:00:00+08:00
category: "AI"
tags: ["agent"]
---

> 一个查订单的客服 Agent，测试时一轮就答完，上线后同一通对话调了 14 次工具，最后卡在「我再查一次」。账单翻了六倍，日志里只有一行「tool executed」，你连刹车该装在哪都不知道。这不是模型变笨了，是循环没有出口。这篇把 Agent 循环拆开给你看，再用 Java 手写一个带步数、预算、重复检测的版本。四道刹车，核心代码不到 80 行，每一步都能落日志，出事时能还原现场。

## 一、Agent 死循环到底是怎么发生的

先给结论：**Agent 死循环不是模型坏了，是循环缺少出口，而出口必须由写代码的人来设。**

把「Agent」这个词的外壳剥掉，里面就三样东西：

- 一个会说话的大模型
- 一组能被调用的函数（工具）
- 一个 while 循环

模型负责决定「下一步做什么」，你的代码负责真的去做，然后把结果塞回对话，再问模型「现在呢」。循环什么时候停，取决于模型什么时候说「我不需要工具了」。

问题就在这。模型没有「我该停了」的硬性约束，它只有概率。概率在某些上下文里会稳定地导向同一个错误决定。

线上常见的死循环有三种形态，根因各不相同：

| 形态 | 现场表现 | 真正的根因 |
| --- | --- | --- |
| 原地打转 | 同一个工具、同样的参数，连调三四次 | 工具返回空结果，模型以为「没查到，再查一次」 |
| 来回横跳 | 查订单 → 查物流 → 又查订单 | 两个工具的结果对不上，模型试图用更多调用消除矛盾 |
| 报错重试 | 工具持续抛异常，模型持续重试 | 错误信息被当成「临时故障，可以再试」 |

三种形态有一个共同点：每一轮都要把完整历史重新发给模型。第一轮 800 token，第五轮可能 4000 token。调用次数上去了，单次成本也跟着涨，账单是乘法级的。

还有个规律：这类问题几乎都是上线后才暴露。测试时你问的是「订单 SO10086 到哪了」，主键明确、数据干净、一次命中。真实用户问的是「我前两天买的那个东西怎么还没到」，模型得先猜、再查、查不到再换个猜法。工具返回的数据也更脏——空列表、超时、字段缺失。调用次数就是这么涨上去的。

框架在这里帮不上太多忙。LangChain4j 的 `AiServices` 有一个 `maxSequentialToolsInvocations`，能限制连续工具调用次数，算是出厂自带的刹车。但它给不了你三样东西：每一步的中间状态、按钱算的预算、以及「这个调用刚才做过」的判断。日志里通常只有最终答案，出问题时你面对的是一个黑盒。

所以要么接受黑盒，要么自己拿回控制权。

## 二、Tool Calling 的协议细节：模型为什么会重复调同一个工具

要理解死循环，得先看清一次工具调用在网络上到底发生了什么。

**大模型是无状态的 HTTP 服务。** 它不记得上一轮说过什么，所有的「记忆」都是你每次请求时重新发过去的 `messages` 数组。这一点是理解全部问题的钥匙。

一次完整的工具调用分四步：

1. 你发请求，`messages` 里带用户问题，另附一份 `tools` 清单，每项包含工具名、用途描述、参数的 JSON Schema。
2. 模型判断需要数据，返回的不是文字，而是一个 `tool_calls` 数组，里面有调用 id、工具名、参数 JSON。此时正文 `content` 往往是空的。
3. 你的代码执行对应函数，把返回值包装成一条「工具结果」消息，带上第 2 步那个调用 id，追加到 `messages`。
4. 你再发一次请求。模型这次能看到工具结果了，才决定是继续调工具，还是给用户答话。

关键在于第 3 步和第 4 步之间：**模型永远不知道「工具被执行过」这件事，除非你把结果写回上下文。** 少写一条，或者写了个空字符串，在模型眼里就等于「这一步没发生」。

死循环的种子就埋在这里。假设查订单工具对不存在的订单返回 `""`。模型看到一条空的工具结果，最合理的推断是「查询没成功」，于是再调一次。参数没变，结果当然还是空。它没有理由停下来，因为上下文里没有任何证据表明「再试也没用」。

ReAct 那套 Thought / Action / Observation 的说法，落到代码上就是这三样东西：

- Thought → 模型的正文文本（可能为空）
- Action → `tool_calls`
- Observation → 你回填的工具结果消息

Observation 写得含糊，Thought 就会跑偏。这不是玄学，是输入决定输出。

反过来，想让循环可靠地停下来，有四种终止条件可以组合使用：

| 终止条件 | 触发依据 | 适合场景 | 代价 |
| --- | --- | --- | --- |
| 自然终止 | 模型不再请求工具 | 绝大多数正常对话 | 无 |
| 步数上限 | 循环轮数 | 所有生产环境，兜底 | 可能截断复杂任务 |
| Token 预算 | 累计用量换算成钱 | 长上下文、多租户 | 需要读 `tokenUsage` |
| 墙钟超时 | 实际耗时 | 同步接口、有 SLA 的调用 | 需要处理中断 |

前两个是必须的，后两个看业务。四种全上，成本可控。

还有个容易被忽略的账：第 n 轮请求会带上前 n-1 轮的全部消息，所以 n 轮对话的累计 token 大致按 n² 增长。调用 14 次和调用 3 次，不是 4.6 倍的关系，是十几倍。这就是为什么「多调几次工具」能把账单顶穿。

## 三、实战：从 80 行循环到带刹车的生产版本

### 3.1 依赖

纯 Java 项目，不掺 Spring。`langchain4j` 提供核心抽象，`langchain4j-open-ai` 提供 OpenAI 兼容的客户端——国内的通义、DeepSeek、Kimi 基本都兼容这套协议，改 `baseUrl` 就能用。

```xml
<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
    <modelVersion>4.0.0</modelVersion>

    <groupId>com.example</groupId>
    <artifactId>java-agent-loop</artifactId>
    <version>1.0.0</version>

    <properties>
        <maven.compiler.release>21</maven.compiler.release>
        <maven.compiler.parameters>true</maven.compiler.parameters>
        <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
    </properties>

    <dependencies>
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
            <groupId>com.fasterxml.jackson.core</groupId>
            <artifactId>jackson-databind</artifactId>
            <version>2.22.4</version>
        </dependency>
        <dependency>
            <groupId>org.slf4j</groupId>
            <artifactId>slf4j-simple</artifactId>
            <version>2.0.20</version>
        </dependency>
    </dependencies>
</project>
```

`maven.compiler.parameters` 这一行别删。后面 3.4 节用 `@Tool` 注解时，LangChain4j 要靠反射读参数名去生成 Schema，没这个编译参数，参数名会变成 `arg0`，模型根本不知道该传什么。

### 3.2 最小可运行循环

先不装刹车，就一个 while，把协议跑通。看懂这段，Agent 就没有神秘感了。

```java
package com.example.agent;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.langchain4j.agent.tool.ToolExecutionRequest;
import dev.langchain4j.agent.tool.ToolSpecification;
import dev.langchain4j.data.message.AiMessage;
import dev.langchain4j.data.message.ChatMessage;
import dev.langchain4j.data.message.SystemMessage;
import dev.langchain4j.data.message.ToolExecutionResultMessage;
import dev.langchain4j.data.message.UserMessage;
import dev.langchain4j.model.chat.ChatModel;
import dev.langchain4j.model.chat.request.ChatRequest;
import dev.langchain4j.model.chat.request.json.JsonObjectSchema;
import dev.langchain4j.model.chat.response.ChatResponse;
import dev.langchain4j.model.openai.OpenAiChatModel;

import java.util.ArrayList;
import java.util.List;

public class AgentLoopDemo {

    private static final ObjectMapper JSON = new ObjectMapper();

    public static void main(String[] args) throws Exception {
        ChatModel model = OpenAiChatModel.builder()
                .apiKey(System.getenv("OPENAI_API_KEY"))
                .baseUrl(System.getenv().getOrDefault("OPENAI_BASE_URL", "https://api.openai.com/v1"))
                .modelName(System.getenv().getOrDefault("LLM_MODEL", "gpt-4o-mini"))
                .temperature(0.0)
                .build();

        List<ToolSpecification> tools = List.of(
                ToolSpecification.builder()
                        .name("queryOrder")
                        .description("根据订单号查询订单状态和金额。用户给出订单号时调用。")
                        .parameters(JsonObjectSchema.builder()
                                .addStringProperty("orderId", "订单号，例如 SO10086")
                                .required("orderId")
                                .build())
                        .build(),
                ToolSpecification.builder()
                        .name("queryShipping")
                        .description("根据订单号查询物流轨迹。只有订单状态为已发货时才调用。")
                        .parameters(JsonObjectSchema.builder()
                                .addStringProperty("orderId", "订单号")
                                .required("orderId")
                                .build())
                        .build()
        );

        List<ChatMessage> messages = new ArrayList<>();
        messages.add(SystemMessage.from("你是电商客服。需要数据时调用工具，拿到结果后再回答，不要编造。"));
        messages.add(UserMessage.from("订单 SO10086 到哪了？"));

        while (true) {
            ChatResponse response = model.chat(ChatRequest.builder()
                    .messages(messages)
                    .toolSpecifications(tools)
                    .build());

            AiMessage ai = response.aiMessage();
            messages.add(ai);

            if (!ai.hasToolExecutionRequests()) {
                System.out.println("最终回答：" + ai.text());
                return;
            }

            for (ToolExecutionRequest request : ai.toolExecutionRequests()) {
                System.out.println("[调用] " + request.name() + " " + request.arguments());
                String result = execute(request.name(), request.arguments());
                messages.add(ToolExecutionResultMessage.from(request, result));
            }
        }
    }

    private static String execute(String name, String arguments) throws Exception {
        JsonNode args = JSON.readTree(arguments);
        String orderId = args.path("orderId").asText();
        return switch (name) {
            case "queryOrder" -> "SO10086".equals(orderId)
                    ? "{\"orderId\":\"SO10086\",\"status\":\"SHIPPED\",\"amount\":199.00}"
                    : "{\"error\":\"订单不存在，请让用户核对订单号\"}";
            case "queryShipping" -> "{\"orderId\":\"" + orderId
                    + "\",\"latest\":\"杭州转运中心已发出\",\"eta\":\"预计次日送达\"}";
            default -> "{\"error\":\"未知工具：" + name + "\"}";
        };
    }
}
```

几个必须看懂的点：

`messages.add(ai)` 在判断之前。模型这一轮说的话（包括它想调什么工具）本身就是对话历史的一部分，下一轮必须带上，否则模型会失去上下文。

`ToolExecutionResultMessage.from(request, result)` 会自动把 `request.id()` 带进去。这个 id 是模型生成的，回填时必须原样带回，否则服务端会返回 400，提示工具调用与结果不匹配。

工具描述里写的是「什么时候用」，不是「这个函数干什么」。「用户给出订单号时调用」比「查询订单」有效得多，模型是靠这句话决定要不要调、调哪个。

### 3.3 生产版：四道刹车

最小版本能跑，但拦不住失控。下面这个版本加了步数上限、token 预算、超时、重复调用检测，工具异常也不再往上抛。

```java
package com.example.agent;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.langchain4j.agent.tool.ToolExecutionRequest;
import dev.langchain4j.agent.tool.ToolSpecification;
import dev.langchain4j.data.message.AiMessage;
import dev.langchain4j.data.message.ChatMessage;
import dev.langchain4j.data.message.SystemMessage;
import dev.langchain4j.data.message.ToolExecutionResultMessage;
import dev.langchain4j.data.message.UserMessage;
import dev.langchain4j.model.chat.ChatModel;
import dev.langchain4j.model.chat.request.ChatRequest;
import dev.langchain4j.model.chat.request.json.JsonObjectSchema;
import dev.langchain4j.model.chat.response.ChatResponse;
import dev.langchain4j.model.openai.OpenAiChatModel;
import dev.langchain4j.model.output.TokenUsage;

import java.time.Duration;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

public class GuardedAgent {

    private static final ObjectMapper JSON = new ObjectMapper();

    private static final int MAX_STEPS = 8;
    private static final int MAX_TOKENS = 30_000;
    private static final int MAX_SAME_CALL = 2;
    private static final int MAX_CONSECUTIVE_FAILURES = 3;
    private static final Duration MAX_DURATION = Duration.ofSeconds(90);

    private final ChatModel model;
    private final List<ToolSpecification> tools;

    public GuardedAgent(ChatModel model) {
        this.model = model;
        this.tools = List.of(
                ToolSpecification.builder()
                        .name("queryOrder")
                        .description("根据订单号查询订单状态和金额。用户给出订单号时调用。")
                        .parameters(JsonObjectSchema.builder()
                                .addStringProperty("orderId", "订单号")
                                .required("orderId")
                                .build())
                        .build(),
                ToolSpecification.builder()
                        .name("queryShipping")
                        .description("根据订单号查询物流轨迹。只有订单状态为已发货时才调用。")
                        .parameters(JsonObjectSchema.builder()
                                .addStringProperty("orderId", "订单号")
                                .required("orderId")
                                .build())
                        .build()
        );
    }

    public String run(String question) {
        long startNanos = System.nanoTime();
        int usedTokens = 0;
        int consecutiveFailures = 0;
        Map<String, Integer> callCounter = new HashMap<>();

        List<ChatMessage> messages = new ArrayList<>();
        messages.add(SystemMessage.from("你是电商客服。需要数据时调用工具，拿到结果后再回答，不要编造。"));
        messages.add(UserMessage.from(question));

        for (int step = 1; step <= MAX_STEPS; step++) {
            if (System.nanoTime() - startNanos > MAX_DURATION.toNanos()) {
                return "处理超时，请稍后再试";
            }

            ChatResponse response = model.chat(ChatRequest.builder()
                    .messages(messages)
                    .toolSpecifications(tools)
                    .build());

            TokenUsage usage = response.tokenUsage();
            if (usage != null && usage.totalTokenCount() != null) {
                usedTokens += usage.totalTokenCount();
            }

            AiMessage ai = response.aiMessage();
            messages.add(ai);

            if (!ai.hasToolExecutionRequests()) {
                return ai.text();
            }

            if (usedTokens > MAX_TOKENS) {
                return "本轮对话消耗过高，已中止";
            }

            for (ToolExecutionRequest request : ai.toolExecutionRequests()) {
                String fingerprint = request.name() + "|" + request.arguments();
                int times = callCounter.merge(fingerprint, 1, Integer::sum);

                if (times > MAX_SAME_CALL) {
                    messages.add(ToolExecutionResultMessage.builder()
                            .id(request.id())
                            .toolName(request.name())
                            .text("相同参数已经调用过两次，结果不会变化。请基于已有结果直接回答用户。")
                            .build());
                    continue;
                }

                try {
                    String result = execute(request.name(), request.arguments());
                    if (result == null || result.isBlank()) {
                        result = "{\"error\":\"工具没有返回数据，不要重复调用，请如实告知用户\"}";
                    }
                    consecutiveFailures = 0;
                    messages.add(ToolExecutionResultMessage.from(request, result));
                } catch (Exception e) {
                    consecutiveFailures++;
                    messages.add(ToolExecutionResultMessage.builder()
                            .id(request.id())
                            .toolName(request.name())
                            .text("工具执行失败：" + safeMessage(e) + "。不要原样重试，请换一种方式或告知用户。")
                            .isError(true)
                            .build());
                }
            }

            if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                return "系统暂时不可用，请稍后再试";
            }
        }

        return "这个问题有点复杂，我转人工帮你看看";
    }

    private String execute(String name, String arguments) throws Exception {
        JsonNode args = JSON.readTree(arguments);
        String orderId = args.path("orderId").asText();
        return switch (name) {
            case "queryOrder" -> "SO10086".equals(orderId)
                    ? "{\"orderId\":\"SO10086\",\"status\":\"SHIPPED\",\"amount\":199.00}"
                    : "{\"error\":\"订单不存在，请让用户核对订单号\"}";
            case "queryShipping" -> "{\"orderId\":\"" + orderId
                    + "\",\"latest\":\"杭州转运中心已发出\",\"eta\":\"预计次日送达\"}";
            default -> "{\"error\":\"未知工具：" + name + "\"}";
        };
    }

    private String safeMessage(Exception e) {
        String message = e.getMessage();
        if (message == null || message.isBlank()) {
            return e.getClass().getSimpleName();
        }
        return message.length() > 120 ? message.substring(0, 120) + "..." : message;
    }

    public static void main(String[] args) {
        ChatModel model = OpenAiChatModel.builder()
                .apiKey(System.getenv("OPENAI_API_KEY"))
                .baseUrl(System.getenv().getOrDefault("OPENAI_BASE_URL", "https://api.openai.com/v1"))
                .modelName(System.getenv().getOrDefault("LLM_MODEL", "gpt-4o-mini"))
                .temperature(0.0)
                .build();

        System.out.println(new GuardedAgent(model).run("订单 SO10086 到哪了？"));
    }
}
```

四道刹车各自管什么：

- **步数上限**：`MAX_STEPS = 8`。正常客服对话 2 到 3 轮足够，8 轮已经是很复杂的排查。超了直接给兜底话术，不再让模型继续想。
- **Token 预算**：累计 `totalTokenCount`，超过 3 万直接中止。按主流模型的价格，这个阈值对应的单次对话成本是可以接受的上限。
- **墙钟超时**：每轮开始前检查。注意它只能拦在轮次边界，单次模型请求卡住时管不了，真正的硬超时要配在 HTTP 客户端的 `timeout` 上。
- **重复调用检测**：把「工具名 + 参数 JSON」当指纹计数。第三次出现同样的调用，不执行，直接回一条「结果不会变」的提示。这一条最省钱，也最有效。

工具异常那段有个细节值得说：错误文本里加了一句「不要原样重试」。模型的默认倾向是重试，你得在 Observation 里明确否定这个动作，它才会换策略。光写「失败」两个字，等于给它发重试许可证。

### 3.4 框架写法对照

同样的事，用 `AiServices` 只要十几行。看看差别在哪。

```java
package com.example.agent;

import dev.langchain4j.agent.tool.Tool;
import dev.langchain4j.model.chat.ChatModel;
import dev.langchain4j.model.openai.OpenAiChatModel;
import dev.langchain4j.service.AiServices;
import dev.langchain4j.service.SystemMessage;
import dev.langchain4j.service.UserMessage;

public class AiServicesDemo {

    interface OrderAssistant {
        @SystemMessage("你是电商客服。需要数据时调用工具，拿到结果后再回答，不要编造。")
        String chat(@UserMessage String question);
    }

    static class OrderTools {

        @Tool("根据订单号查询订单状态和金额。用户给出订单号时调用。")
        String queryOrder(String orderId) {
            if (!"SO10086".equals(orderId)) {
                return "{\"error\":\"订单不存在，请让用户核对订单号\"}";
            }
            return "{\"orderId\":\"SO10086\",\"status\":\"SHIPPED\",\"amount\":199.00}";
        }

        @Tool("根据订单号查询物流轨迹。只有订单状态为已发货时才调用。")
        String queryShipping(String orderId) {
            return "{\"orderId\":\"" + orderId + "\",\"latest\":\"杭州转运中心已发出\",\"eta\":\"预计次日送达\"}";
        }
    }

    public static void main(String[] args) {
        ChatModel model = OpenAiChatModel.builder()
                .apiKey(System.getenv("OPENAI_API_KEY"))
                .baseUrl(System.getenv().getOrDefault("OPENAI_BASE_URL", "https://api.openai.com/v1"))
                .modelName(System.getenv().getOrDefault("LLM_MODEL", "gpt-4o-mini"))
                .temperature(0.0)
                .build();

        OrderAssistant assistant = AiServices.builder(OrderAssistant.class)
                .chatModel(model)
                .tools(new OrderTools())
                .build();

        System.out.println(assistant.chat("订单 SO10086 到哪了？"));
    }
}
```

注解帮你搞定了 Schema 生成、参数反序列化、循环、结果回填。代价是这些步骤全部不可见。想加「第三次同样调用就拦住」这种逻辑，只能自己写 `ToolExecutor` 或者退回去手写循环。

我的建议：先在 `AiServices` 上把功能跑通，确认模型和工具描述都没问题；只要这个 Agent 要对外、要计费、要审计，就把循环拆出来自己写。拆的过程不痛苦，上面的代码可以直接抄。

## 四、踩过的坑：工具消息回填、空结果、幂等

**调用 id 必须一一对应。** 模型一次返回两个 `tool_calls`，你就得回两条结果消息，id 一个都不能少。只回第一条，OpenAI 协议会直接 400：`An assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'`。并行调用时特别容易漏。

**空字符串是死循环加速器。** 工具查不到数据，正确做法是返回一句有信息的结构化结果，比如 `{"error":"订单不存在，请让用户核对订单号"}`。返回 `""`、`null` 或者 `"fail"`，模型只知道「没成功」，不知道「该换路」，重试几乎是必然。

**异常堆栈别整段喂进去。** 一段 Java 堆栈几千字符，既烧钱又把真正的上下文挤走，还可能带出内网地址和库名。截断到 120 字符，只留能指导下一步的信息。上面 `safeMessage` 就是干这个的。

**写操作必须幂等。** 模型会重试，这是它的天性。发短信、扣库存、创建工单这类工具，参数里必须带一个由业务生成的幂等键，服务端据此去重。没有幂等键的写工具，不要接给模型。

**工具描述要写触发条件。** 「查询物流」这种描述，模型会在任何跟物流沾边的问题上都调它。「只有订单状态为已发货时才调用」把前置条件写进去，无效调用能少一大半。这是零成本的优化。

**历史不能无限堆。** 每轮都把全量 `messages` 发出去，聊到十几轮就会撞上模型的上下文窗口，轻则报错，重则服务端静默截断最早的消息——包括那条系统提示。长会话要自己做裁剪：保留系统提示、最近 N 轮、以及所有工具调用与结果的配对，别把一对拆开。

**日志按步打，不要只打最终结果。** 每轮记四样东西：步号、工具名、参数、耗时。出事时你需要在三十秒内判断是模型抽风还是工具挂了，没有这四样只能靠猜。

**温度调到 0。** Agent 场景要的是稳定复现，不是创意。`temperature(0.0)` 不能保证 100% 确定，但能显著减少「这一轮突然想换个思路」的随机性。

## 五、手写还是用框架：性能与选型对比

| 方案 | 代码量 | 可控性 | 适合场景 |
| --- | --- | --- | --- |
| 手写循环 | 80 到 150 行 | 完全可控，能插任意逻辑 | 对外服务、要计费审计、多租户 |
| LangChain4j `AiServices` | 15 行左右 | 只能配全局参数 | 内部工具、快速验证 |
| Spring AI `ChatClient` | 20 行左右 | 有 Advisor 可挂拦截 | Spring 项目、需要统一观测 |
| AgentScope 这类 Agent 框架 | 依框架而定 | 编排能力强，细节被抽象 | 多 Agent 协作、复杂工作流 |

性能上，瓶颈不在你手写还是用框架，在模型往返次数。一次工具调用的延迟大致是：模型推理 1 到 3 秒，加上工具本身耗时。串行三轮就是三次往返，用户等六秒以上。

能优化的地方有三个：

- **并行工具调用**：模型一次返回多个 `tool_calls` 时，用线程池并发执行，再按 id 顺序回填。协议允许乱序回填，只要 id 对得上。
- **裁工具结果**：工具返回 200 行 JSON，模型只需要其中三个字段。在 `execute` 里就裁好，别指望模型自己忽略噪声。
- **缓存稳定结果**：订单状态、商品信息这类短期不变的数据，按参数做一层几十秒的本地缓存。同一轮对话里重复查询直接命中。

选型的判断标准很简单：这个 Agent 出问题的时候，你能不能只靠日志还原出完整过程。能，用框架；不能，手写。

## 六、总结

Agent 的能力上限由模型决定，工程价值全在循环控制上。模型负责「想」，你负责「什么时候不许它继续想」。

要落地的东西就四件：

1. 步数上限，兜底用，8 轮对客服场景足够
2. Token 预算，按钱算，超了就中止
3. 重复调用检测，工具名加参数做指纹，第三次直接拦
4. 工具结果必须带信息，空的、含糊的、纯报错的，都是死循环燃料

代码不到 150 行，没有黑盒，每一步都能打日志。这比调框架参数省心得多。

真要说最大的坑，不是循环写不出来，是很多人压根不知道自己的 Agent 在循环。上线前把每步的工具名和参数打进日志，跑十次真实对话看一眼，问题基本就暴露了。

最后一句可能不太中听：不是所有场景都值得上 Agent。流程固定、分支有限、输入格式统一的业务，写死几个 if 比让模型自由发挥便宜、快、还可测。Agent 适合的是「用户想干什么事先说不清」的那类问题。判断错了方向，循环写得再漂亮也是白搭。

文 / 会编程的吕洞宾

## 参考资料

- [LangChain4j 官方文档：Tools](https://docs.langchain4j.dev/tutorials/tools)
- [LangChain4j 官方文档：AI Services](https://docs.langchain4j.dev/tutorials/ai-services)
- [OpenAI 官方文档：Function Calling](https://platform.openai.com/docs/guides/function-calling)
- [ReAct: Synergizing Reasoning and Acting in Language Models](https://arxiv.org/abs/2210.03629)
