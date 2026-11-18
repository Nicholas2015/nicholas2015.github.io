---
title: "AI 接口 token 账算不清，Java 这样埋点"
date: 2026-11-18T20:00:00+08:00
category: "AI"
tags: ["AI"]
---

> 客服问答上线三个月，老板问「这个月 AI 花了多少钱」。你打开供应商后台，只有一个总数：412 美元。哪个租户吃的？哪个功能吃的？是 RAG 塞的上下文太长，还是工具循环里模型被偷偷调了五遍？一概不知道。这不是财务问题，是代码里缺了一层计量。下面用 Spring AI 的 Advisor 把每一笔 token 都记清楚，顺带把预算熔断也加上。

## 一、这个问题到底是什么

大模型的账单按 token 计费，不按请求计费。这一条决定了你没法用「接口调用次数」去估钱。

同一次用户提问，成本可能差出一百倍。用户问「我的订单到哪了」，你直接丢给模型，输入 30 个 token。用户问「帮我对比这三个套餐哪个划算」，你的 RAG 检索出 12 个文档块，拼成 9000 token 的上下文，模型再输出 500 token 的分析。这两次调用在监控上都是「1 次请求」，账单上差了三个数量级。

钱具体从三个地方漏掉：

**上下文越长越贵，而且贵在输入侧。** 很多人只盯着输出长度，实际上 RAG 场景里输入 token 通常是输出的十倍以上。你把文档块从 12 个减到 5 个，账单可能直接砍半。

**工具调用会放大调用次数。** Agent 里一轮对话，模型可能被调用四到五次：第一次决定调哪个工具，拿到结果后决定再调一个，最后才组织答案。每一次都是一次完整的模型调用，都单独计费。业务代码里如果只在最外层记一笔，账单会少记三四倍。

**流式输出中途断开，已经生成的部分照样算钱。** 用户点了「停止生成」，或者页面关了，服务端的连接断了，但供应商那边已经吐出来的 token 不会退。

那为什么不能在业务代码里手动数？三种死法，一个比一个常见：

1. **漏**。今天加了新接口忘了统计，明天加了个定时任务调模型，也没统计。统计代码散落在各 Service 里，没人保证覆盖全。
2. **错**。正常路径记了，异常路径没记。模型返回 500 之前其实已经消耗了 token，你的 try-catch 直接把异常抛出去，这条记录就消失了。
3. **重**。在工具循环外面记一次，看起来是一条记录，实际供应商那边扣了四次钱。

结论很直接：计量必须挂在**每一次真实模型调用**上，而不是挂在业务方法上。在 Spring AI 里，这个位置只有一个——Advisor 链。

## 二、底层原理到底怎么回事

### 2.1 一次 ChatClient 调用到底经过了几层

Spring AI 的调用栈是一条洋葱：

```
业务代码 → Advisor A → Advisor B → ... → ChatModelCallAdvisor → ChatModel → HTTP 请求
```

`ChatClient.prompt().call()` 发起后，请求从最外层 Advisor 一层层往里传，最后到 `ChatModelCallAdvisor` 真正发 HTTP。响应再一层层往外回。

关键点：**Advisor 是有顺序的，order 小的在外层，order 大的在内层。** `ChatModelCallAdvisor` 的 order 是 `LOWEST_PRECEDENCE`（整数最大值），所以它永远在最里面。

而工具循环是另一个 Advisor 干的活——`ToolCallingAdvisor`，它的 order 是 `Ordered.HIGHEST_PRECEDENCE + 300`。它拿到模型的「我要调工具」响应后，自己执行工具，然后**再调一次下层的链**，把工具结果喂回去。一轮对话里有几个工具回合，下层链就被调几次。

所以你的计量 Advisor 的 order 必须**大于 300**，才能落在工具循环里面，每次真实模型调用都被拦到。写在 300 外面，一轮多工具对话你只会记到一次。

我用 400：

```java
private static final int ORDER = Ordered.HIGHEST_PRECEDENCE + 400;
```

### 2.2 token 数字是从哪来的

