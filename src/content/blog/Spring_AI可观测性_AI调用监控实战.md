---
title: "Spring AI 可观测性实战：监控大模型调用"
date: 2026-10-07T20:00:00+08:00
category: "AI"
tags: ["spring-ai"]
---

**摘要**：Spring AI 内置 Micrometer 观测能力，不用手写埋点就能拿到大模型调用的耗时、token 用量和链路追踪。本文用 Spring Boot 4.1.1 + Spring AI 2.0.1 搭出一套 Prometheus + Grafana 可观测方案，代码完整可直接跑。

> 场景引入：AI 功能上线第一周，产品问你"一次对话平均烧多少钱"，你说不知道。运维问你"昨天下午接口变慢，是不是模型的问题"，你还是不知道。线上只有一坨日志，翻起来像大海捞针。这篇要解决的就是这件事——不写一行埋点代码，把 AI 调用变成可量化、可告警、可追溯的指标。

## 一、这个问题到底是什么

一句话结论：AI 调用是出名的黑盒，而普通的 Web 监控抓不住它。

传统监控盯三件事：QPS、响应时间、错误率。这套东西搬到 AI 场景，会露出三个洞。

- **耗时被拆不开**。一次 AI 请求的时间到底花在哪——提示词组装、模型推理、还是工具调用的二次往返？只看到一个接口总耗时，等于什么都没看到。
- **花销看不见**。模型按 token 收费，可日志里没有 token 数。月底账单来了，才知道超支。
- **失败难定性**。是同一条提示词反复超时，还是某个模型供应商在抖动，又或者是工具调用进了死循环？没有维度就没法回答。

不少团队的做法是在业务代码里包一层计时器，再打一行日志。能用，但有两个毛病。一是漏，流式调用、工具调用、向量化这几条路径很容易忘记埋；二是散，每个人打印的格式都不一样，最后想按模型聚合一下都做不到。

Spring AI 从 1.0 起就把观测能力内置了。它基于 Spring 生态里的 Micrometer 观测体系，在框架自己的关键组件上统一埋点：ChatClient（含 Advisor 链）、ChatModel、EmbeddingModel、ImageModel、VectorStore。也就是说，只要项目里带上了 Micrometer 和 Actuator，AI 调用的耗时和 token 用量会**自动**变成指标，业务代码一行都不用改。

这里先解释两个词，后面全靠它们。

**指标（Metric）** 是预聚合的数字，比如"过去 5 分钟模型调用的 P95 耗时是 1.8 秒"。它便宜、好聚合、适合做告警看板。**链路（Trace）** 是一次请求的完整行走路径，包括它经过的每个环节和各自的耗时。Micrometer 的 Observation API 干的事，就是**一次埋点同时产出这两样**：写一个 Observation，既生成指标，也生成 span。

所以"给 AI 加监控"的正确姿势不是自己写统计代码，而是把观测体系接通，让框架帮你记。

## 二、底层原理到底怎么回事

Micrometer 的 Observation API 是整个方案的发动机，理解它就理解了全部。

你可以把 Observation 想成一个带上下文的计时器。它有两个关键部分：**Context**（这次观测挂了哪些标签、属于哪个业务场景）和 **Handlers**（观测结束后，谁负责把数据吐出去）。Spring Boot 自动配置好一个全局的 `ObservationRegistry`，并注册了默认的指标处理器。业务侧只管"开始一次观测、结束一次观测"，至于数据是进 Prometheus、还是变成 span 发给 Jaeger，由 Handler 决定。这就是为什么加监控不用改业务逻辑——换后端只需要换 Handler。

Spring AI 在几个关键组件上自动开启了观测。它们各自对应一组指标：

