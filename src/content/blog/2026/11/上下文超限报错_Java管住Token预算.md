---
title: 上下文超限报错_Java管住Token预算
date: 2026-11-19T20:53:41+08:00
tags: ["ai"]
categories: ai
---

# 上下文超限报错_Java管住Token预算

> 客服 Agent 上线第三天，凌晨两点告警：`context_length_exceeded`。翻日志发现，出事的会话都聊了二十多轮，每轮还要塞三条订单记录。第一反应是把历史截成最近十条，报错没了，投诉来了——用户五分钟前说过收货地址填错了，机器人又推荐了一遍换货流程。调大窗口、降低温度、换更贵的模型，全是治标。真正要解决的就一件事：一次请求里，token 到底该分给谁。

## 一、这个问题到底是什么

**上下文超限不是"话说太多"，是输入和输出在抢同一块内存。**

大模型每次请求能读写的 token 总量有硬上限，业界叫上下文窗口（context window）。注意它管的是"输入 + 输出"的合计，不是只管输入。窗口 8k 的模型，你塞 7900 token 的历史进去，模型顶多回你 100 token 就开始断句，再往后直接报错。

一份请求里的 token 通常被五拨人分掉：

- 系统提示词（角色、规则、输出格式要求）
- 工具定义（每个函数的 JSON Schema 都算钱）
- 历史对话（用户消息 + 模型回复 + 工具调用与返回值）
- 检索片段（RAG 召回的文档块）
- 模型这次的输出

前四项相加必须小于"窗口 - 输出预留"。这个减法没做，就会出现下面三种故障，而且只有第一种你能立刻看见。

**第一种，硬报错。** HTTP 400，错误码 `context_length_exceeded` 或 `maximum context length is 8192 tokens`。这种最好处理，至少它喊了。

**第二种，静默截断。** 部分网关、部分自建推理服务在超限时不报错，直接从头或从尾砍掉一段。你收到 200，内容看着也正常，但模型其实没看到你最重要的系统提示词。

**第三种，不报错，质量塌方。** 请求刚好卡在窗口边缘，模型能读完，但注意力被摊薄。表现是答非所问、忘掉前面确认过的条件、把两轮之前的信息张冠李戴。这类问题最难查，因为你以为是模型不行。

### 为什么"只留最近 10 条"是个坏主意

这是线上最常见的土办法，三个坑：

1. **前提丢了。** 用户的会员等级、收货城市、已确认的订单号，往往在第三轮说的，第十一轮被截掉，模型只能重新问一遍。用户感受就是"这机器人有病"。
2. **工具消息被拆散。** 协议规定 tool 结果必须紧跟发起调用的 assistant 消息。你按条数截，很可能留下结果、砍掉调用，服务端直接 400，报 `messages with role 'tool' must be a response to a preceding message with 'tool_calls'`。
3. **大块内容一进来就爆。** 工具返回一个 8000 token 的订单 JSON，最近 10 条里它占 8 条的量，剩下 2 条历史还不如不留。

所以正确的做法不是"留几条"，而是"算预算"：先算出这次能用多少输入 token，再按重要性往里装，装不下的时候有策略地压缩，而不是无脑丢。

## 二、底层原理到底怎么回事

### token 不是字，估错了全盘皆输

token 是分词器切出来的最小单位。一个汉字在主流分词器里经常是 1 个 token，生僻字、繁体、emoji 会拆成 2 到 3 个；英文大约 4 个字符 1 个 token；一串数字和 JSON 标点反而更费，因为 `{"orderId":` 这种结构会被切得很碎。

后果很直接：你用 `content.length() / 4` 估算，中文场景能低估 40% 以上，英文场景又可能高估。估低了，你以为还剩 500 token，实际已经超了。

**必须用目标模型自己的分词器。** 用 GPT 系模型就用 OpenAI 的分词器，用 Qwen、GLM 就用对应厂商的。LangChain4j 把这件事抽象成了 `TokenCountEstimator` 接口：

```java
public interface TokenCountEstimator {
    int estimateTokenCountInText(String text);
    int estimateTokenCountInMessage(ChatMessage message);
    int estimateTokenCountInMessages(Iterable<ChatMessage> messages);
}
```

官方 OpenAI 实现是 `OpenAiTokenCountEstimator`，底层跑的 jtokkit，跟服务端计费口径基本一致。换成别的模型厂商，自己实现这三个方法就行。

