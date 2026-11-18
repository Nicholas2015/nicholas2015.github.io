---
title: "大模型JSON总解析失败？Java结构化输出实战"
date: 2026-10-26T20:00:00+08:00
category: "AI"
tags: ["AI"]
---

> 客服工单抽取上线一周，日志里全是 JsonParseException。模型有时把 JSON 裹进 Markdown 代码块，有时前面加一句"好的，结果如下"，字段名还能从 orderNo 变成 order_no。加正则、截字符串、改提示词，撑两天又崩。这篇讲清 LangChain4j 的结构化输出：怎么把格式约束落到协议层，怎么补上 schema 管不了的业务校验。代码是完整工程，照抄能跑。

## 一、这个问题到底是什么：大模型返回的 JSON 为什么总崩

**JSON 解析失败不是模型"不听话"，是你只用提示词求它，没在协议层约束它。**

让模型返回 JSON，最常见的坏法有五种：

- 裹代码块：返回一段用三个反引号包起来的 json，Jackson 直接报 "Unexpected character '`'"。
- 加前后缀："好的，我帮您整理如下：" 再跟 JSON。你截 `{` 到 `}`，遇到字符串里的花括号又废了。
- 字段漂移：这次 `orderNo`，下次 `order_no`，再下次 `order_number`。
- 类型漂移：金额本来该是数字，模型给你 `"399 元"`，`BigDecimal` 解析直接炸。
- 枚举自由发挥：你定义 `REFUND`、`LOGISTICS`，它返回 `"退款"`、`"refund_request"`。

很多人第一反应是改提示词：加"必须返回纯 JSON"、加"不要解释"、加 few-shot 示例。短期有效，过两天又出问题。原因不神秘：

1. 提示词是软约束。模型在生成每个 token 时，仍然可以选任何词。
2. 上下文一长，前面的格式要求会被稀释。工单对话动辄几千字，模型更容易"顺手"加一句解释。
3. 不同模型对"JSON"的理解不一样。有的认为代码块也算 JSON，有的会把数字写成字符串。
4. 温度再低也不是零概率。只要有一个 token 走偏，整个响应就废。

还有人把温度调到 0 就以为稳了。温度只影响采样分布，不保证同一输入永远同一输出：服务端批处理、模型版本灰度、上下文长度变化，都会让结果漂。更麻烦的是"半对"的输出——五个字段对了四个，解析成功，错误数据静默入库。全崩至少会报警，半对会安静地污染报表。

手写清洗代码同样不靠谱。正则只能覆盖你见过的坏法；`substring(indexOf("{"), lastIndexOf("}"))` 在字符串值里出现 `}` 时会把 JSON 截断；更糟的是把解析异常吞掉返回 `null`，空指针延后到业务层，排查成本翻倍。

清洗代码还有一笔隐性成本：它把"格式问题"和"业务问题"搅在一起。解析失败你补正则，字段错了你加 `if`，半年后这段代码没人敢动，因为谁也不知道哪行是在兜哪个模型的哪种脾气。结构化输出把这件事收回到类型系统里，坏了就是编译错误或解析异常，边界清楚。

这里要把问题拆成两层：

| 层次 | 具体问题 | 谁能解决 |
| --- | --- | --- |
| 形状 | 是不是合法 JSON、字段名对不对、类型对不对、枚举值合不合法 | JSON Schema |
| 语义 | 金额是退款金额还是订单金额、分类分得对不对、订单号是不是这单的 | 业务校验 |

Schema 能保证 `amount` 是个数字，但保证不了这个数字来自"退款 399 元"而不是"原价 599 元"。Schema 能保证 `category` 在四个枚举里，但保证不了模型没把物流问题分到退款。

一句话收口：**格式交给 schema，事实交给校验，失败交给有限重试。**

## 二、底层原理到底怎么回事：JSON Schema 怎么约束大模型输出

**结构化输出是把 Java 类型编译成 JSON Schema，随请求发给模型，让生成阶段受 schema 约束，再把返回文本反序列化回对象。**

整条链路分三步。

### 第一步：把 Java 类翻译成 Schema

LangChain4j 用反射读你的返回类型，逐字段生成 schema：

