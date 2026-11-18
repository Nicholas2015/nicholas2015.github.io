---
title: "Spring AI 结构化输出解析失败？三招兜住"
date: 2026-11-08T20:00:00+08:00
category: "AI"
tags: ["AI", "spring-ai"]
---

**摘要：** 用 Spring AI 的 `.entity()` 拿对象，模型一加解释文字就抛 `Unrecognized token`。本文讲清它背后生成 Schema、拼提示词、反序列化这三步，再给出三层兜底：自纠重试、provider 原生约束、自定义转换器，附完整可运行代码。

> 上周做发票识别，模型答得好好的，一进代码就炸：`StreamReadException: Unrecognized token 'The'`。原来它在 JSON 前面加了句「The extracted data is as follows:」。就这一句人话，解析器直接罢工。更烦的是十次里错一次，测试环境复现不出来。结构化输出的难点，从来不是让模型吐 JSON，而是它偶尔不听话时你怎么活下来。

## 一、这个问题到底是什么

结论：结构化输出失败，九成不是模型笨，而是「提示词请求」和「代码解析」之间没有兜底环节。

先看 Spring AI 帮你做的那件事。你写：

```java
Invoice invoice = chatClient.prompt()
        .user("把这段发票文字抽成结构化数据：" + rawText)
        .call()
        .entity(Invoice.class);
```

一行 `.entity(Invoice.class)`，背后干了三件事：

1. 拿 `Invoice` 这个类型，生成一份 JSON Schema（描述「我要哪些字段、什么类型」）。
2. 把这份 Schema 塞进提示词，告诉模型「按这个格式回」。
3. 把模型返回的文本，反序列化成 `Invoice` 对象。

问题出在第 2 步和第 3 步之间。第 2 步只是「请求」，不是「强制」。模型完全可能：

- 在 JSON 前面加一句解释，或者后面加一句「如需调整请告诉我」；
- 少给你一个字段，因为原文里确实没提到；
- 把数字写成字符串，`"amount": "1280.00"`；
- 把该是数组的字段，退化成一个对象。

只要出现其中一种，第 3 步就抛异常。而你的业务代码，是在一个 HTTP 请求线程里等这个对象的。

所以真问题不是「怎么让模型永远听话」——这做不到。真问题是：**模型不听话的那一次，代码怎么办。**

三个答案，按成本从低到高：

- 让它自己改：把校验错误回喂给模型，重试；
- 让服务商别给它犯错的机会：把 Schema 提到 API 层强制约束；
- 自己接管解析：模型爱加什么前言都行，我把 JSON 抠出来。

## 二、底层原理到底怎么回事

结论：Spring AI 的结构化输出是「请求侧 + 响应侧」两条独立防线，默认两条都不开，全靠运气。

### Schema 是怎么从 record 变出来的

`BeanOutputConverter` 构造时就会生成 Schema，基于 victools 的 JSON Schema 生成器，输出 DRAFT_2020_12 规范。这一步是纯反射，不花钱、不联网。

有个默认行为很多人不知道：**所有字段默认都是 required**。源码里那个常量叫 `PROPERTY_REQUIRED_BY_DEFAULT = true`。也就是说，模型少给任何一个字段，校验就挂。

想让某个字段可选，得显式标注：`@Nullable`、`@JsonProperty(required = false)`，或者 `@Schema(requiredMode = ...)`。反过来，想给字段加说明（这个特别有用，模型会照着说明理解语义），用 `@JsonPropertyDescription`。

注意这是**双向**的：`required` 既影响提示词里那份 Schema，也影响 `validateSchema()` 的校验规则。你把字段标成可选，校验就真的不管它了。

### 默认的文本清理，只干了一半活

Spring AI 在解析前会先过一条清理链，顺序是：

1. `WhitespaceCleaner` —— 去首尾空白；
2. `ThinkingTagCleaner` —— 剥掉思考标签（Qwen、Nova 这类模型会先输出一段内心独白）；
3. `MarkdownCodeBlockCleaner` —— 剥掉 markdown 代码围栏；
4. `WhitespaceCleaner` —— 再 trim 一次。

看着挺周全，但 `MarkdownCodeBlockCleaner` 的触发条件很苛刻：**整段文本必须以三个反引号开头、以三个反引号结尾**。源码里就这两个判断，多一个字都不行。

