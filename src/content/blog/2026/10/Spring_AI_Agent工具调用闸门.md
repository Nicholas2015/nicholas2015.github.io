---
title: "Spring AI Agent 工具调用失控？加上这道闸门"
date: 2026-10-20T20:00:00+08:00
category: "AI"
tags: ["spring-ai", "agent"]
---

**摘要：** Agent 反复调同一个工具、一次提问烧掉几十次模型请求，是 Java 侧最常见的线上事故。本文用 Spring AI 拆开工具调用循环：模型只出意图、应用负责执行。先用内置限额兜底，再用手写循环加审批和审计，附完整可运行代码。

> 凌晨两点，客服 Agent 收到一句「我的退款到哪了」。它调查询接口，没查到，换个订单号再查，还是没查到，于是继续换。四十分钟后监控报警：同一个查询工具被调了 380 次，模型账单翻了三倍，下游订单服务被打到超时。你翻日志，只看到最后一句「抱歉，我没查到」——中间那几百次调用，框架一口吞了。问题不在模型笨，在于你把「决定调什么工具」和「执行工具」这两件事，一起交给了框架。

## 一、这个问题到底是什么

结论：Agent 失控不是模型不听话，是应用侧没有给它画边界。

先把「Agent」这个词拆开。它没那么玄，本质就是一个循环：模型说要调工具，程序去执行，把结果塞回对话，再问模型一次，直到模型不再要工具、直接给答案。所谓智能，全靠这个循环转起来。

循环能干活，也能闯祸。线上见得多的是三种：

- **原地打转。** 工具返回「订单不存在」，模型换个参数再试，试到天荒地老。它没有「我该停了」的概念，只有「下一步生成什么 token」。
- **越权操作。** 查询工具和退款工具摆在同一个列表里，模型为了「帮用户解决问题」，自己决定发起退款。它不觉得这是越权，它觉得这是完成任务。
- **打爆下游。** 一次提问触发七八个并行工具调用，每个都打到你那个只有两个实例的订单服务上。模型不会限流，它只会一次生成五个 tool call。

### 自动执行的两个代价

Spring AI 的 `ChatClient` 默认帮你把整个循环跑完：你写一句 `chatClient.prompt().user(...).tools(orderTools).call().content()`，拿到的就是最终文本。方便，但代价有两个。

第一，**中间过程不可见**。循环在 advisor 链里跑，你的业务代码只拿到最后一句字符串。想知道它调了几次、调了什么、每次返回什么，得另外接观测。

第二，**没有插入检查点的位置**。审批、风控、审计，全都需要「模型说想调，但还没真调」的那一瞬间。自动模式不给你这一帧。

框架不是完全没设防。它内置了调用次数上限：**单个工具默认 40 次，一轮对话累计 150 次**，超了就抛异常或者回一条错误消息。这能防住无限循环，但防不住业务事故——40 次查询足够让你那个小服务挂掉，40 次退款足够让财务找你谈话。

兜底和可控，是两件事。

## 二、底层原理到底怎么回事

结论：模型从头到尾没有执行过任何工具，它只是输出了一段结构化文本，执行权一直在你的 Java 代码手里。

### 一次工具调用，实际发生了什么

以 OpenAI 兼容接口为例，一轮完整的工具调用是这样走的：

| 步骤 | 谁在做 | 产出 |
| --- | --- | --- |
| 1 | 你的代码 | 把工具清单（名字、描述、参数 JSON Schema）随请求发给模型 |
| 2 | 模型 | 返回 `tool_calls`，里面有 `id`、函数名、参数字符串 |
| 3 | 你的代码 | 按名字找到本地方法，执行，拿到结果 |
| 4 | 你的代码 | 发一条 `role=tool` 的消息，带 `tool_call_id` 和结果文本 |
| 5 | 模型 | 看到结果，决定继续调工具，还是给最终答案 |

关键在第二步：模型返回的 `arguments` 是一段 **JSON 字符串**，不是对象。它可能写 `{"orderNo":"SO2026"}`，也可能写 `{"order_no":"SO2026"}`，还可能少个引号。这段文本在你解析之前，什么都还不是。

Spring AI 把它建模成 `AssistantMessage.ToolCall`，四个字段：`id`、`type`、`name`、`arguments`。`id` 是配对凭证。