不是算出来的，是抄出来的。供应商的响应体里本来就带着 `usage` 字段，长这样：

```json
{
  "usage": {
    "prompt_tokens": 812,
    "completion_tokens": 156,
    "total_tokens": 968
  }
}
```

Spring AI 把它反序列化成 `Usage` 接口，挂在 `ChatResponse.getMetadata().getUsage()` 上。你能拿到三个基础数字，外加缓存命中信息：

- `getPromptTokens()` —— 输入侧 token
- `getCompletionTokens()` —— 输出侧 token
- `getCacheReadInputTokens()` —— 命中供应商 prompt 缓存的 token，价格通常只有原价的十分之一甚至更低

最后这个别忽略。你要是按全价算缓存命中，成本会虚高；反过来，你要是不看这个字段做优化，永远不知道自己省在哪。

成本公式本身很简单：

```
cost = 输入token/1000 × 输入单价 + 输出token/1000 × 输出单价
```

复杂的是**维度**。你得能回答「租户 A 今天花了多少」「模型 B 这周花了多少」，所以每条记录都要带标签。

### 2.3 租户信息怎么传进 Advisor

最直觉的做法是 ThreadLocal：请求进来时把 userId 塞进去，Advisor 里取。这在同步代码里能跑，在流式场景下会出问题——`Flux` 的线程会切换，ThreadLocal 里的值要么丢了，要么串到别的请求上。

Spring AI 给了一条正经通道：Advisor 上下文。`ChatClient` 每次调用可以带一组 key-value，它会跟着请求在整条链上传递：

```java
chatClient.prompt()
    .user(q)
    .advisors(a -> a.param("tenant", "acme"))
    .call();
```

Advisor 里通过 `request.context().get("tenant")` 取。这条通道跨线程也有效，因为它跟着请求对象走，不跟着线程走。

### 2.4 流式的 usage 有个坑

非流式调用，一次响应一个完整 `usage`，干净利落。

流式调用是一串 chunk，`usage` 通常只出现在**最后一个** chunk 里，前面全是 `null`。而且不是所有供应商默认都发——OpenAI 兼容接口要靠 `stream_options.include_usage` 打开，有些自建网关干脆不发。

所以流式计量要做兜底：抓到最后一个非空 `usage` 就记；全程没抓到，只能按字符数估算，并且明确标成 `estimated`，别和真实数字混在一张表里。

## 三、实战：手把手写代码

工程结构：

```
src/main/java/com/example/aitoken
├── AiTokenApplication.java
├── advisor
│   ├── BudgetGuardAdvisor.java
│   ├── BudgetExceededException.java
│   ├── TokenUsageAdvisor.java
│   └── StreamTokenUsageAdvisor.java
├── config
│   └── AiClientConfig.java
├── cost
│   ├── CostRecorder.java
│   └── ModelPriceProperties.java
└── web
    ├── ChatController.java
    └── GlobalExceptionHandler.java
```

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
        <version>4.1.2</version>
        <relativePath/>
    </parent>

    <groupId>com.example</groupId>
    <artifactId>ai-token-meter</artifactId>
    <version>1.0.0</version>

    <properties>
        <java.version>21</java.version>
        <spring-ai.version>2.0.2</spring-ai.version>
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
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-actuator</artifactId>
            <version>4.1.2</version>
        </dependency>
        <dependency>
            <groupId>org.springframework.ai</groupId>
            <artifactId>spring-ai-starter-model-openai</artifactId>
            <version>2.0.2</version>
        </dependency>
        <dependency>
            <groupId>io.micrometer</groupId>
            <artifactId>micrometer-registry-prometheus</artifactId>
            <version>1.17.2</version>
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

### 3.2 配置