| 观测点 | 指标名 | 记录内容 |
| --- | --- | --- |
| ChatClient（含 `call()`/`stream()`） | `spring.ai.chat.client` | 单次对话调用的总耗时、是否流式 |
| Advisor 链 | `spring.ai.advisor` | 每个 Advisor 的执行耗时（含内层 Advisor） |
| ChatModel | `gen_ai.client.operation` | 模型调用的耗时、供应商、请求/响应模型 |
| ChatModel（token） | `gen_ai.client.token.usage` | 单次模型调用吃掉的输入/输出 token 数 |

指标名沿用了 **OpenTelemetry 的 GenAI 语义约定**，标签统一带 `gen_ai.` 前缀。这一点很关键：命名跟着行业标准走，将来换后端、接别人家的看板，不用重新定义一套。

第二件要理解的事，是**标签为什么分低基数和高基数**。

基数（cardinality）指的是一个标签所有可能取值的数量。`gen_ai.request.model` 的取值就那么几个（`gpt-4o-mini`、`gpt-4o`……），是低基数。Conversation ID、工具名列表、问题原文，这些可能是几十万种取值，是高基数。

Spring AI 的处理规则是：**低基数标签同时进指标和链路，高基数标签只进链路。**

低基数的那批（能进指标的）：

| 标签 | 含义 |
| --- | --- |
| `gen_ai.operation.name` | 操作类型，ChatClient 层固定为 `framework` |
| `gen_ai.system` | 框架来源，固定为 `spring_ai` |
| `gen_ai.request.model` | 请求发给哪个模型 |
| `gen_ai.response.model` | 实际生成响应的模型 |
| `spring.ai.kind` | 框架 API 类型，如 `chat_client`、`advisor` |
| `spring.ai.chat.client.stream` | 是否流式，true / false |

只进链路的那批（**不会**出现在指标里）：`spring.ai.chat.client.advisors`（Advisor 列表）、`spring.ai.chat.client.conversation.id`（会话 ID）、`spring.ai.chat.client.tool.names`（工具名列表）。

为什么这么设计？因为 Prometheus 这类指标库，会为**每一个标签组合**单独存一条时间序列。你把 conversation ID 塞进标签，就是给每次对话开一条新的时间序列。几万条序列堆在内存里，查询全部超时，Prometheus 先被自己撑死。所以高基数信息只能放链路——链路是单个请求一个 span，天然不聚合。

第三件事：**提示词和模型回复默认不导出。**

Prompt 和 completion 体积大，还可能包含用户隐私、内部数据。所以它们默认不采集，需要显式打开：

| 配置项 | 作用 | 默认值 |
| --- | --- | --- |
| `spring.ai.chat.client.observations.log-prompt` | 是否记录 ChatClient 的提示词内容 | false |
| `spring.ai.chat.client.observations.log-completion` | 是否记录模型回复内容 | false |

记住这个默认值，等会儿踩坑一节会专门讲它。

串起来看整条链路：你的代码发起一次对话 → Spring AI 创建 Observation 并注入低基数标签 → 调用模型 → Observation 结束 → `DefaultMeterObservationHandler` 把耗时和 token 记进 Micrometer 的 MeterRegistry → Actuator 的 `/actuator/prometheus` 端点把数据吐成 Prometheus 格式 → Prometheus 定时抓取 → Grafana 画图。你写的业务代码，只出现在第一个箭头。

## 三、实战：手把手写代码

目标：起一个能跑的 Spring Boot 应用，调一次 OpenAI，然后在指标端点里看到 `gen_ai.client.operation` 和 `gen_ai.client.token.usage`。