### 为什么漏一条消息就 400

协议要求严格配对：每个 `tool_call` 都必须有一条 `tool_call_id` 相同的 `tool` 消息。模型一次返回三个并行调用，你就得回三条。少一条，下一次请求直接 400，报错大意是「tool_call_id 没有对应的响应」。

这不是模型挑剔，是它的上下文结构必须完整。它记得自己发过三个调用，你只回了两个，剩下那个在它眼里是悬空的。

所以哪怕工具名不存在、参数解析失败、用户拒绝执行，你也得造一条 `ToolResponse` 回给它。**错误也是一种结果，必须回填。**

### Spring AI 的两条执行路径

这是全文最需要记住的一张图：

- **`ChatClient` 路径**：自动注册 `ToolCallingAdvisor`，它在内部 `while (isToolCall)` 循环，调 `ToolCallingManager` 执行工具，直到模型不再要工具。你的代码在循环外面。
- **`ChatModel` 路径**：`chatModel.call(prompt)` 只发一次请求，拿到 `tool_calls` 就返回。它不执行、不循环。循环要你自己写。

想插手，就往下走一层。这不是绕过框架，是用框架更底层的公开接口。

### 限额是在哪一层生效的

`DefaultToolCallingManager` 在每次执行前，会数一遍「当前这一轮已经执行过多少次」——它扫的是对话历史里、最后一条用户消息之后的那些 `ToolResponse`。所以计数是按轮重置的，不会把昨天的调用算进来。

超限之后有两种处理方式：

- `THROW`：直接抛 `ToolCallLimitExceededException`，整批调用中断，这一轮请求失败。
- `RETURN_ERROR_RESPONSE`：不执行，但造一条 `ToolResponse` 告诉模型「这个工具调用次数到顶了」，让模型自己收尾。

**我推荐后者。** 抛异常等于把烂摊子丢给用户，回一条错误消息等于给模型一个台阶，它多半能基于已有信息给出个像样的回答。

### 审批为什么必须卡在执行前

工具一旦执行，副作用就发生了。退款发出去了，短信发出去，工单建好了，你再拦已经晚了。

审批的正确位置只有一个：模型说要调、本地方法还没跑的那一帧。这也是手写循环唯一的、不可替代的价值。

被拒绝时，别抛异常，回一条 `ToolResponse`：「用户拒绝执行，原因：金额超限，不要重试」。模型看得懂这句话，它会改成告诉用户「这笔退款需要人工审批」。

## 三、实战：手把手写代码

结论：先花十行配置让自动模式带上限额，再把关键链路换成手写循环，拿到审批和审计的能力。

### 3.1 项目骨架

一个 Web 应用，加上 OpenAI 兼容的模型接入。依赖版本全部写全，照抄能跑。

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
    <artifactId>guarded-agent</artifactId>
    <version>0.0.1-SNAPSHOT</version>

    <properties>
        <java.version>21</java.version>
    </properties>

    <dependencyManagement>
        <dependencies>
            <dependency>
                <groupId>org.springframework.ai</groupId>
                <artifactId>spring-ai-bom</artifactId>
                <version>2.0.1</version>
                <type>pom</type>
                <scope>import</scope>
            </dependency>
        </dependencies>
    </dependencyManagement>

    <dependencies>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-web</artifactId>
            <version>4.1.1</version>
        </dependency>
        <dependency>
            <groupId>org.springframework.ai</groupId>
            <artifactId>spring-ai-starter-model-openai</artifactId>
            <version>2.0.1</version>
        </dependency>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-test</artifactId>
            <version>4.1.1</version>
            <scope>test</scope>
        </dependency>
    </dependencies>

    <build>
        <plugins>
            <plugin>
                <groupId>org.springframework.boot</groupId>
                <artifactId>spring-boot-maven-plugin</artifactId>
            </plugin>
        </plugins>
    </build>
</project>
```

配置文件只有三行有用的东西：

```yaml
spring:
  ai:
    openai:
      api-key: ${OPENAI_API_KEY}
      chat:
        model: gpt-4.1-mini