所以这两种情况命运完全不同。第一种，整段被围栏包住，能正常解析：

    ```json
    {"invoiceCode": "044031900111"}
    ```

第二种，前面多了句人话，解析器直接死在第一个字母上：

    The extracted data is as follows:
    ```json
    {"invoiceCode": "044031900111"}
    ```

上面第二种，就是开头那个线上事故。清理链救不了你，JSON 解析器读到第一个字符 `T` 就抛 `Unrecognized token 'The'` 了。

### validateSchema() 的自纠循环

打开 `spec -> spec.validateSchema()`，Spring AI 会**自动注册**一个 `StructuredOutputValidationAdvisor`（递归 advisor，你不用手动 wire）。它的循环长这样：

1. 调模型；
2. 拿响应内容去对 Schema 校验（JSON Schema DRAFT_2020_12）；
3. 通过 → 返回对象；
4. 不通过 → 把具体错误拼到用户消息后面，重新发起调用。

有个细节值得说清楚，因为它直接影响你的成本预算：`maxRepeatAttempts` 默认是 3，但源码里的循环是 `1 + maxRepeatAttempts` 次。**也就是首次调用失败后，最多再补 3 次，一共 4 次请求。** 文档里写「up to 3 attempts」，容易让人以为总共 3 次。

还有个更容易踩的点：重试时，Spring AI **只把错误信息追加进去，不把上次那份错误输出带上**。源码注释说得很直白——带上可能让模型更困惑。这意味着模型是在「盲改」，它只知道「缺了 buyerName」，不知道自己上次写成什么样。

所以提示词里那句「只输出 JSON，不要任何解释」不是客套，是在给重试降难度。

### useProviderStructuredOutput() 干了什么

这一招是把 Schema 从「提示词里的文字」升级成「API 请求里的字段」。

开了之后，线的两端都变了：

- system prompt 里不再拼那段 JSON 格式说明，省 token；
- Schema 作为 API 级参数发给服务商，OpenAI 走 Structured Outputs，Anthropic 走 structured output 扩展，Gemini 走 `responseSchema`。

服务商运行时直接保证「不合规的响应压根生成不出来」。

Spring AI 怎么知道某个模型支不支持？它检查这个模型的 chat options 有没有实现 `StructuredOutputChatOptions` 接口。没实现就静默忽略这个开关，退回到提示词方案——**不报错**。这是个隐藏坑：你以为开了强约束，其实啥也没发生。

### 两个开关为什么能叠加

一个管请求侧（别生成错的），一个管响应侧（生成了错的就重来）。互不冲突，自然可以一起开：

```java
.entity(Invoice.class, spec -> spec
        .useProviderStructuredOutput()
        .validateSchema());
```

顺序上，先让服务商把错误率压到极低，再让重试兜住剩下的边角情况（服务商实现不完整、推理模型抽风）。这才是生产配置。

## 三、实战：手把手写代码

### 示例一：最稳的基础写法，一次到位

先建工程骨架。

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
    <artifactId>structured-output-demo</artifactId>
    <version>1.0.0</version>

    <properties>
        <java.version>21</java.version>
    </properties>

    <dependencyManagement>
        <dependencies>
            <dependency>
                <groupId>org.springframework.ai</groupId>
                <artifactId>spring-ai-bom</artifactId>
                <version>2.0.2</version>
                <type>pom</type>
                <scope>import</scope>
            </dependency>
        </dependencies>
    </dependencyManagement>

    <dependencies>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-web</artifactId>
            <version>4.1.2</version>
        </dependency>
        <dependency>
            <groupId>org.springframework.ai</groupId>
            <artifactId>spring-ai-starter-model-openai</artifactId>
            <version>2.0.2</version>
        </dependency>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-test</artifactId>
            <version>4.1.2</version>
            <scope>test</scope>
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

`application.yml`：

```yaml
spring:
  ai:
    openai:
      api-key: ${OPENAI_API_KEY}
      chat:
        options:
          model: gpt-4o
          temperature: 0
```

`temperature: 0` 是我强烈建议的。抽取类任务不需要创意，温度越低，格式越稳。

目标 record，注意 `@JsonPropertyDescription` 的用法：

