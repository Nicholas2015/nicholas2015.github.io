---
title: "Spring AI 工具搜索：Token 直降一半"
date: 2026-10-17T20:00:00+08:00
category: "AI"
tags: ["AI", "spring-ai"]
---

**摘要：** 工具一多，模型每轮请求都要先读一遍全部工具的 JSON Schema，5 万 token 说没就没，检索还容易选错工具。Spring AI 2.0 内置的 Tool Search Tool 改成「按需检索」：模型自己用一句人话搜工具，命中哪几个才把定义塞进上下文。本文讲清原理，附三套可跑代码：属性开关起步、语义向量检索、多租户会话隔离。

> 上线第一版 AI 助手时，只有三个工具，用得很舒服。半年后接了三个 MCP server，加上内部的订单、库存、财务、工单接口，一共 60 多个工具。问题来了：每次请求发给模型的工具定义就三万多 token，用户问「订单能不能退」，模型挑了个「创建工单」的工具。更要命的是，工具越多，上下文留给真实对话的空间越小。这篇文章解决的就是这件事——工具多到装不下的时候，怎么让模型只拿到它这轮真正需要的工具。

## 一、这个问题到底是什么

结论：工具不是越多越好，把全量工具定义塞进每一轮请求，既烧钱又降准。

先说清楚「工具定义」是什么。你用 `@Tool` 注解一个 Java 方法，Spring AI 会把它翻译成一段 JSON Schema——方法名、参数类型、参数说明、必填与否。这段 Schema 会跟着**每一次**请求发给大模型，因为模型只有看到定义，才知道能调用什么。

问题就出在「每一次」。工具少的时候无所谓；工具多了，工具定义会撑爆上下文：

- 官方文档给的量级：一个典型的多 MCP server 环境轻松聚合 50 个以上工具，在任何对话开始之前就要消耗 55,000+ token。
- 选择准确率也会塌。模型面对 30 个以上名字相近的工具时，选错工具的概率明显上升。

这两件事是连在一起的。你为了覆盖更多场景不断加工具，加到最后模型看不懂工具清单了，token 账单也先炸了。

再看一个常见误区。很多人以为可以靠「精简工具描述」解决，把 description 写短一点。能省，但省的是线性的一点点，治不了根：只要还是全量下发，工具数量翻倍，token 就翻倍。

真正的问题是下发策略——**默认策略是「全量下发」，而大部分对话其实只用到其中两三个工具**。

Spring AI 2.0 给了一个内置方案：Tool Search Tool，中文可以叫「工具搜索」。它把下发策略换成渐进式的：模型先看到一个「搜索工具」的工具，用自然语言描述自己需要什么能力，系统检索出相关工具，再把它们的定义补进上下文。没被检索到的工具，这一轮根本不出现在请求里。

适用范围（官方给的判断标准）：

| 情况 | 建议 |
| --- | --- |
| 注册 10 个以上工具 | 值得开 |
| 工具定义每轮吃掉 10K+ token | 值得开 |
| 多 MCP server 聚合出的大工具库 | 强烈建议开 |
| 工具经常选错、认不出该用哪个 | 值得开 |
| 工具不到 10 个，且每个都常用 | 别开，白增延迟 |
| 工具定义本来就极短 | 别开，省下的 token 抵不过多一轮往返 |

## 二、底层原理到底怎么回事

结论：Tool Search Tool 是一个「替换掉默认工具调用顾问」的 Advisor，它把工具定义从「全量预加载」改成「按需检索 + 逐步暴露」。

先看默认路径。Spring AI 的 ChatClient 在发起请求前，会把所有注册的工具定义拼进请求，模型返回「我要调用 X 工具」，框架执行，结果回填，模型再给答案。工具定义是**一次性全部付出**的。

Tool Search Tool 的路径分成两步：索引和检索。

**索引**：会话开始时，所有注册的工具被登记进一个 `ToolIndex`。注意，是登记进本地索引，不是发给模型。