```

模型名放在配置里，代码里不写死。换个模型只改这一行。

### 3.2 定义两个工具

查询是只读的，退款是写操作。真实项目里它们通常在不同的 service 里，这里用内存 Map 代替数据库，把注意力留给循环本身。

```java
package com.example.agent.tool;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

import org.springframework.ai.tool.annotation.Tool;
import org.springframework.ai.tool.annotation.ToolParam;
import org.springframework.stereotype.Component;

@Component
public class OrderTools {

    private final Map<String, String> orders = new ConcurrentHashMap<>(Map.of(
            "SO20261019001", "已发货",
            "SO20261019002", "已签收"));

    @Tool(name = "queryOrder", description = "按订单号查询订单当前状态。只读，可以放心调用。")
    public String queryOrder(
            @ToolParam(description = "订单号，例如 SO20261019001") String orderNo) {
        String status = this.orders.get(orderNo);
        if (status == null) {
            return "订单不存在：" + orderNo;
        }
        return "订单 " + orderNo + " 当前状态：" + status;
    }

    @Tool(name = "refundOrder", description = "对指定订单发起退款。写操作，会产生真实资金变动。")
    public String refundOrder(
            @ToolParam(description = "订单号") String orderNo,
            @ToolParam(description = "退款金额，单位元") double amount) {
        if (!this.orders.containsKey(orderNo)) {
            return "订单不存在，退款未执行：" + orderNo;
        }
        if (amount <= 0 || amount > 5000) {
            return "退款金额不合法，单笔上限 5000 元：" + amount;
        }
        return "已为订单 " + orderNo + " 提交退款 " + amount + " 元，审批单号 RF"
                + Math.abs(orderNo.hashCode());
    }
}
```

`@Tool` 的描述是写给模型看的，不是写给人看的。描述里写清「只读」「写操作」，模型自己就会更谨慎；只写「退款」，它就敢随便调。

参数校验必须放在方法里再做一遍。模型给你的金额可能是负数，也可能是 `999999`，它不看你的业务规则。

### 3.3 方案 A：给自动模式装上闸门

不想改调用方式，只想加限额，就替换掉默认的工具执行器。

```java
package com.example.agent.config;

import com.example.agent.tool.OrderTools;

import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.client.advisor.ToolCallingAdvisor;
import org.springframework.ai.chat.model.ChatModel;
import org.springframework.ai.model.tool.ToolCallLimitBehavior;
import org.springframework.ai.model.tool.ToolCallingManager;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class GuardedChatClientConfig {

    @Bean
    public ToolCallingManager toolCallingManager() {
        return ToolCallingManager.builder()
                .maxCallsPerTool(3)
                .maxCallsPerTool("queryOrder", 5)
                .maxTotalToolCalls(8)
                .onLimitExceeded(ToolCallLimitBehavior.RETURN_ERROR_RESPONSE)
                .build();
    }

    @Bean
    public ChatClient guardedChatClient(ChatModel chatModel,
                                        ToolCallingManager toolCallingManager,
                                        OrderTools orderTools) {
        return ChatClient.builder(chatModel)
                .defaultSystem("""
                        你是订单客服助手。查到结果就直接回答，不要重复调用同一个工具。
                        涉及退款时，先向用户确认订单号和金额。
                        """)
                .defaultTools(orderTools)
                .defaultAdvisors(ToolCallingAdvisor.builder()
                        .toolCallingManager(toolCallingManager)
                        .build())
                .build();
    }
}
```

这里有两个细节。

`ToolCallingManager.builder()` 造出来的是默认执行器，链式加上三种限制：每个工具默认 3 次，`queryOrder` 单独放宽到 5 次，整轮最多 8 次。数字要按你的下游承受能力定，不是按模型的心情定。

第二个细节：`ChatClient` 只有在发现链上没有工具类 advisor 时，才会自动注册默认那个。我们手动放了一个 `ToolCallingAdvisor` 进去，自动注册就跳过了，用的就是我们的执行器。这一步不做，限额配了也不生效。

### 3.4 方案 B：自己写循环，插入审批

需要审批、审计、按步骤展示进度，就得自己转这个循环。

先定义审批口子。它是一句问句：「这个工具、这组参数，能执行吗？」

```java
package com.example.agent.core;

public interface ApprovalGate {

    Decision check(String toolName, String argumentsJson);