### 3.1 依赖

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
    <artifactId>ai-observability-demo</artifactId>
    <version>0.0.1-SNAPSHOT</version>
    <name>ai-observability-demo</name>

    <properties>
        <java.version>21</java.version>
        <spring-ai.version>2.0.1</spring-ai.version>
    </properties>

    <dependencies>
        <!-- Spring AI 的 OpenAI 模型接入，starter 已把 Observation 埋点带上 -->
        <dependency>
            <groupId>org.springframework.ai</groupId>
            <artifactId>spring-ai-starter-model-openai</artifactId>
            <version>2.0.1</version>
        </dependency>

        <!-- Web：暴露一个测试接口 -->
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-web</artifactId>
            <version>4.1.1</version>
        </dependency>

        <!-- Actuator：提供 /actuator/metrics 和 /actuator/prometheus -->
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-actuator</artifactId>
            <version>4.1.1</version>
        </dependency>

        <!-- @Observed 注解靠 AOP 生效。Spring Boot 4 起这个 starter 改名为 aspectj -->
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-aspectj</artifactId>
            <version>4.1.1</version>
        </dependency>

        <!-- Prometheus 格式的指标导出 -->
        <dependency>
            <groupId>io.micrometer</groupId>
            <artifactId>micrometer-registry-prometheus</artifactId>
            <version>1.17.1</version>
        </dependency>
    </dependencies>

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

有两点值得单独提醒。Spring AI 2.0 的 OpenAI starter 名字是 `spring-ai-starter-model-openai`，不是老版本那种 `spring-ai-openai-spring-boot-starter`，老名字复制过来会直接报找不到依赖。另外就是那个 `spring-boot-starter-aspectj`，Spring Boot 4 把原来的 `spring-boot-starter-aop` 改名了，继续写旧名字同样是 404。

### 3.2 配置

```yaml
spring:
  application:
    name: ai-observability-demo
  ai:
    openai:
      api-key: ${OPENAI_API_KEY}
      chat:
        options:
          model: gpt-4o-mini
          temperature: 0.7
    chat:
      client:
        observations:
          # 排障时打开，生产环境务必关掉，理由见第四节
          log-prompt: true
          log-completion: false

management:
  endpoints:
    web:
      exposure:
        # 只暴露需要的三个，别用 "*"
        include: health,metrics,prometheus
  metrics:
    tags:
      # 所有指标自动带上 application 标签，方便多服务区分
      application: ${spring.application.name}
    distribution:
      percentiles-histogram:
        # 让 gen_ai.client.operation 输出直方图，才能算 P95 / P99
        gen_ai.client.operation: true
  tracing:
    sampling:
      probability: 1.0
```

`percentiles-histogram` 那段是刚需。Micrometer 默认只给计时器保留 count、total time、max 这类简单统计，算不出百分位。打开直方图才能查 P95——而看 AI 体验，看平均值基本没意义。

### 3.3 主类和配置类

```java
package com.example.aiobs;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class AiObservabilityApplication {

    public static void main(String[] args) {
        SpringApplication.run(AiObservabilityApplication.class, args);
    }
}
```

```java
package com.example.aiobs.config;

import io.micrometer.observation.ObservationRegistry;
import io.micrometer.observation.aop.ObservedAspect;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class ObservationConfig {

    /**
     * 注册这个 Bean 之后，@Observed 注解才会真正被切面处理。
     * 不注册的话，注解不会报错，但也什么都不会发生——这是最常见的哑弹。
     */
    @Bean
    public ObservedAspect observedAspect(ObservationRegistry registry) {
        return new ObservedAspect(registry);
    }
}
```

### 3.4 业务服务：ChatClient

```java
package com.example.aiobs.service;

import org.springframework.ai.chat.client.ChatClient;
import org.springframework.stereotype.Service;

@Service
public class ChatService {

    private final ChatClient chatClient;

    /**
     * ChatClient.Builder 由 spring-ai-starter-model-openai 自动配置，直接注入即可。
     */
    public ChatService(ChatClient.Builder builder) {
        this.chatClient = builder
                .defaultSystem("你是一个简洁的 Java 技术助手，回答控制在 3 句话以内。")
                .build();
    }

    public String ask(String question) {
        return chatClient.prompt()
                .user(question)
                .call()
                .content();
    }
}
```

这段代码里没有任何监控相关的代码。观测数据是框架在 `chatClient.prompt()...call()` 内部自己记的——这正是本文想说明的核心：**AI 监控不该压在业务开发者身上**。