```yaml
server:
  port: 8080

spring:
  ai:
    openai:
      api-key: ${OPENAI_API_KEY}
      chat:
        options:
          model: gpt-4o-mini
          temperature: 0.3

management:
  endpoints:
    web:
      exposure:
        include: health,info,metrics,prometheus
  metrics:
    tags:
      application: ai-token-meter

ai:
  cost:
    daily-budget-usd: 5.0
    default-input-per-1k-usd: 0.00015
    default-output-per-1k-usd: 0.0006
    prices:
      gpt-4o-mini:
        input-per-1k-usd: 0.00015
        output-per-1k-usd: 0.0006
      gpt-4o:
        input-per-1k-usd: 0.0025
        output-per-1k-usd: 0.01
```

这里的单价是占位数字，数值本身会因为供应商调价随时变。**以你自己账单上的价格为准填**，尤其是走代理网关的，价格表可能和官方完全不同。

对应两个类，一个存价格，一个负责记。先看价格：

```java
package com.example.aitoken.cost;

import java.util.HashMap;
import java.util.Map;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;

@Component
@ConfigurationProperties(prefix = "ai.cost")
public class ModelPriceProperties {

    /** 每个租户每天的成本上限，单位美元 */
    private double dailyBudgetUsd = 5.0;

    /** 价格表里查不到模型时用的兜底单价 */
    private double defaultInputPer1kUsd = 0.00015;

    private double defaultOutputPer1kUsd = 0.0006;

    /** key 是模型名，value 是每千 token 的单价 */
    private Map<String, Price> prices = new HashMap<>();

    public Price priceOf(String model) {
        if (model != null) {
            Price direct = prices.get(model);
            if (direct != null) {
                return direct;
            }
            // 模型名经常带日期后缀，比如 gpt-4o-mini-2024-07-18，做一次前缀匹配
            for (Map.Entry<String, Price> entry : prices.entrySet()) {
                if (model.startsWith(entry.getKey())) {
                    return entry.getValue();
                }
            }
        }
        Price fallback = new Price();
        fallback.setInputPer1kUsd(defaultInputPer1kUsd);
        fallback.setOutputPer1kUsd(defaultOutputPer1kUsd);
        return fallback;
    }

    public double getDailyBudgetUsd() {
        return dailyBudgetUsd;
    }

    public void setDailyBudgetUsd(double dailyBudgetUsd) {
        this.dailyBudgetUsd = dailyBudgetUsd;
    }

    public double getDefaultInputPer1kUsd() {
        return defaultInputPer1kUsd;
    }

    public void setDefaultInputPer1kUsd(double defaultInputPer1kUsd) {
        this.defaultInputPer1kUsd = defaultInputPer1kUsd;
    }

    public double getDefaultOutputPer1kUsd() {
        return defaultOutputPer1kUsd;
    }

    public void setDefaultOutputPer1kUsd(double defaultOutputPer1kUsd) {
        this.defaultOutputPer1kUsd = defaultOutputPer1kUsd;
    }

    public Map<String, Price> getPrices() {
        return prices;
    }

    public void setPrices(Map<String, Price> prices) {
        this.prices = prices;
    }

    public static class Price {

        private double inputPer1kUsd;

        private double outputPer1kUsd;

        public double getInputPer1kUsd() {
            return inputPer1kUsd;
        }

        public void setInputPer1kUsd(double inputPer1kUsd) {
            this.inputPer1kUsd = inputPer1kUsd;
        }

        public double getOutputPer1kUsd() {
            return outputPer1kUsd;
        }

        public void setOutputPer1kUsd(double outputPer1kUsd) {
            this.outputPer1kUsd = outputPer1kUsd;
        }
    }
}
```

### 3.3 记账器：指标 + 当日累计

一个类干两件事：把 token 和成本打进 Micrometer（最终变成 Prometheus 指标），同时维护「每个租户今天花了多少」，给熔断用。