    record Decision(boolean allowed, String reason) {

        public static Decision allow() {
            return new Decision(true, "");
        }

        public static Decision deny(String reason) {
            return new Decision(false, reason);
        }
    }
}
```

再给一个规则实现：只读工具直接放行，退款超过 1000 元要人工审批，参数不是合法 JSON 一律拒绝。

```java
package com.example.agent.core;

import java.util.Set;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

@Component
public class RuleBasedApprovalGate implements ApprovalGate {

    private static final Logger log = LoggerFactory.getLogger(RuleBasedApprovalGate.class);

    private static final Set<String> READ_ONLY_TOOLS = Set.of("queryOrder");

    private final ObjectMapper objectMapper = new ObjectMapper();

    @Override
    public Decision check(String toolName, String argumentsJson) {
        if (READ_ONLY_TOOLS.contains(toolName)) {
            return Decision.allow();
        }
        try {
            JsonNode args = this.objectMapper.readTree(argumentsJson);
            double amount = args.path("amount").asDouble(0);
            if (amount > 1000) {
                log.info("refund over limit, need manual approval: {}", argumentsJson);
                return Decision.deny("退款金额超过 1000 元，需要人工审批");
            }
        }
        catch (Exception ex) {
            return Decision.deny("工具参数不是合法 JSON，拒绝执行");
        }
        return Decision.allow();
    }
}
```

然后是主角。这个类把「调模型」和「执行工具」拆成两件事，中间留出审批和记录的位置。

```java
package com.example.agent.core;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import com.example.agent.tool.OrderTools;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import org.springframework.ai.chat.messages.AssistantMessage;
import org.springframework.ai.chat.messages.AssistantMessage.ToolCall;
import org.springframework.ai.chat.messages.Message;
import org.springframework.ai.chat.messages.SystemMessage;
import org.springframework.ai.chat.messages.ToolResponseMessage;
import org.springframework.ai.chat.messages.ToolResponseMessage.ToolResponse;
import org.springframework.ai.chat.messages.UserMessage;
import org.springframework.ai.chat.model.ChatResponse;
import org.springframework.ai.chat.prompt.Prompt;
import org.springframework.ai.openai.OpenAiChatModel;
import org.springframework.ai.openai.OpenAiChatOptions;
import org.springframework.ai.support.ToolCallbacks;
import org.springframework.ai.tool.ToolCallback;
import org.springframework.stereotype.Service;

@Service
public class ControlledAgent {

    private static final Logger log = LoggerFactory.getLogger(ControlledAgent.class);

    private static final String SYSTEM_PROMPT = """
            你是订单客服助手。先查订单状态再回答。
            如果工具返回的信息已经够用，就直接给结论，不要重复调用同一个工具。
            """;

    private final OpenAiChatModel chatModel;

    private final Map<String, ToolCallback> tools = new LinkedHashMap<>();

    private final ApprovalGate approvalGate;

    private final int maxSteps = 6;

    private final int maxToolCalls = 8;

    public ControlledAgent(OpenAiChatModel chatModel, OrderTools orderTools, ApprovalGate approvalGate) {
        this.chatModel = chatModel;
        this.approvalGate = approvalGate;
        for (ToolCallback callback : ToolCallbacks.from(orderTools)) {
            this.tools.put(callback.getToolDefinition().name(), callback);
        }
    }

    public AgentRun run(String task) {
        List<Message> messages = new ArrayList<>();
        messages.add(new SystemMessage(SYSTEM_PROMPT));
        messages.add(new UserMessage(task));

        OpenAiChatOptions options = this.chatModel.getOptions().mutate()
                .toolCallbacks(List.copyOf(this.tools.values()))
                .build();

        List<TraceStep> trace = new ArrayList<>();
        int toolCalls = 0;

        for (int step = 1; step <= this.maxSteps; step++) {
            ChatResponse response = this.chatModel.call(new Prompt(List.copyOf(messages), options));
            AssistantMessage assistant = response.getResult().getOutput();
            messages.add(assistant);

            List<ToolCall> calls = assistant.getToolCalls();
            if (calls.isEmpty()) {
                String answer = assistant.getText() == null ? "" : assistant.getText();
                return new AgentRun(answer, trace, true);
            }

            List<ToolResponse> responses = new ArrayList<>();
            for (ToolCall call : calls) {
                toolCalls++;
                responses.add(new ToolResponse(call.id(), call.name(), execute(call, toolCalls, trace)));
            }
            messages.add(ToolResponseMessage.builder().responses(responses).build());
        }

        log.warn("agent stopped at max steps, trace={}", trace);
        return new AgentRun("这个问题我处理不了，已转人工。", trace, false);
    }

