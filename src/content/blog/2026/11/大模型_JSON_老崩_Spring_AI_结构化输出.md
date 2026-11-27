---
title: 大模型 JSON 老崩，Spring AI 结构化输出
date: 2026-11-26 16:15:53
tags: ["AI", "Spring AI", "Java", "Prompt"]
categories: ai
---

# 大模型 JSON 老崩，Spring AI 结构化输出

> 半夜十二点告警响了。跑了三个月的文章摘要功能突然报错，日志里一行 JsonParseException，后面跟着半截 JSON。翻出模型返回的原文：开头多了一段 json 代码块标记，结尾少了一个右括号，中间还混进一个中文引号。模型没坏，它从来就没承诺过输出合法 JSON。这篇文章讲的是怎么在 Spring AI 里把「赌模型听话」改成「结构上保证可用」，以及线上还差哪几步。

## 一、这个问题到底是什么

JSON 解析失败，不是模型翻车，而是你在用一段自然语言，要求一个概率模型输出一种严格格式。这两件事天生不合。

模型生成 JSON 的过程是逐 token 采样，每输出一个字符都在做概率选择。它知道「这里大概该有个引号」，但它不区分英文引号和中文引号，也不保证括号配平。你在提示词里写「只输出 JSON」，它理解成「尽量用 JSON 风格回答」，而不是「违反 RFC 8259 就报错」。

线上真实遇到的失败，基本逃不出这几种：

| 症状 | 模型返回的原样 | 后果 |
|---|---|---|
| 代码块包裹 | 前面多一段 json 代码块标记 | Jackson 读到第一个字符就抛 Unexpected character |
| 前后加解释 | 「好的，以下是摘要：{...}」 | 同样解析失败 |
| 字段名漂移 | 要 keyPoints，它给 key_points | 反序列化成 null，不报错 |
| 类型漂移 | readingMinutes 写成「5 分钟」 | int 字段直接炸 |
| 中文标点 | 用中文引号包字段名 | 引号不匹配，解析中断 |
| 输出截断 | token 预算用完，JSON 断在半路 | 永远补不全的右括号 |

前五种，靠提示词能改善一些。第六种，提示词一点办法都没有，那是输出长度的预算问题。

很多人第一反应是写个正则，把返回值里第一个左花括号到最后一个右花括号抠出来再解析。这招能用，但特别脆：模型一旦在 JSON 前面写一句「格式如下：{「」}」，你的正则就切错位置。还有人手动删代码块标记，结果模型某天换了个标记写法，又崩。

这件事值得专门处理，原因很简单：一次解析失败就是一次完整重试，一次重试就是一次完整的 token 账单。批量任务更麻烦，脏数据混进库里，事后排查的成本比调用费高得多。中文场景还要额外加一层难度，模型对中文标点天然更「放松」。

顺便说清一个容易混的概念。格式化输出只要求「长得像 JSON」，结构化输出要求「能反序列化成你定义的那个类型」。前者是排版，后者是契约。我们要的是后者。

## 二、底层原理到底怎么回事

Spring AI 的 entity() 只做三件事：把 Java 类型翻译成 JSON Schema，把 Schema 塞进提示词，把模型返回的文本反序列化回对象。三步都有明确的失败点，理解了就能对症下药。

### 第一步：类型翻译成 Schema

BeanOutputConverter 拿你的类做反射，逐个字段读出名字和类型，生成一份 JSON Schema。record 的每个组件都会被当成一个属性，并且默认全部进 required 列表。

下面这个 record，生成的 Schema 大致长这样：

```java
public record ArticleSummary(
        String title,
        List<String> keyPoints,
        String audience,
        int readingMinutes) {
}
```

```json
{
  "type": "object",
  "properties": {
    "title": { "type": "string" },
    "keyPoints": { "type": "array", "items": { "type": "string" } },
    "audience": { "type": "string" },
    "readingMinutes": { "type": "integer" }
  },
  "required": ["title", "keyPoints", "audience", "readingMinutes"]
}
```

