---
title: "LangChain4j 结构化输出：告别手写解析"
date: 2026-10-12T20:00:00+08:00
category: "AI"
tags: ["AI", "langchain4j"]
---

> 你让大模型返回 JSON，它偏要先来一句「好的，结果如下」；你加正则剥壳，它又把 userId 写成 user_id，把 12,800 写成 12800。于是解析代码比业务还长。LangChain4j 1.x 的结构化输出把这层脏活接了过去：你只声明一个 Java record，接口方法就能直接返回对象，字段约束、解析、类型转换全由框架兜底。这篇讲清它凭什么更稳、什么时候会翻车、代码到底怎么写。

## 一、这个问题到底是什么

先给结论：结构化输出要解决的不是「JSON 字符串怎么转成对象」，而是「怎么让模型吐出的一定是符合你 Java 类型定义的 JSON」。前者是 Jackson 的活，后者才是大模型应用的活。

日常写法通常是这样的——在提示词里加一句咒语：

```text
请从下面的文本里抽取发票号、购买方、金额，以 JSON 格式返回，不要包含其它内容。
```

这句咒语在 demo 里能用，上线就开始漏水。漏的地方很固定：

- **壳子问题。** 模型习惯把 JSON 用 Markdown 代码块包起来，或者前面加一句「好的，这是抽取结果：」。你的 `readValue` 直接抛异常。
- **字段名漂移。** 你定义的是 `invoiceNo`，它这次返回 `invoice_no`，下次返回 `invoiceNumber`。字段一多，你根本猜不到它今天用哪个。
- **类型漂移。** 金额字段你声明成 `int`，它返回 `"12,800 元"`；日期你声明成 `String` 还好，声明成日期类型就开始随机报错。
- **凭空脑补。** 文本里根本没写开票日期，它不会留空，它会给你编一个看起来很像的日期。这是幻觉最隐蔽的一种形态。
- **嵌套丢失。** 你定义了三层结构，它返回两层，中间那层直接拍平。

把上面这些一条条写容错，代码量轻松超过业务本身，而且永远堵不完。真正的问题是：**你在用自然语言请求一个确定的格式，而不是用格式去约束模型。**

结构化输出的思路反了过来。你把 Java 类型交给框架，框架把它翻译成一份机器可读的格式说明书（JSON Schema），再以「约束」而不是「请求」的方式发给模型。模型返回后，框架按同一份类型定义把结果反序列化成对象。整个过程中，你看到的只是一个普通接口方法：

```java
Invoice extract(String text);   // 输入一段文本，拿回一个 Invoice 对象
```

方法签名就是契约。调用方不需要知道里面有没有 JSON，也不需要 try-catch 解析异常。

它适用的场景比你想象的多：发票、合同、简历这类**文档抽取**；邮件的**意图分类**和工单路由；自然语言转成 **API 参数或 SQL 条件**；Agent 在决定下一步调用哪个工具前的**结构化决策**。只要你的下游代码需要一个强类型对象，而不是一段给人看的文字，它就是对的工具。

## 二、底层原理到底怎么回事

### 从 Java 类型反推出一份 JSON Schema

LangChain4j 拿到方法返回类型后，会用反射把类型结构读一遍，生成一份 JSON Schema。假设你定义了这样一个 record：

```java
public record Invoice(String invoiceNo, String amount) {}
```

框架生成的 schema 大致长这样：

```json
{
  "type": "object",
  "properties": {
    "invoiceNo": { "type": "string" },
    "amount":    { "type": "string" }
  },
  "required": ["invoiceNo", "amount"]
}
```

这里有个必须先知道的细节：**record 的每个组件默认都是 required**。框架把所有字段都标成必填，模型于是「必须给一个值」。这就解释了为什么文本里没有的字段，模型会编——不是它不听话，是契约要求它填，它只能猜。