- `String` → `"type": "string"`
- `int` / `Integer` → `"type": "integer"`
- `BigDecimal` / `double` → `"type": "number"`
- `enum` → `"type": "string"` 加 `enum` 白名单
- `List<T>` → `"type": "array"` 加 `items`
- 嵌套对象 → `"type": "object"`，递归结构用 `$defs` 和 `$ref` 收口

字段上的 `@Description` 会写进 schema 的 `description`。别小看这一行文字，模型判断"这个字段该填什么"主要靠它。字段上的 `@JsonProperty(required = true)` 会进 `required` 列表。

这套翻译是递归的。`List<TicketItem>` 会生成 array，元素对象继续展开；自引用类型不会无限递归，LangChain4j 检测到循环后改用 `$ref` 指向 `$defs`。所以 DTO 里放树形结构也能生成合法 schema，只是嵌套越深，模型填错的概率越高。

一个工单类生成的 schema 大致长这样：

```json
{
  "type": "object",
  "properties": {
    "orderNo": {
      "type": "string",
      "description": "订单号，格式为 ORD- 加 8 位数字"
    },
    "category": {
      "type": "string",
      "enum": ["REFUND", "LOGISTICS", "INVOICE", "OTHER"]
    },
    "amount": {
      "type": "number",
      "description": "涉及金额，单位元；对话里没提金额就填 0"
    }
  },
  "required": []
}
```

注意这里的 `required` 是空的。只有标了 `@JsonProperty(required = true)` 的字段才会进去。strict 模式在发给 OpenAI 之前会再做一次改写：把所有键塞进 `required`，同时把没标必填的字段类型改成可空形式，比如 `["string", "null"]`、`["number", "null"]`。所以 strict 下的"必填"只保证键存在，不保证值非空。后面会细说这个坑。

### 第二步：把 Schema 塞进请求

请求里用 `ResponseFormat` 带上 schema：

```java
ResponseFormat.builder()
        .type(ResponseFormatType.JSON)
        .jsonSchema(schema)
        .build();
```

OpenAI 适配层会把它翻译成 `response_format: {"type": "json_schema", ...}`。

如果开了 `strict`，服务端会在解码阶段做约束：每生成一个 token，把不符合 schema 的候选直接屏蔽掉。模型不是"尽量写对"，是"写不出错"。这跟提示词求它，是两码事。

不同厂商的能力差别很大：

- OpenAI 的 Structured Outputs 支持 JSON Schema 的常用子集，strict 模式下强约束。
- vLLM 一类推理框架用 guided decoding，也能按 schema 屏蔽 token。
- 不少 OpenAI 兼容服务只支持 `json_object`。它只保证"整体是合法 JSON"，字段名、类型、枚举全都不管。
- 还有服务直接忽略 `response_format`，你传什么它都当没看见。

`json_object` 和 `json_schema` 经常被混为一谈。前者只保证语法，后者连字段名和类型一起管。举个具体的：你让它抽 `{"amount": 399}`，json_object 模式可能返回 `{"退款金额": "399元"}`，语法完全合法，你的 DTO 一样接不住。schema 模式则连 `amount` 这个键名都不允许改。

LangChain4j 用能力位判断走哪条路。模型的 `supportedCapabilities()` 里包含 `RESPONSE_FORMAT_JSON_SCHEMA`，才走原生 schema；否则它会把格式说明追加到用户消息里。兜底模式不是完全没用，它会把 schema 和字段说明一起贴进用户消息，模型看到的结构是准的，多数时候也能对。区别在于"多数时候"和"必须"。

这里有个很隐蔽的坑：**`OpenAiChatModel` 默认不声明这个能力。** 你得显式声明 `.supportedCapabilities(RESPONSE_FORMAT_JSON_SCHEMA)`，它才会把能力位打开。少了这一行，`AiServices` 照样能把结果转成对象，但底层走的是"在 prompt 里贴一段格式要求"，稳定性立刻回落。很多人说"我用了 AiServices 怎么还是崩"，答案往往就在这。

### 第三步：把返回文本变回对象

`AiServices` 拿到响应后，交给 `PojoOutputParser`。解析器不是上来就 `readValue`，它先试整个字符串；失败后从后往前找最后一个 `}` 或 `]`，再向前配对花括号，配对时跳过字符串内部的括号。所以代码块、前后废话，它都能救回来。

这层宽容是兜底，不是设计目标。字段名不对、类型不对，它一样救不了，直接抛 `OutputParsingException`。