```java
package com.example.structured.model;

import com.fasterxml.jackson.annotation.JsonPropertyDescription;
import java.math.BigDecimal;

public record Invoice(

        @JsonPropertyDescription("发票代码，纯数字，通常是 10 位或 12 位")
        String invoiceCode,

        @JsonPropertyDescription("价税合计金额，只要数字，单位元，不带货币符号")
        BigDecimal totalAmount,

        @JsonPropertyDescription("开票日期，格式必须为 yyyy-MM-dd")
        String issueDate,

        @JsonPropertyDescription("购买方名称，原文照抄，不要改写")
        String buyerName
) {
}
```

日期我用 `String` 而不是 `LocalDate`，这是刻意的。`LocalDate` 会让 Schema 生成器和 Jackson 的模块配置多一层依赖，而模型输出的日期格式常常是 `2026年3月1日` 这种。用 `String` 收下来，自己在业务层解析，错的时候你能给出明确报错，而不是一个反序列化异常。

然后是装配和调用：

```java
package com.example.structured.config;

import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.model.ChatModel;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class ChatClientConfig {

    @Bean
    public ChatClient chatClient(ChatModel chatModel) {
        return ChatClient.builder(chatModel).build();
    }
}
```

```java
package com.example.structured.service;

import com.example.structured.model.Invoice;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.stereotype.Service;

@Service
public class InvoiceService {

    private static final String SYSTEM_PROMPT = """
            你是发票信息抽取器。
            只输出一个 JSON 对象，不要输出任何解释、前后缀、markdown 代码围栏。
            原文里没有的字段，值写 null，不要编造。
            """;

    private final ChatClient chatClient;

    public InvoiceService(ChatClient chatClient) {
        this.chatClient = chatClient;
    }

    public Invoice extract(String rawText) {
        return this.chatClient.prompt()
                .system(SYSTEM_PROMPT)
                .user(u -> u.text("抽取这张发票的字段：\n{text}").param("text", rawText))
                .call()
                .entity(Invoice.class, spec -> spec
                        .useProviderStructuredOutput()
                        .validateSchema());
    }
}
```

启动类：

```java
package com.example.structured;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class StructuredOutputApplication {

    public static void main(String[] args) {
        SpringApplication.run(StructuredOutputApplication.class, args);
    }
}
```

跑起来测一下：

```java
package com.example.structured;

import com.example.structured.service.InvoiceService;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;

import static org.assertj.core.api.Assertions.assertThat;

@SpringBootTest
class InvoiceServiceTest {

    @Autowired
    private InvoiceService invoiceService;

    @Test
    void shouldExtractInvoice() {
        String raw = "增值税电子普通发票 发票代码:044031900111 "
                + "开票日期:2026年03月01日 价税合计:¥1280.00 购买方:杭州某某科技有限公司";

        var invoice = this.invoiceService.extract(raw);

        assertThat(invoice).isNotNull();
        assertThat(invoice.invoiceCode()).isEqualTo("044031900111");
        assertThat(invoice.totalAmount()).isEqualByComparingTo("1280.00");
    }
}
```

这套写法能挡住大部分问题：native 约束让模型不太可能吐脏数据，`validateSchema()` 把剩下的错自己修掉。

### 示例二：模型爱加前言？自己接管解析

如果换的模型不支持原生结构化输出（或者你接的是自建推理服务），第一招就用不上。这时候得自己写转换器。

核心思路：模型前面爱说啥说啥，我从文本里把**第一个完整的 JSON 对象或数组**抠出来，剩下的交给官方解析器。