**检索**：第一轮请求发给模型的内容里，只有一个内置工具 `toolSearchTool` 的定义。模型需要能力时，调用 `toolSearchTool`，参数是一句人话，比如「我想查订单的退款状态」。索引按这句话找出匹配的工具，把它们的定义追加到下一轮请求里。模型拿到定义后，再像平常一样发起真正的工具调用。

完整的运行时流程是这样：

1. **索引**：会话开始，全部工具注册进配置好的 `ToolIndex`，一条定义都不发给模型。
2. **首次请求**：请求里只有内置的 `toolSearchTool` 定义。
3. **检索调用**：模型描述它需要什么能力，调用 `toolSearchTool`。
4. **搜索并展开**：`ToolIndex` 找出匹配工具，把它们的方法定义追加进会话。
5. **工具调用**：模型带着已经拿到的定义，发起一次普通工具调用。
6. **执行**：`ToolCallingManager` 执行被发现的工具，把结果返回。
7. **生成回答**：模型基于工具结果给出最终答案。

打个比方。默认路径像是每次开会前，把仓库里 60 种零件的说明书全部复印一份发给每个人；Tool Search Tool 像是仓库管理员站在旁边，你说「我要拧六角螺丝的扳手」，他才把那一页递给你。会议室里不再堆满没人看的说明书。

### ToolIndex：检索策略是可插拔的

`ToolIndex` 是个接口，只有四个方法，索引和检索都按会话 ID 隔离：

```java
public interface ToolIndex {
    void indexTool(String sessionId, ToolReference toolReference);
    void indexTools(String sessionId, List<ToolReference> toolReferences);
    ToolSearchResponse search(ToolSearchRequest request);
    void clearIndex(String sessionId);
}
```

官方自带三种实现，按检索方式区分：

- **RegexToolIndex**：按工具名跑正则。零依赖，是默认策略。工具名有规范（比如 `get_*`、`query_*`）时好用。
- **LuceneToolIndex**：用 Apache Lucene 做关键词检索。starter 里已经内置了 Lucene，不用额外加依赖；默认最低得分阈值 0.25，低于阈值的命中会被静默丢掉。
- **VectorToolIndex**：把工具名和描述做向量，检索时把模型给的自然语言查询也做向量，取最相似的几个。模型「描述需求」而不是「点名工具」时最合适，代价是需要一个 `VectorStore`，另外多出 embedding 调用。

三种策略的细节对比放到第五节。

### 会话隔离与索引回收

索引是**按会话存在内存里的**。会话 ID 决定这次请求能看见哪个索引——这一点顺带解决了两件事：

- **多租户隔离**：不同租户的工具集天然分开，A 公司检索不到 B 公司的工具。
- **多轮对话一致**：同一会话里，上一轮搜出来的工具名会累积注入（`referenceToolNameAccumulation` 默认 `true`），避免模型每轮都重新搜一遍。

调用方**每次请求都必须传会话 ID**。默认从 advisor context 里读 `ChatMemory.CONVERSATION_ID` 这个 key。如果你的应用本来就在传 `tenantId` 或 `userId`，可以改 `sessionIdKeyName("tenantId")` 指向它；如果已经配了记忆顾问，会话 ID 本来就在上下文里，等于白拿。

内存不能无限涨，所以有驱逐策略。默认是 `LruEvictionStrategy(1000)`：最多保留 1000 个活跃会话，超了就淘汰最久没用的。驱逐是**懒评估**的，每次请求时判断一次，不需要后台线程。想主动清理（比如用户登出）就调 `advisor.evictSession(sessionId)`。

## 三、实战：手把手写代码

三个例子，从最省事到最灵活。都用 Java 21、Spring Boot 4.1.1、Spring AI 2.0.1。

### 例子一：一个属性开关，先跑起来