```java
package com.example.aitoken.cost;

import java.time.LocalDate;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.DoubleAdder;

import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;

import org.springframework.ai.chat.metadata.Usage;
import org.springframework.stereotype.Component;

@Component
public class CostRecorder {

    /** 缓存命中的输入 token 按原价的这个系数计费，按自己供应商规则改 */
    private static final double CACHE_PRICE_RATIO = 0.1;

    private final MeterRegistry registry;

    private final ModelPriceProperties prices;

    /** Metrics 计数器缓存，避免每次调用都新建 */
    private final Map<String, Counter> counters = new ConcurrentHashMap<>();

    /** 租户 -> 当日累计花费 */
    private final Map<String, Spend> spends = new ConcurrentHashMap<>();

    public CostRecorder(MeterRegistry registry, ModelPriceProperties prices) {
        this.registry = registry;
        this.prices = prices;
    }

    /**
     * 记录一次真实模型调用的用量，返回这次调用的美元成本。
     * usage 为 null 时直接返回 0，不做任何猜测。
     */
    public double record(String tenant, String model, Usage usage) {
        if (usage == null) {
            return 0.0;
        }

        int promptTokens = nullSafe(usage.getPromptTokens());
        int completionTokens = nullSafe(usage.getCompletionTokens());
        long cachedTokens = usage.getCacheReadInputTokens() == null ? 0L : usage.getCacheReadInputTokens();

        ModelPriceProperties.Price price = prices.priceOf(model);
        long billableInput = Math.max(0L, promptTokens - cachedTokens);

        double costUsd = billableInput / 1000.0 * price.getInputPer1kUsd()
                + cachedTokens / 1000.0 * price.getInputPer1kUsd() * CACHE_PRICE_RATIO
                + completionTokens / 1000.0 * price.getOutputPer1kUsd();

        counter("ai.tokens", tenant, model, "prompt").increment(promptTokens);
        counter("ai.tokens", tenant, model, "completion").increment(completionTokens);
        counter("ai.tokens", tenant, model, "cached").increment(cachedTokens);
        counter("ai.cost.usd", tenant, model, "total").increment(costUsd);

        currentSpend(tenant).usd.add(costUsd);
        return costUsd;
    }

    /** 某个租户今天已经花了多少美元 */
    public double spentToday(String tenant) {
        return currentSpend(tenant).usd.sum();
    }

    private Spend currentSpend(String tenant) {
        String today = LocalDate.now().toString();
        return spends.compute(tenant, (key, existing) -> {
            if (existing == null || !today.equals(existing.day)) {
                return new Spend(today);
            }
            return existing;
        });
    }

    private Counter counter(String name, String tenant, String model, String type) {
        String key = name + '|' + tenant + '|' + model + '|' + type;
        return counters.computeIfAbsent(key, ignored -> Counter.builder(name)
                .description("LLM usage and cost")
                .tag("tenant", tenant)
                .tag("model", model)
                .tag("type", type)
                .register(registry));
    }

    private static int nullSafe(Integer value) {
        return value == null ? 0 : value;
    }

    private static final class Spend {

        private final String day;

        private final DoubleAdder usd = new DoubleAdder();

        private Spend(String day) {
            this.day = day;
        }
    }
}
```

注意 `spends` 里存的是「日期 + 累计值」，跨天时直接整个换掉。不用定时任务清零，也就不用担心定时任务挂了导致预算永远不重置。

### 3.4 同步调用的计量 Advisor