注意一件事：你在 record 上加的 Bean Validation 注解，比如 @Size(min = 3)，不会进 Schema。校验注解只在本地校验阶段生效，模型看不到。想让模型知道长度限制，只能写进字段描述里，或者写进系统提示词。

### 第二步：Schema 变成提示词文本

converter.getFormat() 返回的是一段普通英文指令，大意是：你的回答必须是 JSON 格式，不要任何解释，必须严格符合下面这份 Schema。然后把上面那段 Schema 原文贴进去。

这段话是纯文本。纯文本意味着模型可以不听。这就是 prompt 级结构化输出的天花板：它提高概率，不提供保证。

### 第三步：文本反序列化

拿到返回的字符串，Jackson 按 Schema 对应的 Java 类型反序列化。这一步有两个行为要记牢：

- 语法不合法，直接抛异常，你至少能感知到失败
- 语法合法但字段缺失，Jackson 给 null（对象类型）或 0（int 基本类型），不抛异常

第二种更阴险。接口正常返回 200，readingMinutes 全是 0，等业务方发现已经过了两周。所以反序列化成功不等于数据正确，必须再加一层 Bean Validation 校验语义。

### 为什么这套组合拳是必要的

模型的解码过程没有任何机制禁止它输出中文引号，温度越高输出越发散。Schema 只是上下文里的一段文字，上下文越长，模型对它的注意力越稀。这三条决定了一件事：可靠性不能只靠 Schema，得靠四件套。

Schema 约束形状，校验约束语义，重试给第二次机会，兜底保证接口不崩。缺任何一环，线上都会漏。

有些模型厂家提供原生严格模式：把 JSON Schema 作为 API 参数交给服务端，服务端在解码时直接禁止不符合 Schema 的 token。这种模式下语法几乎不会错。代价是绑定单个供应商，而且 Schema 只支持一个子集，比如要求所有字段都必填、不支持某些关键字。Spring AI 对各家的支持程度不一样，具体开关看对应厂商的文档。

我的建议是主线用通用的 prompt 级方案，需要极致可靠的核心链路再叠原生模式。理由很实际：多模型混用的项目里，换模型不改代码比省那点 token 重要得多。

## 三、实战：手把手写代码

### 准备：依赖和配置

三个依赖就够：Web 用来暴露接口，Validation 用来校验，OpenAI starter 提供 ChatClient。

```xml
<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
    <modelVersion>4.0.0</modelVersion>

    <parent>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-parent</artifactId>
        <version>4.2.0</version>
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
                <version>2.1.0</version>
                <type>pom</type>
                <scope>import</scope>
            </dependency>
        </dependencies>
    </dependencyManagement>

    <dependencies>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-web</artifactId>
            <version>4.2.0</version>
        </dependency>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-validation</artifactId>
            <version>4.2.0</version>
        </dependency>
        <dependency>
            <groupId>org.springframework.ai</groupId>
            <artifactId>spring-ai-starter-model-openai</artifactId>
            <version>2.1.0</version>
        </dependency>
    </dependencies>

    <build>
        <plugins>
            <plugin>
                <groupId>org.springframework.boot</groupId>
                <artifactId>spring-boot-maven-plugin</artifactId>
                <version>4.2.0</version>
            </plugin>
        </plugins>
    </build>
</project>
```

配置文件指定密钥和模型。密钥从环境变量读，别写死在仓库里。

```yaml
spring:
  ai:
    openai:
      api-key: ${OPENAI_API_KEY}
      chat:
        options:
          model: ${AI_MODEL:gpt-4.1-mini}
          temperature: 0.2
```

温度压到 0.2。结构化任务不需要创造力，越随机越容易出错。

### 示例一：最小可用版本