```java
package com.example.structured.converter;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

import org.springframework.ai.converter.BeanOutputConverter;
import org.springframework.ai.converter.StructuredOutputConverter;

public class LenientJsonOutputConverter<T> implements StructuredOutputConverter<T> {

    private static final Pattern FENCE = Pattern.compile("```(?:json)?\\s*([\\s\\S]*?)```");

    private final BeanOutputConverter<T> delegate;

    public LenientJsonOutputConverter(Class<T> targetType) {
        this.delegate = new BeanOutputConverter<>(targetType);
    }

    @Override
    public String getFormat() {
        return this.delegate.getFormat();
    }

    @Override
    public String getJsonSchema() {
        return this.delegate.getJsonSchema();
    }

    @Override
    public T convert(String text) {
        return this.delegate.convert(extractJson(text));
    }

    private String extractJson(String text) {
        if (text == null || text.isBlank()) {
            throw new IllegalArgumentException("模型返回为空");
        }

        Matcher fence = FENCE.matcher(text);
        if (fence.find()) {
            return fence.group(1).trim();
        }

        int start = indexOfJsonStart(text);
        if (start < 0) {
            throw new IllegalArgumentException("响应里找不到 JSON：" + abbreviate(text));
        }
        int end = indexOfJsonEnd(text, start);
        if (end < 0) {
            throw new IllegalArgumentException("JSON 没有闭合：" + abbreviate(text));
        }
        return text.substring(start, end + 1);
    }

    private int indexOfJsonStart(String text) {
        int objectStart = text.indexOf('{');
        int arrayStart = text.indexOf('[');
        if (objectStart < 0) {
            return arrayStart;
        }
        if (arrayStart < 0) {
            return objectStart;
        }
        return Math.min(objectStart, arrayStart);
    }

    private int indexOfJsonEnd(String text, int start) {
        char open = text.charAt(start);
        char close = open == '{' ? '}' : ']';
        int depth = 0;
        boolean inString = false;
        boolean escaped = false;

        for (int i = start; i < text.length(); i++) {
            char c = text.charAt(i);
            if (inString) {
                if (escaped) {
                    escaped = false;
                }
                else if (c == '\\') {
                    escaped = true;
                }
                else if (c == '"') {
                    inString = false;
                }
                continue;
            }
            if (c == '"') {
                inString = true;
            }
            else if (c == open) {
                depth++;
            }
            else if (c == close) {
                depth--;
                if (depth == 0) {
                    return i;
                }
            }
        }
        return -1;
    }

    private String abbreviate(String text) {
        return text.length() <= 80 ? text : text.substring(0, 80) + "...";
    }
}
```

几个关键点，别跳：

- `getFormat()` 和 `getJsonSchema()` **必须转发给 delegate**。前者让提示词里还带着格式说明；后者决定了 `validateSchema()` 和 `useProviderStructuredOutput()` 还作不作数。文档写得很明确：不实现 `getJsonSchema()`，那两个开关对你这个转换器就是空操作。
- `indexOfJsonEnd` 里那套 `inString` / `escaped` 状态机不是炫技。JSON 字符串里出现 `}` 太常见了，比如地址带花括号，或者模型把公式写进字段。简单数括号一定错。
- 找不到 JSON 就抛 `IllegalArgumentException`，别返回 null。让错误在转换层炸，比让它带着 null 流进业务层好。

用起来只有一行区别：

```java
Invoice invoice = this.chatClient.prompt()
        .system(SYSTEM_PROMPT)
        .user(u -> u.text("抽取这张发票的字段：\n{text}").param("text", rawText))
        .call()
        .entity(new LenientJsonOutputConverter<>(Invoice.class));
```

### 示例三：批量抽取 + 重试次数 + token 账

批量最容易翻车。比如「从一封邮件里抽多个订单项」，直觉写法是：

```java
List<OrderItem> items = chatClient.prompt()
        .user("抽取所有订单项：" + mail)
        .call()
        .entity(new ParameterizedTypeReference<List<OrderItem>>() {});
```

单测能过，上了 OpenAI 原生结构化输出就报 API 错。原因很硬：**OpenAI 的 Structured Outputs 不接受顶层数组作为响应 Schema**。

正确姿势是包一层容器对象：

```java
package com.example.structured.model;

import com.fasterxml.jackson.annotation.JsonPropertyDescription;
import java.math.BigDecimal;
import java.util.List;

public record OrderBatch(

        @JsonPropertyDescription("邮件里提到的全部订单项，没有则为空数组")
        List<OrderItem> items
) {
    public record OrderItem(

            @JsonPropertyDescription("商品编码，形如 SKU-12345")
            String sku,

            @JsonPropertyDescription("数量，整数")
            int quantity,

            @JsonPropertyDescription("单价，单位元，纯数字")
            BigDecimal unitPrice
    ) {
    }
}
```

嵌套 record 是支持的，Schema 生成器会正确展开。用的时候：