还有一个细节：接口返回的是"文本 token"，不含消息结构开销。每条消息的角色标记、分隔符、`<|im_start|>` 这类控制符都要占 3 到 8 个 token。几十条消息攒下来就是几百 token 的误差，做预算时得单独加一档。

### 预算公式，就一个减法

```
input_budget = context_window - output_reserve - safety_margin
```

三个参数怎么定：

- `context_window`：模型真实窗口。别信营销页，去查模型卡或者服务端的 `max_model_len`。
- `output_reserve`：这次回答最多允许多长。客服场景 500 到 1500 足够，代码生成给 4000。
- `safety_margin`：兜住估算误差，一般给窗口的 2% 到 5%，小窗口模型至少留 200。

算出 `input_budget` 之后，系统提示词和工具定义是"固定开销"，先扣掉；剩下的才是历史和检索片段能分的。这个顺序不能反——很多实现是先装历史，最后发现系统提示词塞不进去，于是把系统提示词砍了，模型直接失忆。

### 三种逐出策略，本质是三种取舍

**直接丢弃。** 保留最近 N 轮，其余删掉。实现最简单，零额外成本。缺点是丢得毫无章法，用户明确说过的约束也可能被丢。

**摘要压缩。** 把要丢的旧对话交给模型，压成一段事实摘要，替换掉原文。信息保留得比丢弃好，代价是每压一次多一次模型调用。要小心的是"链式摘要"：拿上次的摘要 + 新内容再压一次，压五六轮之后细节全糊成一团，还会混进模型自己的臆测。稳妥做法是摘要只记"事实卡片"——用户身份、已确认结论、未解决问题、明确限制，并且给摘要长度设硬上限。

**外置成检索。** 旧对话写进向量库，每轮按当前问题召回相关的几段。理论上信息无损，实际上依赖召回质量，而且多一次检索延迟。适合超长会话（客服工单、陪伴类应用），普通问答属于杀鸡用牛刀。

| 策略 | 额外成本 | 信息保留 | 实现复杂度 | 适合场景 |
| --- | --- | --- | --- | --- |
| 按条数/轮数截断 | 0 | 差，容易丢前提 | 低 | 原型、短会话 |
| 按 token 预算逐出 | 0 | 中，可控 | 中 | 绝大多数业务 |
| 预算 + 摘要压缩 | 每轮少量摘要 token | 较好 | 中高 | 长会话、客服 |
| 预算 + 向量外置 | 检索延迟 + 存储 | 好 | 高 | 超长会话、知识型陪伴 |

### 消息成对性：截断最隐蔽的雷

OpenAI 风格的消息协议里，一次工具调用是两条消息：assistant 发 `tool_calls`，紧接着 tool 角色回结果，`tool_call_id` 必须对得上。你从中间切一刀，留下结果砍掉调用，或者反过来，服务端直接拒收。

同理，多工具并行调用时是一组 `tool_calls` 对应多条 tool 消息，切的时候必须整组切。所以逐出的最小单位不是"一条消息"，而是"一轮"——从一条用户消息开始，到下一个用户消息之前为止。按轮切，配对天然完整。

### 注意力不均匀，位置也是预算

同样 3000 token，放在开头和放在中间效果不一样。长上下文模型普遍存在"中间遗忘"：开头和结尾的内容记得牢，中间一段容易被忽略。

能用的两个技巧：系统提示词固定在第一条；最近一轮用户问题固定在最后一条。中间那堆历史和检索片段，本来就是可以被压缩的部分。这也是为什么"把最重要的规则塞在中间"是个反模式。

## 三、实战：手把手写代码

下面这套东西四个类，能直接跑。目标是把"预算计算 - 逐出 - 摘要 - 调用"串成一条线。

### 3.1 依赖

```xml
<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
    <modelVersion>4.0.0</modelVersion>

    <groupId>com.example</groupId>
    <artifactId>context-budget-demo</artifactId>
    <version>1.0.0</version>

    <properties>
        <maven.compiler.release>21</maven.compiler.release>
        <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
    </properties>

    <dependencyManagement>
        <dependencies>
            <dependency>
                <groupId>dev.langchain4j</groupId>
                <artifactId>langchain4j-bom</artifactId>
                <version>1.24.0</version>
                <type>pom</type>
                <scope>import</scope>
            </dependency>
        </dependencies>
    </dependencyManagement>

    <dependencies>
        <dependency>
            <groupId>dev.langchain4j</groupId>
            <artifactId>langchain4j-core</artifactId>
            <version>1.24.0</version>
        </dependency>
        <dependency>
            <groupId>dev.langchain4j</groupId>
            <artifactId>langchain4j</artifactId>
            <version>1.24.0</version>
        </dependency>
        <dependency>
            <groupId>dev.langchain4j</groupId>
            <artifactId>langchain4j-open-ai</artifactId>
            <version>1.24.0</version>
        </dependency>
    </dependencies>
</project>
```