同一个机制还支持其余类型：`enum` 会被翻译成取值白名单，`List<String>` 翻译成字符串数组，嵌套的 record 翻译成嵌套 object。字段上可以挂 `@Description`，那段中文说明会作为字段级的描述写进 schema，等于给模型一份「这个字段该怎么填」的注解。

### schema 是怎么变成约束的：三种策略

光把 schema 发给模型还不够，怎么发决定了稳定性。业界有三种做法，LangChain4j 会按模型能力自动选择，能力不够就往下退：

1. **原生结构化输出（json_schema）。** 请求里带上 `response_format: {type: "json_schema", ...}`。支持它的模型（OpenAI 系主流模型等）在**解码阶段**就被约束，只能生成符合 schema 的 token。这是最稳的一档，字段名和类型基本不会被写错。
2. **JSON 模式（json_object）。** 只能保证输出是一段合法 JSON，保证不了字段名、也保证不了必填项。比纯提示词强，比第一档弱。
3. **提示词方案。** 把 schema 直接拼进提示词，让模型「照着格式写」。任何模型都能用，稳定性也最差，通常只在本地小模型或老接口上作为兜底。

一句话概括三档的差别：**第一档是拿模具压，第二档是给你个容器，第三档是口头约定。** 你用的是哪一档，取决于模型，不取决于你的代码——但 LangChain4j 会把选择做掉，你不用手写分支。

### AiServices 背后是动态代理

`AiServices.builder(InvoiceExtractor.class).chatModel(model).build()` 返回的对象不是你自己写的实现类，而是 JDK 动态代理。你调用接口方法的那一刻，代理做了四件事：

1. 读取方法上的 `@SystemMessage` / `@UserMessage` 注解，把参数按 `@V` 的名字填进模板，拼出真正的提示词；
2. 把返回类型翻译成 schema，连同提示词一起发给 `ChatModel`；
3. 拿回响应后，从文本里把 JSON 抠出来（这一步会自动剥掉 Markdown 代码块包裹和前后废话）；
4. 用 Jackson 按返回类型反序列化，扔回给你。

没有黑魔法，就是「注解 + 反射 + 代理 + Jackson」。理解了这条链路，遇到解析失败时你就知道该看哪一段日志。

### 它凭什么比提示词+Jackson 更靠谱

三个理由，按重要性排：

- **schema 是机器生成的**，不会像人手写提示词那样漏字段、写错标点，改类型定义时 schema 跟着变，不会两边不同步；
- **约束是协议级的**，在原生模式下发生在解码阶段，不是「求」模型遵守，而是让它没法不遵守；
- **回收逻辑是统一的**，代码块包裹、前后寒暄这些脏东西由框架统一处理，而不是每个接口各写一份正则。

## 三、实战：手把手写代码

### 环境准备

- JDK 21；
- Maven；
- 一个 OpenAI 兼容的接口。云上模型最省事，本地用 Ollama 起模型也一样能用（注意本地小模型大概率只能走到第三种策略，稳定性会下降）。

### 依赖

完整的 `pom.xml` 如下，读者照抄即可编译：

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
    <artifactId>langchain4j-structured-output</artifactId>
    <version>0.0.1-SNAPSHOT</version>

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
            <artifactId>langchain4j</artifactId>
            <version>1.22.0</version>
        </dependency>

        <dependency>
            <groupId>dev.langchain4j</groupId>
            <artifactId>langchain4j-open-ai</artifactId>
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

### 示例一：最基础的实体抽取

先定义目标类型。用 record 就够了，字段名就是模型看到的字段名，所以别用 `a`、`f1` 这种缩写。

```java
package com.example.structured;

public record Invoice(
        String invoiceNo,
        String buyerName,
        String amount,
        String issueDate
) {
}
```

然后是接口。注意 `@UserMessage` 里的 `{{text}}` 是一个占位符，靠参数上的 `@V("text")` 绑定；末尾主动交代「找不到就填未知」，是给必填契约留一个诚实的出口。