默认的 regex 策略零额外依赖，最适合先验证效果。先看依赖：

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
    <artifactId>tool-search-demo</artifactId>
    <version>1.0.0</version>

    <properties>
        <java.version>21</java.version>
    </properties>

    <dependencies>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter</artifactId>
            <version>4.1.1</version>
        </dependency>

        <!-- 聊天模型 -->
        <dependency>
            <groupId>org.springframework.ai</groupId>
            <artifactId>spring-ai-starter-model-openai</artifactId>
            <version>2.0.1</version>
        </dependency>

        <!-- 工具搜索：内含 auto-configuration 和 Lucene -->
        <dependency>
            <groupId>org.springframework.ai</groupId>
            <artifactId>spring-ai-starter-tool-search-advisor</artifactId>
            <version>2.0.1</version>
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
</project>
```

这份 pom 里的版本号都写全了，照抄能跑。`spring-ai-starter-tool-search-advisor` 已经把 Lucene 带进来了，所以后面切关键词策略也不用再加依赖。

配置只有这几行：

```yaml
spring:
  ai:
    openai:
      api-key: ${OPENAI_API_KEY}
    chat:
      client:
        tool-search-advisor:
          enabled: true
          tool-index-type: regex
          max-results: 5
```

`enabled: true` 做了两件事：注册一个 `ToolSearchToolCallingAdvisor.Builder`，靠 `@ConditionalOnMissingBean` 顶掉默认的工具调用顾问；同时注册一个 `ToolIndex` bean，类型按 `tool-index-type` 选。整个 ChatClient 不用改一行代码。

接着写工具。下面这个类有订单相关能力，第二个类放库存相关能力——两个类一起注册，凑出一个「工具库」的感觉：

```java
package com.example.toolsearch;

import org.springframework.ai.tool.annotation.Tool;
import org.springframework.ai.tool.annotation.ToolParam;
import org.springframework.stereotype.Component;

@Component
public class OrderTools {

    @Tool(description = "根据订单号查询订单状态，返回待支付、已发货、已完成、已取消之一")
    public String queryOrderStatus(
            @ToolParam(description = "订单号，格式如 SO202610170001") String orderNo) {
        if ("SO202610170001".equals(orderNo)) {
            return "已发货";
        }
        return "已完成";
    }

    @Tool(description = "为指定订单创建退款申请，返回退款单号")
    public String createRefund(
            @ToolParam(description = "订单号") String orderNo,
            @ToolParam(description = "退款原因，用户原话即可") String reason) {
        return "RF" + orderNo.substring(2) + "-001";
    }

    @Tool(description = "查询某个用户的全部订单列表")
    public String listOrdersByUser(
            @ToolParam(description = "用户 ID") String userId) {
        return "共 2 笔订单";
    }
}
```

```java
package com.example.toolsearch;

import org.springframework.ai.tool.annotation.Tool;
import org.springframework.ai.tool.annotation.ToolParam;
import org.springframework.stereotype.Component;

@Component
public class InventoryTools {

    @Tool(description = "查询某个商品在某个仓库的可售库存数量")
    public String queryStock(
            @ToolParam(description = "商品 SKU 编码") String sku,
            @ToolParam(description = "仓库编码，例如 SH01") String warehouseCode) {
        return "可售 128 件";
    }

    @Tool(description = "查询商品是否参与当前促销活动")
    public String queryPromotion(
            @ToolParam(description = "商品 SKU 编码") String sku) {
        return "参与满减活动，满 300 减 50";
    }
}
```

`description` 是关键：模型就是靠它判断该不该搜、搜哪个。写成一整句话、把「什么时候用」说清楚，比只写「查询订单」有效得多。

最后是启动类，把工具注册进去，并在请求里带上会话 ID：

```java
package com.example.toolsearch;