`langchain4j-core` 放基础类型，`langchain4j` 放 `ChatMemory` 和 `MessageWindowChatMemory` 这些实现，`langchain4j-open-ai` 提供模型客户端和分词器。

### 3.2 第一步：把 token 计量封装起来

```java
package com.example.context;

import dev.langchain4j.data.message.AiMessage;
import dev.langchain4j.data.message.ChatMessage;
import dev.langchain4j.data.message.SystemMessage;
import dev.langchain4j.data.message.ToolExecutionResultMessage;
import dev.langchain4j.data.message.UserMessage;
import dev.langchain4j.model.TokenCountEstimator;

import java.util.List;

public class TokenMeter {

    private final TokenCountEstimator estimator;

    public TokenMeter(TokenCountEstimator estimator) {
        this.estimator = estimator;
    }

    public int count(String text) {
        if (text == null || text.isBlank()) {
            return 0;
        }
        return estimator.estimateTokenCountInText(text);
    }

    public int count(ChatMessage message) {
        return estimator.estimateTokenCountInMessage(message) + overhead(message);
    }

    public int count(List<ChatMessage> messages) {
        int total = 0;
        for (ChatMessage message : messages) {
            total += count(message);
        }
        return total;
    }

    private int overhead(ChatMessage message) {
        if (message instanceof ToolExecutionResultMessage) {
            return 6;
        }
        if (message instanceof AiMessage ai && !ai.toolExecutionRequests().isEmpty()) {
            return 8;
        }
        return 4;
    }

    public static String textOf(ChatMessage message) {
        if (message instanceof SystemMessage systemMessage) {
            return systemMessage.text();
        }
        if (message instanceof UserMessage userMessage) {
            return userMessage.singleText();
        }
        if (message instanceof AiMessage aiMessage) {
            return aiMessage.text() == null ? "" : aiMessage.text();
        }
        if (message instanceof ToolExecutionResultMessage toolMessage) {
            return toolMessage.text();
        }
        return "";
    }
}
```

关键点有两个。`overhead` 补的是消息结构开销，纯文本接口算不出来，不加这一档，几十轮下来能差出几百 token。`textOf` 只处理文本，遇到多模态内容会取第一条文本——真要做多模态预算，图片得单独按分辨率折算，别指望这里。

### 3.3 第二步：预算对象

```java
package com.example.context;

public final class ContextBudget {

    private final int contextWindow;
    private final int outputReserve;
    private final int safetyMargin;

    public ContextBudget(int contextWindow, int outputReserve, int safetyMargin) {
        if (outputReserve + safetyMargin >= contextWindow) {
            throw new IllegalArgumentException("输出预留加安全余量已经吃满窗口，输入没地方放了");
        }
        this.contextWindow = contextWindow;
        this.outputReserve = outputReserve;
        this.safetyMargin = safetyMargin;
    }

    public int inputBudget() {
        return contextWindow - outputReserve - safetyMargin;
    }

    public boolean fits(int usedTokens) {
        return usedTokens <= inputBudget();
    }

    public int contextWindow() {
        return contextWindow;
    }

    public int outputReserve() {
        return outputReserve;
    }
}
```

这个类故意写得很死板：构造时就校验参数，省得线上跑到一半才发现预留比窗口还大。`inputBudget()` 是唯一出口，所有判断都走它，避免不同地方各算一套。

### 3.4 第三步：会做预算的 ChatMemory

这是核心。它实现 LangChain4j 的 `ChatMemory` 接口，所以能直接塞进 `AiServices` 或者手工调用链里。