```java
package com.example.structured.service;

import com.example.structured.model.OrderBatch;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.client.ResponseEntity;
import org.springframework.ai.chat.client.advisor.StructuredOutputValidationAdvisor;
import org.springframework.ai.chat.model.ChatModel;
import org.springframework.ai.chat.model.ChatResponse;
import org.springframework.stereotype.Service;

import java.util.List;

@Service
public class OrderExtractService {

    private static final Logger log = LoggerFactory.getLogger(OrderExtractService.class);

    private final ChatClient chatClient;

    public OrderExtractService(ChatModel chatModel) {
        this.chatClient = ChatClient.builder(chatModel)
                .defaultAdvisors(StructuredOutputValidationAdvisor.builder()
                        .outputType(OrderBatch.class)
                        .maxRepeatAttempts(5)
                        .build())
                .build();
    }

    public List<OrderBatch.OrderItem> extract(String mailText) {
        ResponseEntity<ChatResponse, OrderBatch> result = this.chatClient.prompt()
                .system("你是订单抽取器。只输出 JSON，不要解释。原文没有的字段留空，不要猜。")
                .user(u -> u.text("抽取这封邮件里的所有订单项：\n{text}").param("text", mailText))
                .call()
                .responseEntity(OrderBatch.class, spec -> spec.useProviderStructuredOutput());

        OrderBatch batch = result.getEntity();
        if (batch == null || batch.items() == null) {
            return List.of();
        }

        ChatResponse raw = result.getResponse();
        if (raw != null) {
            long tokens = raw.getMetadata().getUsage().getTotalTokens();
            log.info("本次抽取共消耗 token：{}", tokens);
        }
        return batch.items();
    }
}
```

这段代码有三个故意设计的地方：

**一、用 `responseEntity` 而不是 `entity`。** 前者把原始 `ChatResponse` 一起给你，能拿 token 用量、模型名、finish reason。做成本核算必须用它。注意包名是 `org.springframework.ai.chat.client.ResponseEntity`，跟 Spring MVC 那个同名，别导错。

**二、`maxRepeatAttempts(5)` 显式调大。** 批量抽取的字段多，一次全对的概率低，默认 3 次重试不够。代价是极端情况下一次业务调用变成 6 次计费，所以我在外面配了超时和降级。

**三、`StructuredOutputValidationAdvisor` 是绑死类型的。** `outputType(OrderBatch.class)` 意味着这个 ChatClient 的每次调用都按 `OrderBatch` 校验。所以别在全局 `ChatClient` 上挂它，一种输出类型建一个客户端。上面这个类直接拿 `ChatModel` 另建了一个，就是为了隔离。

## 四、踩坑经验和最佳实践

**坑一：以为开了 `useProviderStructuredOutput()` 就一定生效。**
不支持 `StructuredOutputChatOptions` 的模型，这个开关是静默忽略的。怎么确认？看请求日志里 `response_format` 字段在不在，或者直接拿一个故意缺字段的 Schema 试：真生效的话模型根本吐不出缺字段的响应。

**坑二：全局默认 advisor 把 Schema 焊死了。**
`defaultAdvisors(...)` 挂在哪个 ChatClient 上，那个客户端的所有调用都按这个 Schema 校验。曾经有个项目在全局客户端上挂了 `Invoice` 的校验器，结果同一个客户端去调「生成标题」的接口，全部报 `missing required field invoiceCode`。每个业务输出类型，单独一个 ChatClient。

**坑三：字段全 required，模型只好瞎编。**
Schema 里所有字段默认必填。如果原文里没有购买方名称，模型为了让校验通过，会编一个出来。这比抛异常危险得多——异常你能看见，编造的数据你未必发现。
解决办法：**确实可能缺失的字段，显式标可选**，同时在提示词里写「原文没有就留空，禁止推测」。两处都做，缺一不可。

**坑四：流式接口用不了 `.entity()`。**
`validateSchema()` 需要完整响应才能校验，`.stream()` 给的是文本块。想在流式场景要结构化数据，只能等流结束自己拼字符串再解析，或者干脆放弃流式。别在这上面浪费时间。

**坑五：`Unrecognized token` 其实是提示词问题。**
看到这个错，先别改代码。去日志里把模型原始响应打出来，看开头是不是有「Here's」「好的」「以下是」。如果是，改 system prompt 比写转换器更省事。我在示例一里那句「不要输出任何解释、前后缀、markdown 代码围栏」，就是拿线上事故换来的。

**坑六：重试是有成本的，而且不便宜。**
一次调用失败重试 3 次，prompt token 翻四倍，你按调用次数做的成本预估会全线失准。上线前一定用 `responseEntity` 把 token 记下来，按 P99 算，别按平均值算。