```java
package com.example.aitoken.advisor;

import com.example.aitoken.cost.CostRecorder;

import org.springframework.ai.chat.client.ChatClientRequest;
import org.springframework.ai.chat.client.ChatClientResponse;
import org.springframework.ai.chat.client.advisor.api.CallAdvisor;
import org.springframework.ai.chat.client.advisor.api.CallAdvisorChain;
import org.springframework.ai.chat.metadata.Usage;
import org.springframework.ai.chat.model.ChatResponse;
import org.springframework.core.Ordered;

public class TokenUsageAdvisor implements CallAdvisor {

    /** 业务代码往 Advisor 上下文里塞租户时用的 key */
    public static final String TENANT_KEY = "tenant";

    private static final String DEFAULT_TENANT = "anonymous";

    private static final String UNKNOWN_MODEL = "unknown";

    /** 必须大于 ToolCallingAdvisor 的 300，才能落在工具循环里面 */
    private static final int ORDER = Ordered.HIGHEST_PRECEDENCE + 400;

    private final CostRecorder recorder;

    public TokenUsageAdvisor(CostRecorder recorder) {
        this.recorder = recorder;
    }

    @Override
    public ChatClientResponse adviseCall(ChatClientRequest request, CallAdvisorChain chain) {
        ChatClientResponse response = chain.nextCall(request);

        ChatResponse chatResponse = response.chatResponse();
        if (chatResponse != null) {
            Usage usage = chatResponse.getMetadata().getUsage();
            String model = chatResponse.getMetadata().getModel();
            recorder.record(tenantOf(request), model == null ? UNKNOWN_MODEL : model, usage);
        }

        return response;
    }

    private String tenantOf(ChatClientRequest request) {
        Object tenant = request.context().get(TENANT_KEY);
        return tenant == null ? DEFAULT_TENANT : tenant.toString();
    }

    @Override
    public String getName() {
        return "TokenUsageAdvisor";
    }

    @Override
    public int getOrder() {
        return ORDER;
    }
}
```

这段代码没有 try-catch。异常了要不要记？如果模型在返回前就报错，`usage` 本来也拿不到，没什么可记的。真正的风险是「模型已经成功返回，但后续代码抛异常」——那种情况 `recorder.record` 已经执行完了，不受影响。所以这里不需要额外的 finally。

### 3.5 流式调用的计量 Advisor

`.call()` 走 `CallAdvisor`，`.stream()` 走 `StreamAdvisor`，两条路是分开的。只注册一个，另一个入口就漏了。

```java
package com.example.aitoken.advisor;

import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

import com.example.aitoken.cost.CostRecorder;
import reactor.core.publisher.Flux;

import org.springframework.ai.chat.client.ChatClientRequest;
import org.springframework.ai.chat.client.ChatClientResponse;
import org.springframework.ai.chat.client.advisor.api.StreamAdvisor;
import org.springframework.ai.chat.client.advisor.api.StreamAdvisorChain;
import org.springframework.ai.chat.metadata.Usage;
import org.springframework.ai.chat.model.ChatResponse;
import org.springframework.core.Ordered;

public class StreamTokenUsageAdvisor implements StreamAdvisor {

    private static final String DEFAULT_TENANT = "anonymous";

    private static final String UNKNOWN_MODEL = "unknown";

    private static final int ORDER = Ordered.HIGHEST_PRECEDENCE + 401;

    private final CostRecorder recorder;

    public StreamTokenUsageAdvisor(CostRecorder recorder) {
        this.recorder = recorder;
    }

    @Override
    public Flux<ChatClientResponse> adviseStream(ChatClientRequest request, StreamAdvisorChain chain) {
        AtomicReference<Usage> lastUsage = new AtomicReference<>();
        AtomicReference<String> modelName = new AtomicReference<>(UNKNOWN_MODEL);
        AtomicBoolean recorded = new AtomicBoolean(false);

        return chain.nextStream(request)
                .doOnNext(response -> {
                    ChatResponse chatResponse = response.chatResponse();
                    if (chatResponse == null) {
                        return;
                    }
                    String model = chatResponse.getMetadata().getModel();
                    if (model != null) {
                        modelName.set(model);
                    }
                    Usage usage = chatResponse.getMetadata().getUsage();
                    if (usage != null) {
                        lastUsage.set(usage);
                    }
                })
                .doFinally(signalType -> {
                    // 正常结束、报错、用户取消，这里都会执行，所以断流也能记上
                    if (recorded.compareAndSet(false, true)) {
                        Usage usage = lastUsage.get();
                        if (usage != null) {
                            recorder.record(tenantOf(request), modelName.get(), usage);
                        }
                    }
                });
    }

    private String tenantOf(ChatClientRequest request) {
        Object tenant = request.context().get(TokenUsageAdvisor.TENANT_KEY);
        return tenant == null ? DEFAULT_TENANT : tenant.toString();
    }

    @Override
    public String getName() {
        return "StreamTokenUsageAdvisor";
    }

    @Override
    public int getOrder() {
        return ORDER;
    }
}
```