```java
package com.example.context;

import dev.langchain4j.data.message.AiMessage;
import dev.langchain4j.data.message.ChatMessage;
import dev.langchain4j.data.message.SystemMessage;
import dev.langchain4j.data.message.UserMessage;
import dev.langchain4j.memory.ChatMemory;
import dev.langchain4j.model.TokenCountEstimator;
import dev.langchain4j.model.chat.ChatModel;
import dev.langchain4j.model.chat.request.ChatRequest;
import dev.langchain4j.model.chat.response.ChatResponse;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;

public class BudgetedChatMemory implements ChatMemory {

    private final Object id;
    private final SystemMessage systemMessage;
    private final ContextBudget budget;
    private final TokenMeter meter;
    private final ChatModel summarizer;
    private final int keepRecentMessages;

    private final Deque<ChatMessage> recent = new ArrayDeque<>();
    private String rollingSummary = "";

    public BudgetedChatMemory(Object id,
                              String systemPrompt,
                              ContextBudget budget,
                              TokenCountEstimator estimator,
                              ChatModel summarizer,
                              int keepRecentMessages) {
        this.id = id;
        this.systemMessage = SystemMessage.from(systemPrompt);
        this.budget = budget;
        this.meter = new TokenMeter(estimator);
        this.summarizer = summarizer;
        this.keepRecentMessages = keepRecentMessages;
    }

    @Override
    public Object id() {
        return id;
    }

    @Override
    public void add(ChatMessage message) {
        recent.addLast(message);
        trimToBudget();
    }

    @Override
    public List<ChatMessage> messages() {
        List<ChatMessage> payload = new ArrayList<>();
        payload.add(systemMessage);
        if (!rollingSummary.isBlank()) {
            payload.add(SystemMessage.from("更早对话的事实摘要，与后文冲突时以摘要为准：\n" + rollingSummary));
        }
        payload.addAll(dropOrphanToolMessages(recent));
        return payload;
    }

    @Override
    public void clear() {
        recent.clear();
        rollingSummary = "";
    }

    public String summaryText() {
        return rollingSummary;
    }

    public int currentInputTokens() {
        return meter.count(messages());
    }

    private void trimToBudget() {
        while (!budget.fits(meter.count(messages())) && recent.size() > keepRecentMessages) {
            List<ChatMessage> evictedTurn = takeOldestTurn();
            if (evictedTurn.isEmpty()) {
                break;
            }
            rollingSummary = mergeSummary(evictedTurn);
        }
    }

    private List<ChatMessage> takeOldestTurn() {
        List<ChatMessage> turn = new ArrayList<>();
        while (!recent.isEmpty() && !(recent.peekFirst() instanceof UserMessage)) {
            turn.add(recent.pollFirst());
        }
        if (!recent.isEmpty()) {
            turn.add(recent.pollFirst());
            while (!recent.isEmpty() && !(recent.peekFirst() instanceof UserMessage)) {
                turn.add(recent.pollFirst());
            }
        }
        return turn;
    }

    private List<ChatMessage> dropOrphanToolMessages(Deque<ChatMessage> source) {
        List<ChatMessage> copy = new ArrayList<>(source);
        int start = 0;
        while (start < copy.size() && !(copy.get(start) instanceof UserMessage)) {
            start++;
        }
        return new ArrayList<>(copy.subList(start, copy.size()));
    }

    private String mergeSummary(List<ChatMessage> evicted) {
        if (summarizer == null) {
            return rollingSummary;
        }
        StringBuilder prompt = new StringBuilder();
        if (!rollingSummary.isBlank()) {
            prompt.append("已有摘要：\n").append(rollingSummary).append("\n\n");
        }
        prompt.append("新增对话：\n");
        for (ChatMessage message : evicted) {
            String text = TokenMeter.textOf(message);
            if (!text.isBlank()) {
                prompt.append(messageName(message)).append("：").append(text).append('\n');
            }
        }
        prompt.append("""
                把以上内容压成不超过 200 字的事实摘要。
                只保留四类信息：用户身份或目标、已经确认的结论、尚未解决的问题、用户明确提出的限制条件。
                删掉寒暄、客套和重复表述。没出现过的信息一个字都不要补。
                直接输出摘要正文，不要加标题。
                """);

        ChatResponse response = summarizer.chat(ChatRequest.builder()
                .messages(List.of(UserMessage.from(prompt.toString())))
                .build());
        String summary = response.aiMessage().text();
        return summary == null ? rollingSummary : summary.trim();
    }

    private String messageName(ChatMessage message) {
        if (message instanceof UserMessage) {
            return "用户";
        }
        if (message instanceof AiMessage) {
            return "助手";
        }
        return "工具";
    }
}
```

几处设计说明：

**系统提示词不进 `recent`。** 它是固定开销，每轮都原样加在最前面，永远不会被逐出。这解决"截断截掉人格设定"的经典事故。