### 3.5 接口层：加自定义业务指标

```java
package com.example.aiobs.web;

import com.example.aiobs.service.ChatService;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.observation.annotation.Observed;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class ChatController {

    private final ChatService chatService;
    private final Counter requestCounter;

    public ChatController(ChatService chatService, MeterRegistry registry) {
        this.chatService = chatService;
        // 自定义业务计数器。名字用点分，标签值固定，避免高基数
        this.requestCounter = Counter.builder("ai.chat.requests")
                .description("业务侧发起的 AI 对话次数")
                .tag("endpoint", "/chat")
                .register(registry);
    }

    @GetMapping("/chat")
    @Observed(name = "ai.chat.endpoint", contextualName = "chat-endpoint")
    public String chat(@RequestParam("q") String question) {
        requestCounter.increment();
        return chatService.ask(question);
    }
}
```

`@Observed` 的价值在于补上业务视角的耗时。框架记的是"模型调用花了多久"，这里记的是"这个 HTTP 接口总共花了多久"，两者一对比，就能看出提示词组装、参数拼装这些业务侧动作吃掉了多少时间。

### 3.6 跑起来，验证指标

启动应用，先打一次接口：

```bash
export OPENAI_API_KEY=sk-你的key
mvn spring-boot:run

# 另开一个终端
curl "http://localhost:8080/chat?q=用一句话解释什么是向量数据库"
```

再看模型维度的指标：

```bash
curl -s http://localhost:8080/actuator/metrics/gen_ai.client.operation
curl -s http://localhost:8080/actuator/metrics/gen_ai.client.token.usage
```

token 那条返回的 `availableTags` 里会列出输入/输出的区分标签，**以实际输出为准**，别凭猜写查询。Prometheus 抓取格式的端点长这样：

```bash
curl -s http://localhost:8080/actuator/prometheus | grep gen_ai
```

拿到真实标签名后，就可以在 Grafana 里写查询了。统计输入 token 的增长速率，大致是这样：

```promql
# 说明：Micrometer 会把指标名里的点转成下划线，
# gen_ai.client.token.usage 在 Prometheus 里就是 gen_ai_client_token_usage
sum by (gen_ai_request_model) (
  rate(gen_ai_client_token_usage_sum[5m])
)
```

把它乘上你所用模型的单价，就是实时成本曲线。换算成"每分钟烧了多少钱"，比月底看账单舒服得多。

## 四、踩坑经验和最佳实践

**坑一：生产环境打开 prompt 日志。** `log-prompt` 打开后，用户的问题原文、可能还有 API key、内部数据，全进日志系统。它只适合排障时临时开、定点开。更危险的是"顺手把 completion 也打开"——模型回复可能比提示词长一个数量级，日志量会直接翻倍。默认值是 false，是有原因的。

**坑二：把高基数数据塞进标签。** 这是最贵的一类错误。有人为了追单个用户，给指标加 `userId` 标签；有人把 `conversationId` 加进计数器。指标量瞬间暴涨，Prometheus 内存先扛不住，查询全面变慢。判断标准很简单：这个标签的取值会不会有几百上千种？会，就放链路，别放指标。Spring AI 自己就是这么做的——工具名、会话 ID、Advisor 列表全都只进链路。

**坑三：流式调用下找回不到的父 span。** Spring AI 的流式调用里，HTTP 层 span 虽然记了，但没有挂在 chat-model 的 span 下面。原因是底层 SDK 的异步流式路径会切到线程池，调用线程的观测上下文在那个边界断掉了。所以排查流式请求的耗时构成时，不能单纯按 span 的父子层级往下钻，要按 traceId 平铺着看。

**坑四：把 token 指标当请求数用。** `gen_ai.client.token.usage` 记的是**每次模型调用**，不是每次业务请求。如果一个请求触发了工具调用、来回问了三轮模型，那就会产生三条记录。算成本口径时要按调用次数聚合，别按请求数聚合，不然账对不上。