还有一种情况它也无能为力：响应被 max_tokens 截断。JSON 少一个右括号，花括号配对失败，直接抛异常。这类失败看 `finishReason` 就能提前判断，别等 Jackson 报错。把 max_tokens 设得比正常输出大一圈，是便宜又有效的办法。

### Schema 管不到的三个地方

**语义。** schema 管的是形状。金额归属、分类对错、订单号是不是这单的，它一律不管。

**未知值。** OpenAI 适配层的 strict 会把所有属性塞进 `required`，同时把没标必填的字段类型改成可空形式。键必须出现，值可以是 `null`。模型遇到"对话里没提金额"，更可能给你 `null`，而不是编一个数。所以 DTO 里要用包装类型接。用 `int` 的话，Jackson 会把 `null` 悄悄变成 0，校验看到的是一份假数据；业务上不接受空值，就在校验里判，或者给枚举加 `UNKNOWN`、给金额约定 0。

**跨字段规则。** "退款金额不能大于订单金额"这种约束，JSON Schema 有条件表达式能写，但模型厂商支持程度参差不齐。别把业务规则寄托在 schema 上，老老实实写 Java 校验。

## 三、实战：手把手写 LangChain4j 结构化输出代码

**能跑的最小工程由四部分组成：依赖、DTO、AI Service 接口、校验重试。下面三个例子从简到全，每个都是完整类。**

### 依赖

```xml
<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
    <modelVersion>4.0.0</modelVersion>

    <groupId>com.example</groupId>
    <artifactId>structured-output-demo</artifactId>
    <version>1.0.0</version>

    <properties>
        <maven.compiler.release>21</maven.compiler.release>
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
            <artifactId>langchain4j-open-ai</artifactId>
            <version>1.22.0</version>
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

    <build>
        <plugins>
            <plugin>
                <groupId>org.apache.maven.plugins</groupId>
                <artifactId>maven-compiler-plugin</artifactId>
                <version>3.16.0</version>
            </plugin>
        </plugins>
    </build>
</project>
```

### 例子一：AiServices 自动生成 Schema

这是最省事的写法。定义一个接口，返回类型写成 DTO，LangChain4j 负责生成 schema、发请求、解析结果。

```java
package com.example.structured;

import dev.langchain4j.model.chat.ChatModel;
import dev.langchain4j.model.openai.OpenAiChatModel;
import dev.langchain4j.model.output.structured.Description;
import dev.langchain4j.service.AiServices;
import dev.langchain4j.service.UserMessage;

import java.math.BigDecimal;

import static dev.langchain4j.model.chat.Capability.RESPONSE_FORMAT_JSON_SCHEMA;

public class TicketExtractionDemo {

    public enum Category {
        REFUND, LOGISTICS, INVOICE, OTHER
    }

    public static class Ticket {
        @Description("订单号，格式为 ORD- 加 8 位数字")
        public String orderNo;

        @Description("问题分类：REFUND 退款、LOGISTICS 物流、INVOICE 发票、OTHER 其他")
        public Category category;

        @Description("涉及金额，单位元；对话里没提金额就填 0")
        public BigDecimal amount;

        @Description("优先级，1 最低，5 最高；催得急或涉及投诉填 4 以上")
        public Integer priority;

        @Description("用户诉求摘要，不超过 30 个字")
        public String summary;
    }

    public interface TicketAssistant {
        @UserMessage("""
                从下面的客服对话中抽取工单信息。
                只抽对话里明确出现的内容，不要推测。

                对话：
                {{it}}
                """)
        Ticket extract(String dialogue);
    }

    public static void main(String[] args) {
        ChatModel model = OpenAiChatModel.builder()
                .apiKey(System.getenv("OPENAI_API_KEY"))
                .modelName("gpt-4.1-mini")
                // 这两行决定走原生 JSON Schema，而不是在 prompt 里贴格式说明
                .supportedCapabilities(RESPONSE_FORMAT_JSON_SCHEMA)
                .strictJsonSchema(true)
                .temperature(0.0)
                .build();

        System.out.println("模型能力: " + model.supportedCapabilities());

        TicketAssistant assistant = AiServices.builder(TicketAssistant.class)
                .chatModel(model)
                .build();

        Ticket ticket = assistant.extract("""
                用户：我上周买的耳机，订单 ORD-20261012，到现在还没发货。
                客服：我帮您查一下物流。
                用户：不用查了，直接退款，399 元，太慢了。
                """);

        System.out.println("订单号: " + ticket.orderNo);
        System.out.println("分类: " + ticket.category);
        System.out.println("金额: " + ticket.amount);
        System.out.println("优先级: " + ticket.priority);
        System.out.println("摘要: " + ticket.summary);
    }
}
```