**逐出单位是一整轮。** `takeOldestTurn` 从队头一路拿到下一条用户消息之前，用户消息、助手回复、工具调用、工具结果整组走。这样协议要求的配对关系不会被破坏。

**`dropOrphanToolMessages` 是第二道保险。** 万一外部代码直接改过消息列表，或者从数据库恢复的会话本身就不完整，这里会把开头那些没有主语的工具消息丢掉，避免发出去就 400。

**摘要失败不影响主流程。** `summarizer` 传 null 就退化成纯丢弃，摘要调用抛异常时也应该 catch 掉走降级——生产代码记得补 try-catch，这里为了篇幅没加。

### 3.5 第四步：跑起来看预算怎么变

```java
package com.example.context;

import dev.langchain4j.data.message.ChatMessage;
import dev.langchain4j.data.message.UserMessage;
import dev.langchain4j.model.TokenCountEstimator;
import dev.langchain4j.model.chat.ChatModel;
import dev.langchain4j.model.chat.request.ChatRequest;
import dev.langchain4j.model.chat.response.ChatResponse;
import dev.langchain4j.model.openai.OpenAiChatModel;
import dev.langchain4j.model.openai.OpenAiTokenCountEstimator;

import java.util.List;

public class ContextBudgetDemo {

    public static void main(String[] args) {
        String apiKey = System.getenv("OPENAI_API_KEY");
        if (apiKey == null || apiKey.isBlank()) {
            throw new IllegalStateException("先设置环境变量 OPENAI_API_KEY");
        }

        ChatModel model = OpenAiChatModel.builder()
                .apiKey(apiKey)
                .modelName("gpt-4o-mini")
                .temperature(0.3)
                .build();

        TokenCountEstimator estimator = new OpenAiTokenCountEstimator("gpt-4o-mini");

        ContextBudget budget = new ContextBudget(2_000, 600, 100);

        BudgetedChatMemory memory = new BudgetedChatMemory(
                "session-1",
                "你是电商客服，只处理订单、退换货、物流问题。回答控制在 100 字以内，不要编造订单信息。",
                budget,
                estimator,
                model,
                6);

        String[] questions = {
                "我买的耳机还没到，订单号 A10086。",
                "地址是杭州市西湖区文三路 100 号，收件人张先生。",
                "下单时用了满 300 减 50 的券。",
                "现在显示已发货，但三天没更新了。",
                "能不能改成顺丰？",
                "我这单是不是有运费险？",
                "如果退货，运费谁承担？",
                "耳机拆封了还能退吗？",
                "那换货呢，流程一样吗？",
                "我上次说的地址是哪个来着？",
                "帮我再确认一次订单号。",
                "顺便问下会员积分怎么算。"
        };

        int round = 1;
        for (String question : questions) {
            memory.add(UserMessage.from(question));

            List<ChatMessage> payload = memory.messages();
            int localTokens = estimator.estimateTokenCountInMessages(payload);

            ChatResponse response = model.chat(ChatRequest.builder()
                    .messages(payload)
                    .build());
            memory.add(response.aiMessage());

            Integer billed = response.tokenUsage() == null
                    ? null
                    : response.tokenUsage().inputTokenCount();

            System.out.printf("第 %2d 轮 | 本地估算 %5d | 服务端计费 %5s | 消息数 %2d | 预算上限 %5d | 摘要 %d 字%n",
                    round++,
                    localTokens,
                    billed == null ? "-" : billed.toString(),
                    payload.size(),
                    budget.inputBudget(),
                    memory.summaryText().length());
        }

        System.out.println("\n最终摘要：\n" + memory.summaryText());
    }
}
```

为了让你肉眼看见逐出行为，这里把窗口故意设成 2000，输出预留 600，安全余量 100，输入预算 1300。真实场景换成模型的真实窗口就行，代码一行不用改。

跑起来会看到：前几轮消息数一直涨，本地估算逼近 1300 之后突然回落，消息数稳定在一个区间，摘要字数从 0 变成几百。`本地估算` 和 `服务端计费` 两列会对得上，差个位数属于正常结构开销误差，差出 20% 以上说明分词器选错了——用 A 模型的分词器算 B 模型的账就是这结果。

跑完拿最后一轮问"我上次说的地址是哪个"，如果摘要写得好，模型能答出来；如果摘要里全是"用户询问了物流问题"这种废话，说明摘要提示词没约束住。这就是下一节要讲的坑。

## 四、踩坑经验和最佳实践