import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.memory.ChatMemory;
import org.springframework.boot.CommandLineRunner;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class ToolSearchDemoApplication implements CommandLineRunner {

    private final ChatClient chatClient;

    public ToolSearchDemoApplication(ChatClient.Builder builder,
                                     OrderTools orderTools,
                                     InventoryTools inventoryTools) {
        this.chatClient = builder
                .defaultTools(orderTools, inventoryTools)
                .build();
    }

    @Override
    public void run(String... args) {
        String answer = chatClient.prompt("订单 SO202610170001 现在什么状态？还能退吗？")
                .advisors(a -> a.param(ChatMemory.CONVERSATION_ID, "user-42-session"))
                .call()
                .content();
        System.out.println(answer);
    }

    public static void main(String[] args) {
        SpringApplication.run(ToolSearchDemoApplication.class, args);
    }
}
```

`.advisors(a -> a.param(ChatMemory.CONVERSATION_ID, "..."))` 这行不能省。工具索引是按会话存的，不给会话 ID，advisor 定位不到索引，会话隔离也就无从谈起。

跑起来后看日志，会多出一轮工具调用：模型先调 `toolSearchTool`，参数是类似「订单状态查询、退款」的搜索词，然后才调用 `queryOrderStatus`。工具定义只在这之后才进入请求。

### 例子二：改成语义检索

regex 是按工具名匹配的，模型说「帮用户查一下买的货到哪了」，它匹配不到 `queryOrderStatus` 这个名字。想让模型「描述需求」也能搜到，就得换向量。

加一个向量库依赖。这里用 Redis（已经在跑 Redis Stack 的话最省事）：

```xml
<dependency>
    <groupId>org.springframework.ai</groupId>
    <artifactId>spring-ai-starter-vector-store-redis</artifactId>
    <version>2.0.1</version>
</dependency>
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-data-redis</artifactId>
    <version>4.1.1</version>
</dependency>
```

配置里把策略改成 `vector`，再配一下 Redis 地址：

```yaml
spring:
  data:
    redis:
      host: localhost
      port: 6379
  ai:
    openai:
      api-key: ${OPENAI_API_KEY}
    chat:
      client:
        tool-search-advisor:
          enabled: true
          tool-index-type: vector
```

`spring-ai-starter-model-openai` 会自动配一个 embedding 模型和一个 `VectorStore` bean，`VectorToolIndex` 直接用。如果不想用自动配置的，也可以自己声明一个：

```java
package com.example.toolsearch;

import org.springframework.ai.tool.toolsearch.ToolIndex;
import org.springframework.ai.tool.toolsearch.index.vectorstore.VectorToolIndex;
import org.springframework.ai.vectorstore.VectorStore;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class ToolSearchVectorConfig {

    @Bean
    public ToolIndex vectorToolIndex(VectorStore vectorStore) {
        return new VectorToolIndex(vectorStore);
    }
}
```

自己声明 `ToolIndex` bean 时，自动配置会因为 `@ConditionalOnMissingBean` 让路，不会重复注册——所以 `tool-index-type` 这时其实可以不写，行为以你的 bean 为准。

代价要记住：索引阶段每个工具名加描述做一次 embedding，每次搜索再对查询做一次 embedding。工具库不大时这笔开销可以忽略；工具几百个、还频繁新建索引，就要算一算。

### 例子三：手动装配 + 多租户 + 驱逐策略

不想用自动配置，或者要按租户隔离、按 TTL 回收索引，就手动装配。这里用 Lucene 关键词检索（starter 里已带依赖），把会话 ID 的 key 换成 `tenantId`，并给索引加上过期时间：

```java
package com.example.toolsearch;

import java.time.Duration;