这是能直接上线的起点。一个 record 定义契约，一个 Service 调模型，一个 Controller 暴露接口。

```java
package com.example.summary;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotEmpty;
import jakarta.validation.constraints.Size;

import java.util.List;

public record ArticleSummary(
        @NotBlank String title,
        @NotEmpty @Size(min = 3, max = 6) List<String> keyPoints,
        @NotBlank String audience,
        int readingMinutes) {
}
```

record 在这里不只是省代码。它不可变，字段顺序固定，BeanOutputConverter 反射起来没有歧义。用普通类也行，但得保证有无参构造和 setter，麻烦。

```java
package com.example.summary;

import org.springframework.ai.chat.client.ChatClient;
import org.springframework.stereotype.Service;

@Service
public class SummaryService {

    private final ChatClient chatClient;

    public SummaryService(ChatClient.Builder builder) {
        this.chatClient = builder
                .defaultSystem("""
                        你是技术公众号的编辑。总结用户给的文章，只输出 JSON，不要写任何解释。
                        只使用原文里出现的信息，不要编造。
                        keyPoints 是文章的 3 到 6 个核心结论，每条一句话。""")
                .build();
    }

    public ArticleSummary summarize(String article) {
        return chatClient.prompt()
                .user(spec -> spec.text("总结这篇文章：\n\n{article}")
                        .param("article", article))
                .call()
                .entity(ArticleSummary.class);
    }
}
```

关键在最后一行 entity(ArticleSummary.class)。它内部会做我们前面讲的三件事，一个方法全包了。系统提示词补了两条 Schema 表达不了的信息：不许编造、keyPoints 的数量范围。这两条只能在文字里说。

```java
package com.example.summary;

import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/summary")
public class SummaryController {

    private final SummaryService summaryService;

    public SummaryController(SummaryService summaryService) {
        this.summaryService = summaryService;
    }

    @PostMapping
    public ArticleSummary summarize(@RequestBody SummaryRequest request) {
        return summaryService.summarize(request.text());
    }

    public record SummaryRequest(String text) {
    }
}
```

启动后测一下：

```bash
curl -s http://localhost:8080/api/summary \
  -H 'Content-Type: application/json' \
  -d '{"text":"Spring AI 的 ChatClient 提供了一套流式接口..."}'
```

返回就是干净的 JSON 对象，没有代码块标记，没有「好的，以下是」。因为 entity() 拿到文本后会先反序列化，失败就抛异常，不会把脏文本透出去。这个特性很重要：它把解析失败从「静默的半坏数据」变成了「明确的异常」。

### 示例二：自己控制提示词

有些场景用不了 ChatClient 的链式调用，比如批量处理、或者你们的提示词模板有自己的拼装逻辑。这时候用 BeanOutputConverter 单独干活。

```java
package com.example.summary;

import org.springframework.ai.chat.model.ChatModel;
import org.springframework.ai.converter.BeanOutputConverter;
import org.springframework.core.ParameterizedTypeReference;
import org.springframework.stereotype.Service;

import java.util.List;

@Service
public class BatchSummaryService {

    private final ChatModel chatModel;

    private final BeanOutputConverter<List<ArticleSummary>> converter =
            new BeanOutputConverter<>(new ParameterizedTypeReference<List<ArticleSummary>>() {
            });

    public BatchSummaryService(ChatModel chatModel) {
        this.chatModel = chatModel;
    }

    public List<ArticleSummary> summarizeAll(List<String> articles) {
        StringBuilder prompt = new StringBuilder();
        prompt.append("下面有几篇文章，请为每篇生成一条摘要，按输入顺序放进 JSON 数组。\n");
        prompt.append(converter.getFormat()).append("\n");
        for (int i = 0; i < articles.size(); i++) {
            prompt.append("第 ").append(i + 1).append(" 篇：\n");
            prompt.append(articles.get(i)).append("\n\n");
        }

        String raw = chatModel.call(prompt.toString());
        return converter.convert(raw);
    }
}
```