**坑五：Actuator 端点全量暴露还挂公网。** `/actuator/prometheus` 会泄露模型名、调用量、内部服务名，`/actuator` 更是事故高发区。做法是只 include 需要的端点（示例里只开了三个），再加一层鉴权或内网限制。

**坑六：只看平均耗时。** AI 调用的耗时分布很偏，平均值被大量快请求拉低，真正让用户难受的是长尾。配置 `percentiles-histogram` 打开直方图，盯 P95 / P99，这是唯一有意义的视角。

实践上还有两条建议。自定义指标统一用 `业务域.动作` 的点分命名（比如 `ai.chat.requests`），团队里先约定好，不然半年后又变成一堆散装指标。以及把 `error` 相关的标签接上告警——模型供应商抖动是常态，能提前十秒知道，比用户先来投诉强。

## 五、性能对比和技术选型

先给结论：只要你用 Spring Boot，就走 Micrometer，别自建。

**内置观测 vs 手写计时器。** 手写计时器只能记耗时，记不了 token 数、模型名、供应商。而且它覆盖不到流式、嵌入、工具调用这些路径。Spring AI 内置的观测是框架级的，覆盖全、命名统一、跟着 OTel 语义约定走。

**Micrometer 门面 vs 直接上 OpenTelemetry SDK。** Micrometer 是"门面"，一层 API 后面可以接不同的后端。Spring 生态默认就是它，零额外成本。OTel SDK 更底层、更强大，但要在业务代码里手动构造 span 和 metric，工作量和侵入性都大得多。而且 Spring AI 的指标名本来就采用 OTel 的 GenAI 语义约定——先接 Micrometer，将来需要时把 Handler 换成 OTLP 导出即可，业务代码不动。

**指标 vs 日志。** 两者不是替代关系。指标是预聚合的，成本低、适合看板和告警，但你没法从指标里还原"某个用户那次失败的请求到底发生了什么"。日志适合事后追单个请求，成本高。正确的组合是：指标负责发现异常，日志和链路负责定位原因。

| 方案 | 覆盖度 | 侵入性 | 成本 | 适用场景 |
| --- | --- | --- | --- | --- |
| Spring AI 内置 + Micrometer | 框架级全覆盖 | 零 | 低 | 默认选择 |
| 手写计时器 + 日志 | 只覆盖手写路径 | 高 | 低但不可靠 | 临时排查 |
| OTel SDK 手动埋点 | 取决于埋点质量 | 高 | 中 | 需要深度自研链路时 |

## 六、总结

这件事的核心就三句话。

AI 调用的可观测性，靠的是框架内置的 Observation 埋点，不是业务代码。Micrometer 一次埋点同时产出指标和链路，Spring AI 已经在 ChatClient、ChatModel、EmbeddingModel、VectorStore 这些组件上帮你挂好了。

指标和链路的分工由"基数"决定：低基数的模型名、操作类型进指标，高基数的会话 ID、工具名只进链路。这条规则决定了你的 Prometheus 会不会被撑死，别越界。

落地顺序建议这样走：先加 Actuator 和 Prometheus registry，看一眼默认就有的 `gen_ai.client.operation`；再打开 `percentiles-histogram`，把 P95 和 token 用量画上 Grafana；最后按模型单价算出成本曲线，接上告警。全程不需要动业务代码。

至于 `log-prompt`，让它保持默认的 false。真出事再临时开。

文 / 会编程的吕洞宾

## 参考资料

- [Observability :: Spring AI Reference](https://docs.spring.io/spring-ai/reference/observability/index.html)
- [Metrics :: Spring Boot Actuator Reference](https://docs.spring.io/spring-boot/reference/actuator/metrics.html)
- [Observation :: Micrometer Reference](https://docs.micrometer.io/micrometer/reference/observation.html)
- [Generative AI semantic conventions :: OpenTelemetry](https://opentelemetry.io/docs/specs/semconv/gen-ai/)