关键行为拆开说：

- `@UserMessage` 里的 `{{it}}` 是占位符，对应方法唯一的参数。不用手拼字符串。
- 返回类型是 `Ticket`，不是 `String`。这一个签名就让 LangChain4j 知道要生成 schema 并反序列化。
- `@Description` 不是注释，它会进 schema。字段名越抽象，描述越要写清楚，比如 `priority` 不写"1 到 5"，模型就敢给你 10。
- `temperature(0.0)` 降低随机性，但别指望它替代 schema。
- `System.out.println(model.supportedCapabilities())` 是排障用的。输出里没有 `RESPONSE_FORMAT_JSON_SCHEMA`，说明你在走 prompt 兜底模式。

### 例子二：手写 Schema，不经过接口代理

有些场景不适合用 `AiServices`：schema 是运行时拼的、要复用一个 `ChatModel`、或者你想看清请求到底发了什么。这时候直接构造 `ChatRequest`。

```java
package com.example.structured;

import dev.langchain4j.data.message.SystemMessage;
import dev.langchain4j.data.message.UserMessage;
import dev.langchain4j.model.chat.ChatModel;
import dev.langchain4j.model.chat.request.ChatRequest;
import dev.langchain4j.model.chat.request.ResponseFormat;
import dev.langchain4j.model.chat.request.ResponseFormatType;
import dev.langchain4j.model.chat.request.json.JsonObjectSchema;
import dev.langchain4j.model.chat.request.json.JsonSchema;
import dev.langchain4j.model.chat.response.ChatResponse;
import dev.langchain4j.model.openai.OpenAiChatModel;

import java.util.List;

import static dev.langchain4j.model.chat.Capability.RESPONSE_FORMAT_JSON_SCHEMA;

public class RawSchemaDemo {

    public static void main(String[] args) {
        ChatModel model = OpenAiChatModel.builder()
                .apiKey(System.getenv("OPENAI_API_KEY"))
                .modelName("gpt-4.1-mini")
                .supportedCapabilities(RESPONSE_FORMAT_JSON_SCHEMA)
                .strictJsonSchema(true)
                .temperature(0.0)
                .build();

        JsonSchema schema = JsonSchema.builder()
                .name("Ticket")
                .rootElement(JsonObjectSchema.builder()
                        .addStringProperty("orderNo", "订单号，格式为 ORD- 加 8 位数字")
                        .addEnumProperty("category", List.of("REFUND", "LOGISTICS", "INVOICE", "OTHER"))
                        .addNumberProperty("amount", "涉及金额，单位元，没有就填 0")
                        .addIntegerProperty("priority", "优先级，1 到 5")
                        .addStringProperty("summary", "用户诉求摘要，不超过 30 个字")
                        .required("orderNo", "category", "amount", "priority", "summary")
                        .additionalProperties(false)
                        .build())
                .build();

        ChatRequest request = ChatRequest.builder()
                .messages(
                        SystemMessage.from("你是客服工单抽取器，只输出 JSON。"),
                        UserMessage.from("订单 ORD-20261012 一直没发货，我要退款 399 元。"))
                .responseFormat(ResponseFormat.builder()
                        .type(ResponseFormatType.JSON)
                        .jsonSchema(schema)
                        .build())
                .build();

        ChatResponse response = model.chat(request);
        System.out.println(response.aiMessage().text());
    }
}
```

`JsonObjectSchema.builder()` 提供了一串快捷方法，`addStringProperty`、`addEnumProperty`、`addNumberProperty` 都是"名字 + 描述"两个参数。`required` 明确哪些字段必须出现，`additionalProperties(false)` 禁止模型加戏。

手写 schema 的好处是可控：字段名、枚举值、描述、必填项都在你手里。坏处是容易和 DTO 脱节。改了一边忘了另一边，解析照样崩。我的建议是：接口代理能覆盖的场景，优先用例子一；只有 schema 需要动态生成时，才手写。