import org.springframework.ai.chat.client.advisor.toolsearch.ToolSearchToolCallingAdvisor;
import org.springframework.ai.tool.toolsearch.ToolIndex;
import org.springframework.ai.tool.toolsearch.eviction.CompositeEvictionStrategy;
import org.springframework.ai.tool.toolsearch.eviction.LruEvictionStrategy;
import org.springframework.ai.tool.toolsearch.eviction.TtlEvictionStrategy;
import org.springframework.ai.tool.toolsearch.index.lucene.LuceneToolIndex;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class ToolSearchManualConfig {

    @Bean
    public ToolIndex luceneToolIndex() {
        // 0.4f 是匹配得分下限，比默认的 0.25 更严格，工具多时能压掉噪音命中
        return new LuceneToolIndex(0.4f);
    }

    @Bean
    public ToolSearchToolCallingAdvisor toolSearchAdvisor(ToolIndex luceneToolIndex) {
        return ToolSearchToolCallingAdvisor.builder()
                .toolIndex(luceneToolIndex)
                .maxResults(5)
                .sessionIdKeyName("tenantId")
                .evictionStrategy(new CompositeEvictionStrategy(
                        new TtlEvictionStrategy(Duration.ofMinutes(30)),
                        new LruEvictionStrategy(200)))
                .build();
    }
}
```

然后在需要的地方挂上去，请求时传租户 ID：

```java
package com.example.toolsearch;

import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.client.advisor.toolsearch.ToolSearchToolCallingAdvisor;
import org.springframework.ai.chat.model.ChatModel;
import org.springframework.stereotype.Service;

@Service
public class AssistantService {

    private final ChatClient chatClient;
    private final ToolSearchToolCallingAdvisor toolSearchAdvisor;

    public AssistantService(ChatModel chatModel,
                            OrderTools orderTools,
                            InventoryTools inventoryTools,
                            ToolSearchToolCallingAdvisor toolSearchAdvisor) {
        this.toolSearchAdvisor = toolSearchAdvisor;
        this.chatClient = ChatClient.builder(chatModel)
                .defaultTools(orderTools, inventoryTools)
                .defaultAdvisors(toolSearchAdvisor)
                .build();
    }

    public String ask(String tenantId, String question) {
        return chatClient.prompt()
                .user(question)
                .advisors(a -> a.param("tenantId", tenantId))
                .call()
                .content();
    }