```java
package com.example.structured;

import dev.langchain4j.service.UserMessage;
import dev.langchain4j.service.V;

public interface InvoiceExtractor {

    @UserMessage("""
            从下面的文本中抽取发票信息。
            如果某个字段在文本里找不到，就填写 未知，不要推测。
            文本：
            {{text}}
            """)
    Invoice extract(@V("text") String text);
}
```

最后是启动类，把模型和抽取器接起来跑一次：

```java
package com.example.structured;

import dev.langchain4j.model.chat.ChatModel;
import dev.langchain4j.model.openai.OpenAiChatModel;
import dev.langchain4j.service.AiServices;
import org.springframework.boot.CommandLineRunner;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.Bean;

@SpringBootApplication
public class StructuredOutputApplication {

    public static void main(String[] args) {
        SpringApplication.run(StructuredOutputApplication.class, args);
    }

    @Bean
    ChatModel chatModel() {
        return OpenAiChatModel.builder()
                .baseUrl(System.getenv().getOrDefault("OPENAI_BASE_URL", "https://api.openai.com/v1"))
                .apiKey(System.getenv("OPENAI_API_KEY"))
                .modelName(System.getenv().getOrDefault("OPENAI_MODEL", "gpt-4o-mini"))
                .temperature(0.0)
                .logRequests(true)
                .logResponses(true)
                .build();
    }

    @Bean
    CommandLineRunner demo(ChatModel chatModel) {
        return args -> {
            InvoiceExtractor extractor = AiServices.builder(InvoiceExtractor.class)
                    .chatModel(chatModel)
                    .build();

            String raw = "采购方：杭州云杉科技有限公司；发票号 INV-2026-7781；"
                    + "价税合计 12,800.00 元；开票日期 2026-10-08。";

            Invoice invoice = extractor.extract(raw);
            System.out.println(invoice);
        };
    }
}
```

这段代码里，`AiServices.builder(...).chatModel(chatModel).build()` 生成的就是上一节说的动态代理。`.temperature(0.0)` 是刻意压低的——抽取任务不需要创造力，需要的是每次都给同一个答案。`.logRequests/.logResponses` 打开后，你能在控制台看到它到底发了什么 schema、模型回了什么 JSON，排查问题全靠它。

跑起来会打印出类似 `Invoice[invoiceNo=INV-2026-7781, buyerName=杭州云杉科技有限公司, amount=12,800.00, issueDate=2026-10-08]` 的对象。注意 `amount` 是 String 类型，原文带千分位和「元」，我故意不声明成数字——金额这类字段用字符串接住原文，后续再自己转 `BigDecimal`，比让模型做格式化要稳。

### 示例二：枚举、列表和字段说明

真实业务很少是平铺的字符串。下面这个招聘信息解析，一口气用上枚举、列表、嵌套和 `@Description`。

```java
package com.example.structured;

import dev.langchain4j.model.output.structured.Description;
import java.util.List;

public record JobPosting(
        @Description("职位名称，例如 高级 Java 工程师")
        String title,

        @Description("招聘公司名称")
        String company,

        @Description("薪资范围，原文怎么写就怎么记，例如 25k-40k；没写就填 未知")
        String salary,

        @Description("工作城市")
        String city,

        WorkMode workMode,

        @Description("岗位要求的技术关键词，最多 8 个")
        List<String> skills
) {
}
```

```java
package com.example.structured;

public enum WorkMode {
    ONSITE,
    HYBRID,
    REMOTE,
    UNKNOWN
}
```

```java
package com.example.structured;

import dev.langchain4j.service.UserMessage;
import dev.langchain4j.service.V;
import java.util.List;

public interface JobPostingExtractor {

    @UserMessage("解析下面的招聘信息：\n{{text}}")
    JobPosting extract(@V("text") String text);

    @UserMessage("把下面这批招聘信息逐条解析，返回一个 JSON 数组，顺序保持不变：\n{{text}}")
    List<JobPosting> extractBatch(@V("text") String text);
}
```