`doFinally` 是关键。用 `doOnComplete` 的话，用户中途取消订阅就不会触发，那一笔就白花了。`doFinally` 在完成、报错、取消三种情况下都跑。

### 3.6 预算熔断

```java
package com.example.aitoken.advisor;

public class BudgetExceededException extends RuntimeException {

    private final String tenant;

    private final double spentUsd;

    private final double budgetUsd;

    public BudgetExceededException(String tenant, double spentUsd, double budgetUsd) {
        super("Tenant " + tenant + " exceeded daily budget: spent " + spentUsd + " USD, budget " + budgetUsd + " USD");
        this.tenant = tenant;
        this.spentUsd = spentUsd;
        this.budgetUsd = budgetUsd;
    }

    public String getTenant() {
        return tenant;
    }

    public double getSpentUsd() {
        return spentUsd;
    }

    public double getBudgetUsd() {
        return budgetUsd;
    }
}
```

```java
package com.example.aitoken.advisor;

import com.example.aitoken.cost.CostRecorder;
import com.example.aitoken.cost.ModelPriceProperties;

import org.springframework.ai.chat.client.ChatClientRequest;
import org.springframework.ai.chat.client.ChatClientResponse;
import org.springframework.ai.chat.client.advisor.api.CallAdvisor;
import org.springframework.ai.chat.client.advisor.api.CallAdvisorChain;
import org.springframework.core.Ordered;

public class BudgetGuardAdvisor implements CallAdvisor {

    /** 夹在工具循环（300）和计量（400）之间 */
    private static final int ORDER = Ordered.HIGHEST_PRECEDENCE + 390;

    private final CostRecorder recorder;

    private final ModelPriceProperties prices;

    public BudgetGuardAdvisor(CostRecorder recorder, ModelPriceProperties prices) {
        this.recorder = recorder;
        this.prices = prices;
    }

    @Override
    public ChatClientResponse adviseCall(ChatClientRequest request, CallAdvisorChain chain) {
        Object tenant = request.context().get(TokenUsageAdvisor.TENANT_KEY);
        String key = tenant == null ? "anonymous" : tenant.toString();

        double budget = prices.getDailyBudgetUsd();
        double spent = recorder.spentToday(key);
        if (spent >= budget) {
            throw new BudgetExceededException(key, spent, budget);
        }

        return chain.nextCall(request);
    }

    @Override
    public String getName() {
        return "BudgetGuardAdvisor";
    }

    @Override
    public int getOrder() {
        return ORDER;
    }
}
```

顺序值得说一句。熔断放在计量**外面**（390 小于 400），意味着这笔请求被拦下时不会产生任何 token 记录，因为它根本没发出去。放在里面就反了：先花钱再拒绝，毫无意义。

### 3.7 把它们装到 ChatClient 上

```java
package com.example.aitoken.config;

import com.example.aitoken.advisor.BudgetGuardAdvisor;
import com.example.aitoken.advisor.StreamTokenUsageAdvisor;
import com.example.aitoken.advisor.TokenUsageAdvisor;
import com.example.aitoken.cost.CostRecorder;
import com.example.aitoken.cost.ModelPriceProperties;

import org.springframework.ai.chat.client.ChatClient;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class AiClientConfig {

    @Bean
    public ChatClient chatClient(ChatClient.Builder builder, CostRecorder recorder, ModelPriceProperties prices) {
        return builder
                .defaultAdvisors(
                        new BudgetGuardAdvisor(recorder, prices),
                        new TokenUsageAdvisor(recorder),
                        new StreamTokenUsageAdvisor(recorder))
                .build();
    }
}
```

`defaultAdvisors` 是全局生效的，业务代码只要注入 `ChatClient` 用就行，不需要记得加什么。这就是 Advisor 相对「在每个 Service 里手写统计」最大的价值：**你不可能忘记**。

### 3.8 一个能跑的接口