    private String execute(ToolCall call, int index, List<TraceStep> trace) {
        ToolCallback callback = this.tools.get(call.name());
        if (callback == null) {
            return "没有名为 " + call.name() + " 的工具，请从可用工具里重新选择。";
        }
        if (index > this.maxToolCalls) {
            return "本轮工具调用次数已达上限，请基于已有信息直接回答。";
        }

        ApprovalGate.Decision decision = this.approvalGate.check(call.name(), call.arguments());
        String result;
        if (!decision.allowed()) {
            result = "用户拒绝执行该操作：" + decision.reason() + "。不要重试，请换一种方式或告知用户。";
        }
        else {
            try {
                result = callback.call(call.arguments());
            }
            catch (Exception ex) {
                log.warn("tool {} failed", call.name(), ex);
                result = "工具执行失败：" + ex.getMessage();
            }
        }
        trace.add(new TraceStep(trace.size() + 1, call.name(), call.arguments(), result));
        return result;
    }

    public record AgentRun(String answer, List<TraceStep> trace, boolean finished) {
    }

    public record TraceStep(int index, String tool, String arguments, String result) {
    }
}
```

逐段解释几个关键点。

`ToolCallbacks.from(orderTools)` 把带 `@Tool` 注解的方法包装成 `ToolCallback`，再用工具名建索引。名字是模型返回的唯一线索，所以索引必须按 `ToolDefinition.name()` 建，不能按方法名猜。

`chatModel.getOptions().mutate()` 是拿配置里的默认选项做底，再叠加工具列表。这一步不能省：如果你直接 `OpenAiChatOptions.builder().toolCallbacks(...)`，模型名、温度这些默认值都不会带上，请求发出去会被服务端拒绝。模型只在 `prompt.getOptions()` 为空时才回退到默认值，你一旦传了选项，它就当你全权负责。

`maxSteps` 和 `maxToolCalls` 是两道不同的闸。前者限制「问模型几次」，后者限制「执行几个工具」。一次响应可能带五个并行调用，所以两者不能合并。

`execute` 里三种情况都返回字符串，都回填成 `ToolResponse`：工具不存在、次数超限、被拒绝。少回一条，下一轮请求就 400。

最后暴露一个 HTTP 入口，顺便把 trace 一起返回，方便你在页面上展示「它刚才干了什么」。

```java
package com.example.agent.web;

import com.example.agent.core.ControlledAgent;

import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/agent")
public class AgentController {

    private final ControlledAgent agent;

    public AgentController(ControlledAgent agent) {
        this.agent = agent;
    }

    @PostMapping("/run")
    public ControlledAgent.AgentRun run(@RequestBody RunRequest request) {
        return this.agent.run(request.task());
    }

    public record RunRequest(String task) {
    }
}
```

请求一下：

```bash
curl -s -X POST http://localhost:8080/agent/run \
  -H 'Content-Type: application/json' \
  -d '{"task":"订单 SO20261019001 一直没收到，帮我退款 3000 元"}'