### 例子三：业务校验 + 有限重试

前两个例子解决形状，这个解决语义。核心思路：解析成功后不急着返回，先跑一遍规则；有问题就把"哪条规则没过"喂回模型，让它重写；最多重试两次。

```java
package com.example.structured;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.langchain4j.data.message.SystemMessage;
import dev.langchain4j.data.message.UserMessage;
import dev.langchain4j.model.chat.ChatModel;
import dev.langchain4j.model.chat.request.ChatRequest;
import dev.langchain4j.model.chat.request.ResponseFormat;
import dev.langchain4j.model.chat.request.ResponseFormatType;
import dev.langchain4j.model.chat.response.ChatResponse;
import dev.langchain4j.model.openai.OpenAiChatModel;
import dev.langchain4j.model.output.structured.Description;
import dev.langchain4j.service.output.JsonSchemas;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;

import static dev.langchain4j.model.chat.Capability.RESPONSE_FORMAT_JSON_SCHEMA;

public class ValidatedExtractor {

    private static final Pattern ORDER_NO = Pattern.compile("^ORD-\\d{8}$");
    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final int MAX_ATTEMPTS = 3;

    private final ChatModel model;

    public ValidatedExtractor(ChatModel model) {
        this.model = model;
    }

    public static class Ticket {
        @Description("订单号，格式为 ORD- 加 8 位数字")
        public String orderNo;

        @Description("问题分类：REFUND 退款、LOGISTICS 物流、INVOICE 发票、OTHER 其他")
        public String category;

        @Description("退款或涉及金额，单位元；没有就填 0")
        public BigDecimal amount;

        @Description("优先级，1 最低，5 最高")
        public Integer priority;

        @Description("用户诉求摘要，不超过 30 个字")
        public String summary;
    }

    public Ticket extract(String text) {
        ResponseFormat format = ResponseFormat.builder()
                .type(ResponseFormatType.JSON)
                .jsonSchema(JsonSchemas.jsonSchemaFrom(Ticket.class).orElseThrow())
                .build();

        List<String> problems = List.of();

        for (int attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            String userText = text;
            if (!problems.isEmpty()) {
                userText = text
                        + "\n\n上一次输出有以下问题，请逐条修正后重新输出：\n- "
                        + String.join("\n- ", problems);
            }

            ChatRequest request = ChatRequest.builder()
                    .messages(
                            SystemMessage.from("只做信息抽取。不确定的字段按默认值填，不要编造。"),
                            UserMessage.from(userText))
                    .responseFormat(format)
                    .temperature(0.0)
                    .build();

            ChatResponse response = model.chat(request);
            String raw = response.aiMessage().text();

            try {
                Ticket ticket = MAPPER.readValue(raw, Ticket.class);
                problems = validate(ticket);
                if (problems.isEmpty()) {
                    return ticket;
                }
                System.out.println("第 " + attempt + " 次校验失败: " + problems);
            } catch (Exception e) {
                problems = List.of("输出不是合法 JSON：" + e.getMessage());
                System.out.println("第 " + attempt + " 次解析失败，原始输出：" + raw);
            }
        }

        throw new IllegalStateException(
                "连续 " + MAX_ATTEMPTS + " 次没有拿到合格结果，最后的问题：" + problems);
    }

    private List<String> validate(Ticket t) {
        List<String> problems = new ArrayList<>();

        if (t.orderNo == null || !ORDER_NO.matcher(t.orderNo).matches()) {
            problems.add("orderNo 必须是 ORD- 加 8 位数字，当前是 " + t.orderNo);
        }
        if (t.category == null
                || !List.of("REFUND", "LOGISTICS", "INVOICE", "OTHER").contains(t.category)) {
            problems.add("category 只能是 REFUND、LOGISTICS、INVOICE、OTHER");
        }
        if (t.amount == null
                || t.amount.signum() < 0
                || t.amount.compareTo(new BigDecimal("100000")) > 0) {
            problems.add("amount 必须在 0 到 100000 之间");
        }
        if (t.priority == null || t.priority < 1 || t.priority > 5) {
            problems.add("priority 必须在 1 到 5 之间");
        }
        return problems;
    }

    public static void main(String[] args) throws Exception {
        ChatModel model = OpenAiChatModel.builder()
                .apiKey(System.getenv("OPENAI_API_KEY"))
                .modelName("gpt-4.1-mini")
                .supportedCapabilities(RESPONSE_FORMAT_JSON_SCHEMA)
                .strictJsonSchema(true)
                .temperature(0.0)
                .build();

        ValidatedExtractor extractor = new ValidatedExtractor(model);
        Ticket ticket = extractor.extract(
                "订单 ORD-20261012 一直没发货，我要退款 399 元。");

        System.out.println(MAPPER.writerWithDefaultPrettyPrinter().writeValueAsString(ticket));
    }
}
```