```java
package com.example.aitoken.web;

import java.util.Map;

import com.example.aitoken.advisor.TokenUsageAdvisor;
import com.example.aitoken.cost.CostRecorder;
import reactor.core.publisher.Flux;

import org.springframework.ai.chat.client.ChatClient;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/chat")
public class ChatController {

    private final ChatClient chatClient;

    private final CostRecorder recorder;

    public ChatController(ChatClient chatClient, CostRecorder recorder) {
        this.chatClient = chatClient;
        this.recorder = recorder;
    }

    @GetMapping
    public Map<String, Object> chat(@RequestParam String tenant, @RequestParam String q) {
        String answer = chatClient.prompt()
                .user(q)
                .advisors(spec -> spec.param(TokenUsageAdvisor.TENANT_KEY, tenant))
                .call()
                .content();

        return Map.of(
                "answer", answer,
                "spentTodayUsd", recorder.spentToday(tenant));
    }

    @GetMapping("/stream")
    public Flux<String> stream(@RequestParam String tenant, @RequestParam String q) {
        return chatClient.prompt()
                .user(q)
                .advisors(spec -> spec.param(TokenUsageAdvisor.TENANT_KEY, tenant))
                .stream()
                .content();
    }
}
```

```java
package com.example.aitoken.web;

import com.example.aitoken.advisor.BudgetExceededException;

import org.springframework.http.HttpStatus;
import org.springframework.http.ProblemDetail;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

@RestControllerAdvice
public class GlobalExceptionHandler {

    @ExceptionHandler(BudgetExceededException.class)
    public ProblemDetail handleBudget(BudgetExceededException ex) {
        ProblemDetail detail = ProblemDetail.forStatusAndDetail(HttpStatus.TOO_MANY_REQUESTS, ex.getMessage());
        detail.setTitle("Daily budget exceeded");
        detail.setProperty("tenant", ex.getTenant());
        detail.setProperty("spentUsd", ex.getSpentUsd());
        detail.setProperty("budgetUsd", ex.getBudgetUsd());
        return detail;
    }
}
```

```java
package com.example.aitoken;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class AiTokenApplication {

    public static void main(String[] args) {
        SpringApplication.run(AiTokenApplication.class, args);
    }
}
```

跑起来之后：

```bash
curl "http://localhost:8080/chat?tenant=acme&q=用一句话解释什么是向量检索"
curl "http://localhost:8080/actuator/prometheus" | grep -E "ai_tokens|ai_cost"
```

Prometheus 里查当天各租户花销：

```promql
sum by (tenant) (increase(ai_cost_usd_total[1d]))
sum by (tenant, type) (increase(ai_tokens_total[1d]))
```

注意 Micrometer 的 counter 名称 `ai.cost.usd` 到 Prometheus 会变成 `ai_cost_usd_total`，点号转换规则别写错，查不到先看 `/actuator/metrics` 里的原始名字。

## 四、踩坑经验和最佳实践

**工具循环会让账单翻几倍，这是最容易被低估的一条。** 一个带三个工具的查询 Agent，用户提一个问题，模型可能被调四次：选工具 → 看结果再选 → 再选 → 出答案。每次调用都要把前面的完整历史重新发一遍，输入 token 滚雪球，总消耗是单轮问答的三到四倍。如果计量 Advisor 写在 `HIGHEST_PRECEDENCE + 300` 外面，你只会记到一次，然后误以为这个功能很便宜。

**流式没有 usage 时不要假装有。** 有些网关就是不返回 usage。这种情况下按字符数估算，用单独一个 tag 标 `source=estimated`。混在一起报，财务一问就穿帮。

**重试要单独打标。** 网关超时、SDK 自动重试，重试成功的那次照样计费，失败的请求多半不计费但你不能赌。给重试加一个 `retry=true` 的 tag，这样异常率高的模型一眼就能看出来——它不只是慢，它还在悄悄多花钱。

**不要用 userId 做 metric tag。** Prometheus 的标签基数是乘积关系，十万用户乘上几个模型，指标数量直接爆炸，最后把监控系统拖垮。租户、模型、功能名这种几十上百量级的维度放 metric，用户级明细落库（MySQL 或 ClickHouse），需要时再关联。