```

返回里会看到 `trace`：查了几次、每次参数是什么、结果是什么、哪一步被审批拦下。这就是自动模式给不了的东西。

## 四、踩坑经验和最佳实践

结论：工具调用的坑，九成出在「消息没配对」和「把模型当可信输入」这两件事上。

### 消息配对，一条都不能少

模型返回三个 `tool_call`，你必须回三条 `tool` 消息，`id` 一一对应。最常见的翻车写法是：工具抛异常就 `throw`，然后整个请求挂掉。

正确做法是把异常转成结果文本，照样回填。工具挂了不是对话结束的理由，模型看到「查询超时」还能告诉用户稍后再试。

### 参数是字符串，不是对象

`call.arguments()` 返回的是一段 JSON 文本。别拿它直接拼 SQL，也别拿它直接当金额用。先解析，再校验，再执行。模型可能被用户的话术带着走，写出 `{"amount": -500}` 这种参数——负数额退款，在账上就是扣钱。

写操作的校验必须落在工具方法内部，不能只靠提示词。

### 拒绝要用错误消息，不要抛异常

超限、被拒、工具不存在，全部走 `ToolResponse`。抛异常会让整轮失败，用户看到的是 500；回一条消息，模型会说「这个需要人工处理」，体验差一个量级。

### 计数是按轮算的

框架数的是「最后一条用户消息之后」的调用次数。所以别在每轮请求里把历史消息重复拼两遍，否则你自己数的和框架数的对不上，限额会在奇怪的时候触发。

### 写操作必须有幂等键

模型重试是常态，网络抖动也是常态。退款、下单、发消息，这类工具都要带业务幂等键，重复调用返回同一结果。别指望模型「只调一次」。

### 工具内部要设超时

模型不会等你三分钟。工具里调 HTTP 或查库，自己设 3 到 5 秒超时，超时转成结果文本返回。一个卡住的工具能让整个 Agent 挂在那儿，连接池先满。

### 历史会越滚越大

每轮循环都要把完整历史重发给模型。六轮之后，输入 token 是第一轮的好几倍，而其中大半是重复的工具返回。长对话里要裁剪：只保留最近 N 轮工具结果，或者把大段返回先摘要再入历史。

### 流式场景别硬套

`chatModel.call()` 是同步接口，拿不到流式增量。要流式输出，就得用 `stream()` 自己聚合 `tool_calls` 分片，复杂度上一个台阶。我的建议是：需要审批和审计的链路，老老实实用同步；纯问答的链路再上流式。

## 五、性能对比和技术选型

结论：八成场景用自动模式加限额就够，只有涉及钱、涉及写操作、涉及合规的场景，才值得手写循环。

| 维度 | ChatClient 自动 | 自定义执行器 | 手写循环 |
| --- | --- | --- | --- |
| 代码量 | 一行 | 十行配置 | 一个类 |
| 执行前审批 | 做不到 | 做不到 | 可以 |
| 调用次数上限 | 有默认值 | 可精细配置 | 自己数 |
| 步骤可见性 | 靠观测埋点 | 靠观测埋点 | 天然有 trace |
| 流式支持 | 完整 | 完整 | 需自行聚合 |
| 适合场景 | 内部问答、只读查询 | 有下游压力约束 | 资金、写操作、合规 |

选型就看一个问题：**工具执行错了，你能不能接受？**

只读查询错了，重查一次就行，用自动模式，配置三个数字收工。涉及退款、改地址、发通知，执行了就得有人负责，那就下手写循环，把审批卡在中间。

还有一种中间态：自动模式跑主流程，写操作单独抽成一个「提交审批单」的工具。模型只能创建审批单，不能直接执行。这个思路很实用——把不可逆操作变成可逆的申请，模型再能折腾也翻不了天。

性能上别太纠结。多一层循环，多的是模型请求次数，不是 CPU。真正烧钱的是历史重复发送，优化重点在裁剪上下文，不在循环写法。一次六轮的对话，输入 token 大约是单轮的 3 到 4 倍，这个倍率比任何代码微调都重要。

## 六、总结

工具调用的本质是一次「模型出意图、代码执行」的握手。模型负责说，你负责做，做不做、做几次、要不要人点头，全是你的决定。

框架的默认值能防住无限循环，防不住业务事故。40 次查询和 40 次退款，在计数上一样，在后果上差着十万八千里。所以限额要配，但别把它当安全带。

真要把 Agent 放上线，记住三句话：执行前有审批，执行后有记录，异常时能收尾。前两句靠手写循环，最后一句靠把错误当结果回填。

至于模型会不会重复调工具——它会。你要做的不是教育它，是让它重复也没用。

## 参考资料

- [Spring AI Tool Calling](https://docs.spring.io/spring-ai/reference/api/tools.html)
- [Spring AI ChatClient](https://docs.spring.io/spring-ai/reference/api/chatclient.html)
- [OpenAI Function Calling Guide](https://platform.openai.com/docs/guides/function-calling)

文 / 会编程的吕洞宾