泛型类型要用 ParameterizedTypeReference 传，不能写 List.class，否则反射拿到的是原始类型，反序列化出来是一堆 LinkedHashMap。这是 Java 泛型擦除的老问题，跟 AI 没关系，但这里一定会踩。

一次塞多篇有个隐患：篇数越多，输出越长，截断风险越大。我的做法是每批最多 5 篇，超出就分批调用。批次的边界按 token 算，不按篇数算，短文章可以多塞。

### 示例三：生产级，校验加重试

前面两个示例只保证了「能解析」。真正上线要处理的是「解析了但不对」和「解析不了」。

```java
package com.example.summary;

import jakarta.validation.ConstraintViolation;
import jakarta.validation.Validator;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.model.ChatResponse;
import org.springframework.ai.converter.BeanOutputConverter;
import org.springframework.stereotype.Service;

import java.util.Set;
import java.util.stream.Collectors;

@Service
public class RobustSummaryService {

    private static final int MAX_ATTEMPTS = 3;

    private final ChatClient chatClient;
    private final Validator validator;
    private final BeanOutputConverter<ArticleSummary> converter =
            new BeanOutputConverter<>(ArticleSummary.class);

    public RobustSummaryService(ChatClient.Builder builder, Validator validator) {
        this.chatClient = builder
                .defaultSystem("你是技术编辑，只输出符合格式要求的 JSON。")
                .build();
        this.validator = validator;
    }

    public SummaryResult summarize(String article) {
        String lastRaw = null;
        String lastProblem = null;

        for (int attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            ChatResponse response = chatClient.prompt()
                    .user(buildPrompt(article, lastProblem))
                    .call()
                    .chatResponse();

            String raw = response.getResult().getOutput().getText();
            lastRaw = raw;

            try {
                ArticleSummary summary = converter.convert(raw);
                Set<ConstraintViolation<ArticleSummary>> violations = validator.validate(summary);
                if (violations.isEmpty()) {
                    return SummaryResult.ok(summary, attempt);
                }
                lastProblem = violations.stream()
                        .map(v -> v.getPropertyPath() + " " + v.getMessage())
                        .collect(Collectors.joining("; "));
            } catch (Exception e) {
                lastProblem = "JSON 不合法：" + e.getMessage();
            }
        }

        return SummaryResult.failed(lastRaw, lastProblem);
    }

    private String buildPrompt(String article, String lastProblem) {
        StringBuilder prompt = new StringBuilder();
        if (lastProblem != null) {
            prompt.append("上一次的输出有问题：").append(lastProblem)
                    .append("。这次只输出合法 JSON，字段类型严格按 Schema 来。\n\n");
        }
        prompt.append(converter.getFormat()).append("\n\n");
        prompt.append("文章正文：\n").append(article);
        return prompt.toString();
    }

    public record SummaryResult(boolean success, ArticleSummary summary, int attempts,
                                String raw, String problem) {

        static SummaryResult ok(ArticleSummary summary, int attempts) {
            return new SummaryResult(true, summary, attempts, null, null);
        }

        static SummaryResult failed(String raw, String problem) {
            return new SummaryResult(false, null, MAX_ATTEMPTS, raw, problem);
        }
    }
}
```

三段逻辑值得单独说。

错误回填。第二次重试时，把上一次的具体问题写进提示词，比如「keyPoints 至少 3 条」。模型看到具体错误，修正概率远高于你再重复一遍「请输出合法 JSON」。

失败不抛异常。返回 SummaryResult，让调用方自己决定降级还是报错。摘要失败不该让整个接口 500，尤其是批量任务里，一条坏数据不该拖垮一批。

保留原文。raw 一定落盘，脱敏后保存。线上排查全靠它，没有原文你只能猜模型当时抽了什么风。

## 四、踩坑经验和最佳实践

先说最容易翻车的几个点。