这段代码有几个设计点值得说明。

**schema 只声明形状，校验规则写在 Java 里。** `Ticket` 的 `category` 故意用 `String` 而不是枚举。原生 schema 模式下它是枚举白名单；第三方兼容服务忽略 schema 时，它就是自由字符串。校验兜住两种情况。

**把失败原因回灌。** 只说"重新生成"没用，模型不知道错在哪。告诉它"orderNo 必须是 ORD- 加 8 位数字，当前是 20261012"，第二次基本能改对。这是重试有效和无效的分水岭。

**重试封顶。** 三次还不行，说明输入本身有问题，继续烧 token 没有意义。直接抛异常，交给人工或死信队列。

**原始输出必须打日志。** 解析失败时 `raw` 是唯一线索。线上把这段日志接到告警，比事后猜模型为什么抽风有用得多。

**重试一次就是一次完整调用。** 每次重试都要重发 system prompt、用户原文和 schema，成本是实打实的。所以校验规则要一次列全，别一条一条挤牙膏。

## 四、踩坑经验和最佳实践：结构化输出最容易翻车的 8 个地方

**结构化输出的坑，八成不在 schema 语法，而在"以为配了就生效"。**

1. **只写"请返回 JSON"。** 这不算约束。要么用 `ResponseFormat` + `JsonSchema`，要么接受它随时给你加代码块。

2. **以为 `AiServices` 一定走原生 schema。** 模型不声明 `RESPONSE_FORMAT_JSON_SCHEMA`，框架会退回 prompt 模式。OpenAI 模型记得加 `.supportedCapabilities(RESPONSE_FORMAT_JSON_SCHEMA)`，上线前打印一次 `supportedCapabilities()` 确认。

3. **strict 模式下还想要可选字段。** OpenAI 的 strict 会把所有属性塞进 `required`，没标必填的字段则允许 `null`。键一定在，值可能是空。Java 端用包装类型（`Integer`、`BigDecimal`）接。用 `int` 的话，Jackson 会把 `null` 悄悄转成 0，校验拿到的是假数据，比报错还难查。实在不想要空值，就给枚举加 `UNKNOWN`、给金额约定 0，再在校验里兜住。

4. **金额用 `double`。** 浮点误差在金额上是事故。DTO 里用 `BigDecimal`，schema 里是 `number`，Jackson 能正确转。

5. **日期字段直接用 `LocalDate`。** 生成 schema 时，`LocalDate` 不会被当成 `string`，而是被翻译成一个没有字段的对象，模型只能瞎填；解析端的 ObjectMapper 也不保证注册了 JavaTimeModule。DTO 里用 `String` 接，业务层再转 `LocalDate`。多写两行，省一下午排查。

6. **prompt 和 schema 各说一套。** prompt 里又贴一遍字段结构，模型可能按 prompt 的旧版本输出。prompt 只讲业务口径（什么算退款、优先级怎么判），结构交给 schema。

7. **DTO 又宽又深。** 二十个字段、三层嵌套，schema 本身就占几百 token，模型还容易漏填。拆成两次抽取：先抽订单号和分类，再按需抽明细。准确率和成本都更好。

8. **重试不封顶、不幂等。** 校验失败就无限重试，遇上一直不合格的输入，账单能翻十倍。上限两到三次，记录每次的 raw 和问题列表，写库前做幂等。

再补几个不那么常见但会致命的：