**用字符数估 token，中文场景全线崩。** `length() / 4` 这套西方经验在中文上低估 40%。更坑的是它"看起来对"——短对话误差小，跑到二十轮才爆。用目标模型的分词器，别省这一步。

**忘了给输出留额度。** 输入预算算得满满的，模型刚开口就被 `finish_reason=length` 掐断。表现是回复半句话、JSON 少个右括号。输出预留至少给 500，代码生成场景给足 4000。

**把工具定义算漏了。** 十个工具、每个 Schema 三百 token，光工具定义就三千。这类开销只有第一次请求时在日志里看得见，后面就被忽略了。预算里必须显式扣掉，而且工具多了要想别的办法——按需检索工具比全量塞进去省得多。

**工具返回的大 JSON 直接喂模型。** 一次订单查询返回 8000 token，等于把整个预算吃光。在喂进上下文之前先裁：只留业务需要的字段，列表超过 20 条就分页，长文本字段截断到 200 字并且明确标注"已截断"。这一步比任何上下文算法都省钱。

**摘要越压越飘。** 链式压缩五六轮之后，摘要里会冒出用户从没说过的话——模型在"补全"它以为合理的细节。对策有三条：摘要提示词里明确写"没出现过的信息一个字都不要补"；给摘要设字数硬上限（200 到 300 字）；每隔几轮用最近原文重算一次，而不是无限链式合并。真出了事故，摘要要能追溯，所以原始消息该落库还得落库，别只存摘要。

**多模态图片按 token 计费，而且很贵。** 一张高清图折合几百到一千多 token，一次带三张图，预算瞬间见底。图片进上下文之前先降分辨率，历史里的图片能换成文字描述就换掉。

**逐出参数别拍脑袋。** `keepRecentMessages` 到底留 6 条还是 10 条，取决于单条消息平均长度，不是拍出来的。做法是跑一段时间日志，看 P95 会话的轮数和 token 分布，再定。留太少会反复追问，留太多摘要永远不触发，等于白做。

## 五、性能对比和技术选型

算一笔账，不算实测，你自己按业务量代入。假设客服会话平均 15 轮，每轮问答 300 token，系统提示词 800，工具定义 1200，检索片段 2000，输出 500。

不做预算管理，15 轮下来输入大约 800 + 1200 + 4500 + 2000 = 8500 token，输出 500，合计 9000。8k 窗口的模型直接拒收，32k 窗口能跑但每轮都要付 8500 输入的钱。

做预算管理，把输入压到 6000 以内：摘要那部分是每 5 轮触发一次，每次输入约 1500 token、输出 200 token，摊到每轮大约 340 token。看着多花了钱，实际上省下的是"每轮多付 2500 token 历史"的固定成本。会话越长，这笔账越划算。

选型建议很直接：

- 会话少于 8 轮、单条消息短：`MessageWindowChatMemory` 就够，别过度设计。
- 会话 10 到 30 轮、有工具调用：用本文这套预算 + 摘要，收益最明显。
- 会话跨天、要记住几个月前的事：预算打底，再叠一层向量外置记忆，按当前问题召回。
- 有严格合规要求、原始对话不能丢：预算照做，摘要当缓存用，原文必须落库。

窗口 128k 的模型也建议做这套，因为窗口大不代表便宜。按输入 token 计费的模型，历史每多 1000 token，每次调用都多付一次钱。

## 六、总结

上下文管理的本质是资源分配，不是文本处理。窗口是固定预算，系统提示词、工具定义、历史、检索、输出五方抢，谁抢到算谁的——你不分配，模型厂商的报错信息会替你分配。

落地就四件事：用目标模型的分词器算账，留出输出预留和安全余量，按整轮逐出保证工具消息配对，给旧对话做有约束的摘要。四件事都不难，难的是把它们串成一条默认路径，让业务代码不需要每次都想一遍。

判断做得好不好有个简单标准：会话跑到三十轮，用户问"我前面说的那个条件是什么"，模型能答对；同时每轮的输入 token 不随轮数线性增长。两条都满足，这套东西就算立住了。

文 / 会编程的吕洞宾

## 参考资料

- [LangChain4j 官方文档：Chat and Language Models](https://docs.langchain4j.dev/tutorials/chat-and-language-models)
- [LangChain4j 官方文档：Chat Memory](https://docs.langchain4j.dev/tutorials/chat-memory)
- [LangChain4j GitHub Releases](https://github.com/langchain4j/langchain4j/releases)
- [JTokkit 项目主页](https://github.com/knuddelsgmbh/jtokkit)