枚举值。你在 Java 里定义 PENDING、DONE，模型会老老实实输出吗？不会，它可能给你「待处理」「已完成」，甚至「pending」。稳妥做法是字段用 String 接收，业务层做映射，映射不到给默认值。想省事可以用 Jackson 的 @JsonEnumDefaultValue 指定兜底枚举，但模型输出中文时依然会失败，因为字符串压根不在枚举里。

时间字段。别赌 BeanOutputConverter 内部的 ObjectMapper 注册了 JavaTimeModule。实测最稳的写法是时间一律用 String 接，ISO 格式在提示词里说清楚，业务层再 LocalDateTime.parse。金额同理，用 String 或 BigDecimal，别用 double，模型给你「1,299.00」的时候 double 直接炸。

基本类型。int 改成 Integer。字段缺失时 Integer 是 null，你能立刻发现；int 是 0，看起来像正常数据。

输出长度。摘要类任务，模型输出超过 800 token 就该警惕。长文档别指望一次总结完，先分块摘要再聚合，两层都比一次硬塞强。截断是唯一一个重试也救不回来的错误，因为每次都会在同一个位置断。

Schema 别贪大。字段超过 15 个，拆成两次调用。原因有两个：Schema 本身占 prompt，每轮都付费；字段越多，模型漏字段的概率越高，20 个字段里漏 1 个几乎必然。

流式输出不能直接 entity()。流式是一段一段吐文本，没有完整 JSON 就没法反序列化。要流式就得自己收集完整文本，再调 converter.convert()。

还有一条偏工程的建议：把模型返回的原文、耗时、重试次数打成一条结构化日志。出问题时你能一眼看出是语法问题还是语义问题，而不是翻半小时应用日志。

## 五、性能对比和技术选型

四种主流做法，横向摆开看。

| 方案 | 语法可靠性 | 额外 token | 换模型成本 | 适合场景 |
|---|---|---|---|---|
| entity() + prompt Schema | 中高 | 每次 200 至 600 | 零 | 默认选择，多模型混用 |
| 原生 json_schema 严格模式 | 高 | 低，Schema 走 API 参数 | 高，每家实现不同 | 单模型、核心链路 |
| 手写正则提取 | 低 | 零 | 零 | 不建议用于生产 |
| 先自由文本再二次转换 | 中 | 高，两次调用 | 零 | 中间产物需要人读 |

延迟方面，多一次重试就是多一次完整调用。所以重试上限设 3 次足够，到第三次还错，问题在提示词或字段设计，改重试次数没用。

选型我给个明确态度：默认走 entity() 加校验重试，这套组合能覆盖九成场景。只有当你的链路是单模型、QPS 高、对延迟敏感，才值得上原生严格模式。为了省那几百 token 去绑死一个供应商，换模型时你会后悔。

## 六、总结

结构化输出的本质，是把「模型可能出错」这件事写进代码，而不是写进祈祷。

Schema 约束它的形状，Bean Validation 约束它的语义，重试给它第二次机会，兜底保证你的接口不会因为一次采样崩掉。四件事各管一段，缺哪一段线上都会漏。

代码其实不多，三个类就能跑起来。真正花时间的是字段设计：哪些字段必须非空、哪些类型要放宽成 String、哪些约束只能写进提示词。这部分没有标准答案，只能靠线上数据一点点调。

最后一句实话：如果你的解析失败率超过 5%，别再调提示词了，先看是不是输出被截断，或者字段设计超出了模型的稳定输出能力。

## 参考资料

- [Structured Output Converter](https://docs.spring.io/spring-ai/reference/api/structured-output-converter.html)
- [Chat Client](https://docs.spring.io/spring-ai/reference/api/chatclient.html)
- [Jakarta Bean Validation 3.1 Specification](https://jakarta.ee/specifications/bean-validation/3.1/)

文 / 会编程的吕洞宾