- **字段名起得太随意。** `a`、`b`、`tmp` 这种名字，模型只能靠猜。用 `orderNo`、`refundAmount` 这种自带语义的英文名，再配 `@Description` 补细节。
- **忘了 `additionalProperties(false)`。** 模型可以往对象里加任意字段，这些字段进不了 DTO，白占输出 token，也说明它没严格按你的结构走。手写 schema 时把它关上。
- **流式输出配 POJO 返回值。** `AiServices` 的流式方法返回 `TokenStream`，不能直接返回 DTO。要结构化结果就别开流式，或者流式收完再自己解析。
- **第三方兼容服务静默忽略 `response_format`。** 它不报错，照样返回一段散文。所以校验和解析兜底不是可选项，是必选项。

上线后盯三个数：解析成功率、校验失败率、平均重试次数。解析成功率低，先查模型能力位和 max_tokens；校验失败率高，说明 prompt 的业务口径没写清；重试次数涨，通常是模型版本变了或输入分布变了。这三个数比"感觉最近不太准"有用得多。

## 五、性能对比和技术选型：JSON mode、JSON Schema 还是 Function Calling

**生产环境的抽取任务，优先 JSON Schema；要让模型自己决定"要不要调工具"，才用 Function Calling。**

| 方案 | 能保证什么 | 额外开销 | 适合场景 |
| --- | --- | --- | --- |
| 纯文本 + 自己解析 | 什么都不保证 | 无 | 一次性脚本、玩具 demo |
| JSON mode | 整体是合法 JSON | 很小 | 老模型、只支持 json_object 的兼容服务 |
| JSON Schema | 字段名、类型、枚举、必填项 | schema 占输入 token，解码略慢 | 生产抽取，首选 |
| Function Calling | 工具参数结构，且由模型决定调不调 | 工具定义占 token | Agent、需要模型自主选择动作 |

延迟的大头永远是输出 token 和网络往返。约束解码带来的增量，在工单抽取这种几百 token 的输出上很难感知。真正让成本失控的是重试：一次失败重试就是双倍 token、双倍延迟。所以 schema 要一次写准，校验规则要一次列全。

schema 不是免费的。每次请求都会带上它，字段越多、嵌套越深，输入 token 越高。控制在一个 DTO 十个字段以内、嵌套不超过两层，是比较舒服的区间。超过这个量级，考虑拆调用，而不是硬塞。

选型的判断很简单：

- 内部系统做信息抽取、分类、打分：JSON Schema + Java 校验，别犹豫。
- 接第三方 OpenAI 兼容服务：先探测它认不认 `response_format`，不认就降级到 JSON mode，校验逻辑一行都不能少。
- 模型需要根据用户意图决定调哪个工具：Function Calling。它的本质也是结构化输出，只是结构化的是"动作"。
- 只是想让日志好看点：别折腾，正则提取关键字段够了。

## 六、总结

结构化输出这件事，拆开就三句话：

**形状交给 schema。** 用 `ResponseFormat` 带 `JsonSchema`，让约束落到协议层；`AiServices` 返回 POJO 能自动生成 schema，但要确认模型真的声明了能力。

**事实交给校验。** schema 保证 `amount` 是数字，保证不了它是退款金额。订单号格式、金额范围、枚举白名单、跨字段关系，全部用 Java 写死。

**失败交给有限重试。** 把具体哪条规则没过喂回模型，最多两三次，原始输出留日志。超过次数就认输，别拿 token 赌气。

落地清单就六条：DTO 收窄、schema 打开、strict 想清楚、校验必写、重试封顶、raw 日志留全。

什么场景别用结构化输出？开放式的文案生成、长文总结、头脑风暴。这些任务没有稳定字段，硬套 schema 只会把模型的手脚捆住，输出变得干瘪。结构化输出适合"信息搬运"，不适合"内容创作"。

再留一句给要上线的人：拿二十条真实工单做回归集，每次换模型、改 prompt、动 schema 都跑一遍。模型不是编译器，升级不会告诉你哪里不兼容。

模型负责写字，代码负责判卷。判卷规则写不清楚，换再大的模型也没用。

## 参考资料

- [LangChain4j 官方文档：Structured Outputs](https://docs.langchain4j.dev/tutorials/structured-outputs)
- [LangChain4j 官方文档：AI Services](https://docs.langchain4j.dev/tutorials/ai-services)
- [JSON Schema 官方指南：Understanding JSON Schema](https://json-schema.org/understanding-json-schema/)
- [Maven Central：dev.langchain4j:langchain4j](https://central.sonatype.com/artifact/dev.langchain4j/langchain4j)

文 / 会编程的吕洞宾