**多实例部署必须换共享存储。** 上面的 `DoubleAdder` 是单机内存，两台机器各算各的，熔断阈值实际翻倍。生产上换成 Redis，用 `INCRBYFLOAT` 加当日过期时间，或者写个 Lua 脚本做「读+判断+扣减」的原子操作。别用「先 GET 再 SET」，高并发下会放过超额请求。

**熔断要留余量，并且只管入口不管出口。** 单次请求的成本你事先不知道，所以预算检查是「花到 95% 就开始拒新请求」，而不是精确卡在 100%。还有一点：流式请求已经开始输出了，中途熔断只能掐断，用户会看到半句话。宁可让这一笔跑完，下一笔再拒。

**缓存命中的 token 必须单独算价。** 很多供应商对命中缓存的输入 token 收 10% 甚至更低。不区分的话，你会得出「RAG 太贵不能用」的错误结论，实际上贵的是没命中缓存的长上下文。

**价格表要有兜底。** 新模型上线、模型名带日期后缀、供应商改名，`priceOf` 一旦返回 null 就会 NPE。用默认单价兜底，并且把 `unknown` 模型名的记录单独看一遍，及时补价格。

## 五、性能对比和技术选型

四种做法的覆盖面和代价，摆在一起看：

| 方案 | 粒度 | 覆盖范围 | 延迟开销 | 落地成本 |
|---|---|---|---|---|
| Advisor 自埋点 | 每次模型调用，可带任意业务标签 | 只覆盖走 ChatClient 的调用 | 微秒级，纯内存计数 | 一个下午 |
| Micrometer + OpenTelemetry 自动观测 | 调用级，含 span 和标准 gen_ai 属性 | 同上，但维度受标准约束 | 微秒级 | 半天，需要接 tracing 后端 |
| 网关代理（自建或商业 LLM Gateway） | 请求级，按 key 统计 | 覆盖所有语言、所有客户端 | 多一跳网络 | 一周起，还要维护 |
| 供应商后台账单 | 天级总数 | 全部，但是黑盒 | 无 | 零，但基本没用 |

我的建议是**两层一起上**：Advisor 自埋点做业务维度（谁花的、哪个功能花的、超没超预算），这是唯一能拿到租户和功能标签的地方；OpenTelemetry 那套自动观测做技术维度（哪次调用慢、哪个 span 失败），排查问题用。

网关代理适合多语言、多团队共用一个 key 的组织。如果你们全栈 Java、只有一个 ChatClient 入口，为统计单独架一套网关是自找麻烦。

供应商账单只用来对账。每个月拿它对一次自家统计的总数，差超过 10% 就说明有调用绕过了 ChatClient（比如有人直接 new 了个 RestTemplate 调 API），那时候再去堵漏。

## 六、总结

这件事的难点不在代码，在于找对位置。

token 数字是供应商给的，不是算的；成本是乘出来的，不是猜的。真正要动脑子的地方是：把计量挂在 Advisor 链上，order 落在工具循环里面（大于 300），同步和流式各注册一个，租户信息走 Advisor 上下文而不是 ThreadLocal。

按这个结构做完，你能回答的问题会从「这个月花了 412 美元」变成「租户 acme 今天花了 3.2 美元，其中 78% 是 RAG 上下文，模型是 gpt-4o」。后者才是能拿去做决策的数字。

顺带一个副作用：预算熔断加上之后，那些「Agent 死循环跑了 200 轮」的事故会自己停下来。省钱是次要的，主要是保命。

## 参考资料

- [Spring AI - Advisors API](https://docs.spring.io/spring-ai/reference/api/advisors.html)
- [Spring AI - Observability](https://docs.spring.io/spring-ai/reference/observability/index.html)
- [Micrometer - Concepts](https://docs.micrometer.io/micrometer/reference/concepts.html)
- [OpenTelemetry - Generative AI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/)

文 / 会编程的吕洞宾