    /** 用户登出或租户下线时主动释放索引，别等 LRU 慢慢淘汰 */
    public void releaseTenant(String tenantId) {
        toolSearchAdvisor.evictSession(tenantId);
    }
}
```

三个细节：手动装配时**不要再开** `spring.ai.chat.client.tool-search-advisor.enabled`，否则两套顾问都在，工具会被注册两遍。`sessionIdKeyName("tenantId")` 之后，请求里就必须给 `tenantId`，不给就定位不到索引。`evictSession` 是主动回收的出口，适合登出、租户删除这类明确时机。

## 四、踩坑经验和最佳实践

**每次请求都要带会话 ID，而且 key 要对得上。** 默认 key 是 `ChatMemory.CONVERSATION_ID`；一旦改了 `sessionIdKeyName`，请求里的参数名就得跟着改。忘了传，索引找不到，整个方案退化成「模型看不见任何工具」。

**工具名和描述是检索质量的地基。** regex 策略只看工具名，名字乱起（`doIt`、`f1`）基本搜不到；Lucene 和向量都吃 description，写清「什么时候用、输入长什么样」收益最大。工具名统一成 `query_*`、`create_*`、`get_*` 这种前缀，regex 策略的命中率会明显好看。

**maxResults 别拍脑袋。** 设太大，省下的 token 又塞回去了；设太小，模型搜不到需要的工具，只能瞎猜。5 到 10 起步调，观察日志里「模型搜了什么、命中什么」再定。不设（`null`）就让模型自己决定数量。

**工具少就别开。** 少于 10 个工具时，多出来的搜索往返会实打实增加延迟和一次额外的模型调用，得不偿失。这个功能是为「大工具库」准备的。

**Lucene 的阈值会静默丢结果。** 默认 0.25，调高到 0.4 更干净，但太低分的命中会被直接扔掉，表现是「模型搜了，但没搜到」。搜不到时先降阈值排查。

**索引在内存里，SaaS 场景必须配驱逐。** 默认 LRU 上限 1000 会话，租户多、长尾会话多的时候按需换成 `TtlEvictionStrategy`，或者用 `CompositeEvictionStrategy` 组合 TTL 和 LRU。明确的下线动作可以直接 `evictSession`，不用等淘汰。

**索引生命周期与会话绑定，测试时反而要对抗这一点。** 工具集每轮都在变的场景（比如动态注册）用 `AlwaysEvictStrategy.INSTANCE`，每轮请求前清空重建，行为最可预测；生产别这么干。

**不要为了「以后可能用到」把工具全注册上。** 注册进去的工具都会参与索引，用不上的工具只会稀释检索结果。按业务域拆工具类，按需注册。

## 五、性能对比和技术选型

三种检索策略怎么选，看这几个维度：

| 策略 | 依赖 | 检索方式 | 额外成本 | 适合场景 |
| --- | --- | --- | --- | --- |
| `RegexToolIndex` | 无（默认） | 工具名正则 | 无 | 工具命名规范、模型习惯点名工具 |
| `LuceneToolIndex` | Lucene（starter 自带） | 关键词打分 | 建索引开销 | 术语固定、要求快且稳定 |
| `VectorToolIndex` | 一个 `VectorStore` + embedding 模型 | 向量相似度 | 每个工具一次 embedding + 每次搜索一次 | 模型用自然语言描述需求 |

跟默认全量下发的对比更值得看：

- **Token**：官方在不同模型上的基准显示，工具 token 降低 34%–64%。工具库越大、越冷门，降幅越明显；如果只有几个工具且每个都用，反而会多出一次搜索往返。
- **延迟**：多一轮「搜索工具 → 拿到定义 → 再调用」的往返，首字延迟会上升。命中准的前提下，这轮往返换来的是更短的请求体，整体通常在几十毫秒到几百毫秒量级。
- **准确率**：工具多、名字相近时，先搜后用比全量硬塞更准。模型不需要在一堆相似定义里挑，只需要检索出两三条候选。

我的选型建议：工具数在 10 到 30 之间、命名规范，直接用默认 regex，零成本、零依赖；工具描述质量参差、模型经常「描述需求」而不是点名工具，上 vector；需要极稳定可控的命中行为又不想要 embedding 开销，选 lucene。别一上来就 vector——embedding 是额外的钱和延迟，先跑 regex 收集日志，命中率不行再换。

## 六、总结

工具搜索解决的是一个很具体的账：工具定义在每轮请求里重复付费，而且工具越多、模型越挑不准。Spring AI 的做法是换下发策略——索引留在本地，模型按需用一句人话把工具「搜」进上下文。

落地只要三件事：把 `spring-ai-starter-tool-search-advisor` 加进来，打开 `enabled`，每次请求带上会话 ID。想让检索更聪明就把策略切到 vector，想要多租户隔离和索引回收就手动装配 advisor 和驱逐策略。

判断要不要开，就问自己一句：我的每轮请求里，有多少工具定义是这一轮根本用不到的？答案超过一半，这功能就值得上。反过来，工具只有五六个，别加，纯属给自己找麻烦。

文 / 会编程的吕洞宾

## 参考资料

- [Tool Search Tool :: Spring AI Reference](https://docs.spring.io/spring-ai/reference/api/tools/tool-search-tool.html)
- [Tool Calling :: Spring AI Reference](https://docs.spring.io/spring-ai/reference/api/tools.html)
- [ToolCallingAdvisor :: Spring AI Reference](https://docs.spring.io/spring-ai/reference/api/tools/tool-calling-advisor.html)
- [Dynamic Tool Discovery :: Spring AI Guide](https://docs.spring.io/spring-ai/reference/guides/dynamic-tool-search.html)
- [Chat Client API :: Spring AI Reference](https://docs.spring.io/spring-ai/reference/api/chatclient.html)