**最佳实践，几条就够：**

- 抽取类任务 `temperature` 设 0；
- system prompt 固定写「只输出 JSON」，这条挡住一半问题；
- 生产必开 `useProviderStructuredOutput() + validateSchema()`；
- 每个输出类型独立 ChatClient，别共用；
- 原始响应永远打日志，出问题第一现场就在那儿；
- 转换失败要能降级：返回「识别失败，请人工录入」，别让整个请求 500。

## 五、性能对比和技术选型

结论：能用原生约束就用，不能就退到提示词 + 自纠，自定义转换器是最后一道保险，不是首选。

| 方案 | 额外延迟 | 可靠性 | token 成本 | 适用场景 |
|---|---|---|---|---|
| 裸 `.entity(Class)` | 0 | 低，格式漂移直接抛 | 每次带 Schema 文本 | 原型、内部工具 |
| `+ validateSchema()` | 失败时叠加一次完整调用 | 中高，能自修 | 失败时成倍增长 | 模型不支持原生约束 |
| `+ useProviderStructuredOutput()` | 略降（省掉 prompt 里的 Schema 指令） | 高 | 略低 | OpenAI / Claude / Gemini 等主流服务 |
| 两者叠加 | 同上 | 最高 | 同上 | 生产默认选这个 |
| 自定义 `StructuredOutputConverter` | 可忽略（纯字符串处理） | 取决于你的解析器 | 同裸调用 | 自建模型、老模型、输出格式奇葩 |
| Tool Calling 取结构化 | 多一轮工具调用 | 高 | 偏高 | 需要模型「决定要不要调」时 |

关于成本，给个可估算的量级：一份 4 字段的 Schema，提示词里大概占 300~500 token。按每天 10 万次抽取算，光 Schema 说明就是每天 3000 万到 5000 万 prompt token。开 `useProviderStructuredOutput()` 把这段从 prompt 移到 API 参数里，省下来的就是这笔钱。量小感觉不到，量大很实在。

延迟上，`validateSchema()` 的代价只在失败时出现。成功率 95% 的场景，平均延迟增加约 5% 的一次调用时间；成功率只有 70% 的场景，平均延迟翻倍，这时候该修的是提示词和 Schema，不是加重试。

至于 Tool Calling，它天生就是结构化的（参数由 Schema 约束）。但它是「模型自己决定调不调」，你无法强制它每次都调。所以抽取类任务用 `.entity()`，需要模型做判断（比如「这条消息要不要创建工单」）才用工具调用。这个边界别搞混。

## 六、总结

结构化输出的本质，是把「概率生成的文本」变成「能进类型系统的对象」。这中间必然有损耗，你的代码得为这个损耗负责。

三层防线，按顺序上：

- **第一层，提示词**：只输出 JSON、缺失字段留空、temperature 0。零成本，挡住大部分。
- **第二层，`useProviderStructuredOutput()`**：把 Schema 提到 API 层，让不合规的响应压根生成不出来。免费的性能提升，不用白不用。
- **第三层，`validateSchema()`**：错误回喂，自动重试。默认 3 次重试额度，批量抽取场景调到 5。
- **保险丝，自定义 converter**：模型前面非要加人话，就把 JSON 抠出来。注意 `getJsonSchema()` 一定要转发，否则前两层对它失效。

还有个心态问题。很多人第一次遇到解析异常，第一反应是「换个更强的模型」。换模型能降错误率，但降不到零。真正的稳定性来自「错了能自己恢复」，而不是「保证不出错」。生产系统里，前者叫工程，后者叫许愿。

写完这套之后，我那个发票接口的失败率从 3% 降到了 0.1% 以下，剩下的是原文本身模糊、模型确实抽不出来的情况——那种就该转人工，跟结构化输出没关系了。

文 / 会编程的吕洞宾

## 参考资料

- [Spring AI Reference — Structured Output](https://docs.spring.io/spring-ai/reference/api/structured-output.html)
- [Spring AI Reference — Schema Validation & Self-Correction](https://docs.spring.io/spring-ai/reference/api/structured-output/validation.html)
- [Spring AI Reference — Provider-Native Structured Output](https://docs.spring.io/spring-ai/reference/api/structured-output/native.html)
- [Spring AI Reference — Output Converters](https://docs.spring.io/spring-ai/reference/api/structured-output/converters.html)