两个关键点。第一，`WorkMode` 里必须留一个 `UNKNOWN`。枚举在 schema 里是取值白名单，模型只要给一个不在名单里的词，解析当场失败；留个兜底值，等于给协议留了个安全阀。第二，`List<JobPosting>` 这种直接返回数组的写法是支持的，框架会要求模型返回 JSON 数组，再逐个反序列化。批量场景下比循环调 N 次省 token、也省延迟。

### 示例三：生产可用的校验与降级

框架能保证「返回的是合法 JSON」，但保证不了「内容是对的」。必填契约会逼模型填空值或编值，所以业务侧一定要有校验和降级。做法是准备一松一紧两套提示词，先松后紧，两次都不合法就明确失败，而不是把脏数据往下游放。

```java
package com.example.structured;

import dev.langchain4j.service.UserMessage;
import dev.langchain4j.service.V;

public interface InvoiceExtractorLenient {

    @UserMessage("从下面的文本中抽取发票字段：\n{{text}}")
    Invoice extract(@V("text") String text);
}
```

```java
package com.example.structured;

import dev.langchain4j.service.UserMessage;
import dev.langchain4j.service.V;

public interface InvoiceExtractorStrict {

    @UserMessage("""
            你是发票信息抽取器，只做提取，不做推断。
            文本中确实没有的字段，一律填空字符串，禁止编造。
            文本：
            {{text}}
            """)
    Invoice extract(@V("text") String text);
}
```

```java
package com.example.structured;

import dev.langchain4j.model.chat.ChatModel;
import dev.langchain4j.service.AiServices;

public class InvoiceService {

    private final InvoiceExtractorLenient lenient;
    private final InvoiceExtractorStrict strict;

    public InvoiceService(ChatModel chatModel) {
        this.lenient = AiServices.builder(InvoiceExtractorLenient.class)
                .chatModel(chatModel)
                .build();
        this.strict = AiServices.builder(InvoiceExtractorStrict.class)
                .chatModel(chatModel)
                .build();
    }

    public Invoice extract(String rawText) {
        Invoice first = lenient.extract(rawText);
        if (isUsable(first)) {
            return first;
        }

        Invoice second = strict.extract(rawText);
        if (isUsable(second)) {
            return second;
        }

        throw new IllegalStateException("两轮抽取都没拿到可用结果，原文：" + rawText);
    }

    private boolean isUsable(Invoice invoice) {
        return invoice != null
                && notBlank(invoice.invoiceNo()) && !"未知".equals(invoice.invoiceNo())
                && notBlank(invoice.amount());
    }

    private boolean notBlank(String value) {
        return value != null && !value.isBlank();
    }
}
```

这套写法的价值在于**把不确定性收敛在服务边界内**。上游拿到的是一个要么可用、要么抛异常的对象，不存在「字段是模型编的但没人知道」的中间状态。真正需要区分「空」和「编造」时，把 `未知` 作为一级公民处理，比事后从日志里捞要靠谱得多。

## 四、踩坑经验和最佳实践

**必填字段会诱发幻觉，这是最大的坑。** record 组件默认 required，模型遇到文本里没有的信息只能猜。对策有三层：提示词里明确「找不到填未知」；类型上把可选字段设计成能被识别为空的形态；业务侧做校验。三样都做，幻觉的伤害面才收得住。

**枚举一定要留兜底值。** 少了 `UNKNOWN`，模型返回一个近义词就抛解析异常。异常信息通常还很难读，因为报错发生在反序列化层，不是业务层。

**字段名就是接口。** 你改一次 record 字段名，等于改了发给模型的 schema，两边不同步就会出现「昨天还好好的，今天全空」。字段名要稳定、语义清晰、别缩写，改的时候当接口变更来管。

**temperature 必须压低。** 抽取、分类这类任务设 0 或 0.1。开到 0.7，同一个输入两次跑出两个答案，你会以为是框架不稳定，其实是采样在飘。

**文本太长要先分段。** 一次塞几万字的合同，轻则字段漏抽，重则直接超上下文。正确姿势是先按章节切块，块内抽取，再合并；别指望模型在你塞爆上下文之后还能记得第一千行的金额。

**嵌套别超过三层。** 层级越深，模型丢中间层的概率越高。如果业务允许，把深层结构拍平成「主对象 + 子列表」两个类型，分两次抽，准确率通常更高。

**金额和日期别用浮点。** `double` 会在 `0.1 + 0.2` 这类地方给你惊喜。金额用 String 接住原文、再转 `BigDecimal`；日期同理，先接字符串，业务层用明确的格式化器解析，报错也报得清楚。

**返回 List 时，空数组是合法结果。** 别把空数组当异常处理，那说明模型确实没抽到内容，属于有效信息。

**schema 每轮都要花 token。** 字段越多、描述越长，输入成本越高。`@Description` 写清楚是必要的，但别把整段业务规则塞进去，那应该在提示词里。

**先用日志看真实请求。** 打开 `logRequests` 和 `logResponses`，看一眼模型实际收到的 schema 长什么样。很多「框架有问题」的错觉，在这一步就破了。

## 五、性能对比和技术选型

同为「让模型返回对象」，几条路的差别很实在：

| 方案 | 稳定性 | 代码量 | 模型要求 | 适合谁 |
| --- | --- | --- | --- | --- |
| 提示词 + 手写 Jackson 解析 | 低 | 多 | 无 | 一次性脚本 |
| 正则从响应里抠 JSON | 很低 | 多 | 无 | 只该出现在梦里 |
| LangChain4j `AiServices` 结构化输出 | 高 | 少 | 主流云模型 | Java/LangChain4j 项目 |
| Spring AI `.entity()` | 高 | 少 | 主流云模型 | Spring Boot + Spring AI 项目 |

选型建议很直接：项目里已经用 LangChain4j，就用 `AiServices`；整体是 Spring AI 生态，就用它自带的 `.entity()`，两者思路完全一样，都是「类型转 schema 再约束模型」。别在同一个项目里混两套，模型配置和可观测性会分裂。

性能上要有个预期：结构化输出比纯文本生成**慢一些**，因为模型要多生成结构化字段，实测大约多 10%～30% 的耗时，具体看字段数量。想压延迟，砍字段比换模型有效——schema 越小，输出越短。另外，走得进原生 `json_schema` 模式的模型，不仅更稳，重试也少，综合成本往往反而更低。

## 六、总结

结构化输出的本质是一条流水线：**Java 类型 → JSON Schema → 约束模型 → 反序列化对象**。LangChain4j 把这条流水线藏在 `AiServices` 动态代理里，你只需要写一个接口和一个 record。

记住三条：

- **record 就是契约。** 字段名、类型、枚举白名单都会直接变成模型看到的约束，改它就是改接口。
- **约束不等于正确。** 框架保证格式，业务保证内容。必填字段会诱发幻觉，校验和降级必须自己做。
- **能走原生就走原生。** 模型的 `json_schema` 支持能力决定了稳定性上限，代码层面能做的是把提示词和兜底设计好。

反过来说，如果你的场景本来就是「给我写一段人类读的文字」——文案、摘要、对话，那不该用结构化输出，套上 schema 只会让模型束手束脚。工具要对得上问题。

---

文 / 会编程的吕洞宾

## 参考资料

- 【LangChain4j 官方文档 - AI Services】https://docs.langchain4j.dev/tutorials/ai-services
- 【LangChain4j 官方文档 - Structured Outputs】https://docs.langchain4j.dev/tutorials/structured-outputs
- 【JSON Schema 官方规范】https://json-schema.org/
