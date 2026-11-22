---
title: 大模型重复回答白烧钱_Java语义缓存接进来
date: 2026-11-22 12:07:24
tags: ["AI", "Java", "LangChain4j", "Redis"]
categories: ai
---

# 大模型重复回答白烧钱_Java语义缓存接进来

> 客服助手、内部知识库问答，上线第一周看着很爽，第二周账单开始难看。翻日志你会发现一件很蠢的事：用户问来问去就那么几十个问题，只是说法不一样——「怎么开发票」和「发票在哪开」在你眼里是同一句，在大模型眼里是两个请求，两份钱。精确缓存救不了这种场景，因为字符串对不上。这篇讲怎么用一套语义缓存把这类重复请求拦在大模型之前，代码全部用 Java 写，不引向量数据库，一个普通 Redis 就够。

## 一、这个问题到底是什么

先把账拆开看。

一个线上 AI 问答服务，请求大概分三类：

- 完全重复：同一句话被反复问，比如「你们几点上班」。这类精确缓存就能拦。
- 换说法重复：意思一样，字面不同。占比往往最大，精确缓存全部漏掉。
- 真新问题：确实没答过，必须调模型。

第二类最要命。它既浪费钱，又浪费延迟——用户多等两秒，只为了拿到一段半个月前就生成过的答案。

### 精确缓存为什么在这里失效

大多数团队第一版缓存是这么写的：把问题原文当 key，答案当 value，塞进 Redis。

```java
String key = "qa:" + question;
String cached = redis.opsForValue().get(key);
```

这段代码在真实流量里命中率低得可怜。用户会干这些事：

- 加语气词：「请问怎么开发票」「怎么开发票呢」「开发票怎么弄呀」
- 换语序：「发票怎么开」vs「怎么开发票」
- 换同义词：「退款」vs「退钱」vs「申请退费」
- 复制粘贴时带上前后的空格、标点、换行

每一种都让 key 变化。字符串哈希是零容错的，差一个字符就是缓存未命中。

### 语义缓存换了个找法

语义缓存不比对字符串，比对**意思**。做法是把问题转成一串数字（向量），意思越接近，两串数字在空间里的方向就越接近。找缓存时不去查「有没有一模一样的问题」，而是问「有没有意思最接近的问题」。

打个比方：精确缓存是按书名找书，书名差一个字就找不到；语义缓存是按内容找书，你说「那本讲明朝末年财政的书」，管理员也能给你抱出来。

一句话概括：**语义缓存 = 用 embedding 做 key 的缓存，命中判断从「相等」变成「够不够像」。**

### 它和 RAG 不是一回事

这两个概念经常被混在一起，其实目标相反：

| | RAG | 语义缓存 |
|---|---|---|
| 找什么 | 找资料（文档片段） | 找以前生成的答案 |
| 命中后干什么 | 把资料塞进 prompt 让模型重新答 | 直接返回旧答案，不调模型 |
| 省的是什么 | 省不了钱，反而多花（资料也占 token） | 省模型调用费和延迟 |
| 出错代价 | 答案质量下降 | 答案直接给错人 |

最后一行是关键。RAG 检索偏了，模型还有机会靠自己的知识兜一下；语义缓存命中错了，用户拿到的是另一个问题的答案，没有任何兜底。所以这套东西的难点不在「怎么算相似度」，在**怎么保证不该命中的时候绝不命中**。

后面第二节讲原理，第三节上代码，第四节全是我踩过的坑。

## 二、底层原理到底怎么回事

### 向量和余弦相似度

embedding 模型把一句话压成一个定长数组，比如 1536 个 float。这串数字编码的是语义，不是字面。

判断两句话像不像，用**余弦相似度**：看两个向量夹角。夹角 0 度（方向完全一致）得 1，垂直得 0，反向得 -1。文本 embedding 的相似度基本落在 0.5 到 1 之间。

余弦的公式是点积除以两个向量的长度乘积：

```
cos(A, B) = (A · B) / (|A| × |B|)
```

工程上一个常用化简：**写入时就把向量归一化成单位长度**（长度 = 1）。这样 `|A| = |B| = 1`，公式退化成一次点积：

```
cos(A, B) = A · B
```

1024 维的向量做一次点积就是 1024 次乘加。现代 CPU 上这连微秒都不到。这个化简让「在 Java 里暴力扫一遍候选集」变成一个完全可接受的选择——这也是我不引向量数据库的底气。

### 一次请求的完整链路

真正的判断顺序是这样，从便宜到贵：

1. **精确缓存**：问题原文哈希，命中直接返回。零风险，先挡一层。
2. **算 embedding**：一次 embedding 调用，几十毫秒，费用约为对话模型的千分之几。这一步省不掉。
3. **取候选**：从 Redis 里取出这个租户最近的 N 条缓存向量，逐条算相似度，排序。
4. **阈值过滤**：相似度低于阈值，直接当没命中。
5. **硬信息校验**：型号、版本、数字必须完全一致（下一小节展开）。
6. **全过了才复用答案**；任何一关不过，老老实实调模型，然后把新答案写回缓存。

注意第 5 步。这是整篇文章最值钱的一段。

### 相似度天然会骗人

「iPhone 15 的电池多大」和「iPhone 16 的电池多大」，embedding 相似度通常在 0.96 以上。它们讨论的是同一件事，句式、实体类型、上下文全部一致，只差一个数字。

但答案完全不同。你要是只信阈值，这类问题会稳定地返回错误答案，而且用户很难发现——因为答案读起来非常合理。

同类陷阱还有：

- 「Spring Boot 3 怎么升级」vs「Spring Boot 4 怎么升级」
- 「退款 7 天规则」vs「退款 15 天规则」
- 「A 套餐多少钱」vs「B 套餐多少钱」

结论：**阈值只能过滤「不像」，过滤不了「像但不对」。**必须再叠一层硬信息比对。

我的做法是抽硬 token：所有带数字的串（`15`、`3.5`、`iphone15`）和大写字母代号（`VIP`、`SKU`），两句话的集合必须完全相等，否则判为不同问题。宁可多调一次模型，不可答错一次。

### 为什么阈值不能拍脑袋定

不同 embedding 模型的相似度分布差别很大。同一个 0.9：

- 在 OpenAI 的 `text-embedding-3-small` 上，可能只是「都跟退款有关」
- 在 bge-m3 上，可能已经是「同一个意思的两种说法」

所以阈值不能抄别人的数字。正确做法是拿你自己业务里 50 对「应该命中」和 50 对「不该命中」的问题，跑一遍打分，看两堆分布的间隙落在哪。第三节我给了一个探测接口，就是干这个用的。

经验值：语义缓存阈值一般落在 0.90 到 0.96。低于 0.90 容易串味，高于 0.96 命中率惨淡。起点建议 0.94，然后按实测调。

### 存储：为什么小规模不需要向量数据库

2000 条缓存，每条 1024 维 float：

- 每次查询取出 2000 个向量：约 8 MB 网络传输
- 本地算 2000 次点积：200 万次乘加，几毫秒

这个量级用 Redis 的普通 String + ZSet 就够，不需要 RediSearch 的 KNN 索引，也不需要 Milvus。省掉一个中间件的运维成本。

什么时候该换：

- 缓存条目稳定超过 1 万条
- 查询 QPS 高到「每次全量拉取」的网络开销顶不住
- 需要多副本共享、按元数据过滤

到那时候再上 RediSearch 的 HNSW 索引或者 Milvus，成本才划算。过早引入，你只是给自己加了一个要监控、要备份、要升级的组件。

### 一致性：三个必须想清楚的点

**第一，embedding 模型换了必须清缓存。** 不同模型产出的向量不在同一个空间里，混着算相似度全是垃圾。所以缓存 key 里要带模型名。

**第二，答案有时效。** 价格、政策、活动这类答案必须短 TTL，甚至不缓存。我的建议是给缓存加一个「答案类型」标记，动态内容 1 小时，静态文档类 7 天。

**第三，多租户隔离。** 缓存 key 必须带租户前缀。这不是性能问题，是会出事故的安全问题——A 公司看到 B 公司的内部答案，一次就够上新闻了。

## 三、实战：手把手写代码

下面这套代码可以完整跑起来。前置条件只有两个：一个 Redis，一个兼容 OpenAI 协议的模型服务（官方 API 或者 vLLM、Ollama 都行）。

### 3.1 依赖和配置

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
    <artifactId>semantic-cache-demo</artifactId>
    <version>1.0.0</version>

    <properties>
        <java.version>21</java.version>
    </properties>

    <dependencies>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-web</artifactId>
            <version>4.2.0</version>
        </dependency>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-data-redis</artifactId>
            <version>4.2.0</version>
        </dependency>
        <dependency>
            <groupId>dev.langchain4j</groupId>
            <artifactId>langchain4j-open-ai</artifactId>
            <version>1.24.0</version>
        </dependency>
        <dependency>
            <groupId>dev.langchain4j</groupId>
            <artifactId>langchain4j-http-client-jdk</artifactId>
            <version>1.24.0</version>
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

`langchain4j-http-client-jdk` 是显式写出来的。LangChain4j 把 HTTP 客户端拆成了独立模块，不显式引入的话，启动时可能报「找不到 HttpClientBuilder」，排查起来很烦。

配置文件：

```yaml
server:
  port: 8080

spring:
  data:
    redis:
      host: localhost
      port: 6379

semantic-cache:
  namespace: demo
  ttl: 6h
  max-entries: 2000
  top-k: 3
  min-score: 0.94
  embedding:
    base-url: https://api.openai.com/v1
    api-key: ${OPENAI_API_KEY}
    model: text-embedding-3-small
  chat:
    base-url: https://api.openai.com/v1
    api-key: ${OPENAI_API_KEY}
    model: gpt-4o-mini
```

`min-score` 和 `top-k` 是调参入口，不用改代码。

### 3.2 配置类和 Bean

```java
package com.example.semcache.config;

import java.time.Duration;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.data.redis.core.StringRedisTemplate;

import com.example.semcache.cache.RedisSemanticCache;

import dev.langchain4j.model.chat.ChatModel;
import dev.langchain4j.model.embedding.EmbeddingModel;
import dev.langchain4j.model.openai.OpenAiChatModel;
import dev.langchain4j.model.openai.OpenAiEmbeddingModel;

@Configuration
@EnableConfigurationProperties(SemanticCacheProperties.class)
public class SemanticCacheConfig {

    @Bean
    public ChatModel chatModel(SemanticCacheProperties properties) {
        return OpenAiChatModel.builder()
                .baseUrl(properties.chat().baseUrl())
                .apiKey(properties.chat().apiKey())
                .modelName(properties.chat().model())
                .temperature(0.0)
                .timeout(Duration.ofSeconds(60))
                .maxRetries(1)
                .build();
    }

    @Bean
    public EmbeddingModel embeddingModel(SemanticCacheProperties properties) {
        return OpenAiEmbeddingModel.builder()
                .baseUrl(properties.embedding().baseUrl())
                .apiKey(properties.embedding().apiKey())
                .modelName(properties.embedding().model())
                .timeout(Duration.ofSeconds(30))
                .maxRetries(1)
                .build();
    }

    @Bean
    public RedisSemanticCache semanticCache(StringRedisTemplate redisTemplate,
                                            SemanticCacheProperties properties) {
        return new RedisSemanticCache(redisTemplate, properties.maxEntries(), properties.ttl());
    }
}
```

```java
package com.example.semcache.config;

import java.time.Duration;

import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties(prefix = "semantic-cache")
public record SemanticCacheProperties(
        String namespace,
        Duration ttl,
        int maxEntries,
        int topK,
        double minScore,
        Endpoint embedding,
        Endpoint chat) {

    public record Endpoint(String baseUrl, String apiKey, String model) {
    }
}
```

`temperature` 设成 0.0 是我故意的。缓存场景下同一问题应该有稳定答案，温度高会让同一句话在不同时间吐出不同内容，缓存的价值直接打对折。

### 3.3 向量工具和硬信息校验

```java
package com.example.semcache.cache;

import java.nio.ByteBuffer;
import java.util.Base64;

public final class VectorCodec {

    private VectorCodec() {
    }

    /**
     * 归一化之后，余弦相似度就等于点积，省掉一次开方和一次除法。
     */
    public static float[] normalize(float[] raw) {
        double sum = 0.0;
        for (float value : raw) {
            sum += value * value;
        }
        double norm = Math.sqrt(sum);
        float[] normalized = new float[raw.length];
        if (norm == 0.0) {
            return normalized;
        }
        for (int i = 0; i < raw.length; i++) {
            normalized[i] = (float) (raw[i] / norm);
        }
        return normalized;
    }

    public static double dot(float[] left, float[] right) {
        if (left.length != right.length) {
            return -1.0;
        }
        double sum = 0.0;
        for (int i = 0; i < left.length; i++) {
            sum += left[i] * right[i];
        }
        return sum;
    }

    static String encode(float[] vector) {
        ByteBuffer buffer = ByteBuffer.allocate(vector.length * Float.BYTES);
        for (float value : vector) {
            buffer.putFloat(value);
        }
        return Base64.getEncoder().encodeToString(buffer.array());
    }

    static float[] decode(String text) {
        byte[] raw = Base64.getDecoder().decode(text);
        if (raw.length % Float.BYTES != 0) {
            throw new IllegalArgumentException("向量字节长度不是 4 的倍数");
        }
        ByteBuffer buffer = ByteBuffer.wrap(raw);
        float[] vector = new float[raw.length / Float.BYTES];
        for (int i = 0; i < vector.length; i++) {
            vector[i] = buffer.getFloat();
        }
        return vector;
    }
}
```

向量用 `ByteBuffer` 转成字节再 Base64，比存 JSON 浮点数组省一半以上空间。1024 维存成 JSON 大约 20 KB，存 Base64 二进制只要 5.5 KB。缓存几万条的时候，这个差别就是几百兆内存。

```java
package com.example.semcache.cache;

import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 语义像不代表答案能通用。型号、版本、数量这类硬信息必须完全一致。
 */
public final class EntityGuard {

    private static final Pattern HARD_TOKEN = Pattern.compile("[A-Za-z]*\\d[A-Za-z0-9.]*|[A-Z]{2,4}");

    private EntityGuard() {
    }

    public static boolean sameEntities(String question, String cachedQuestion) {
        return extract(question).equals(extract(cachedQuestion));
    }

    private static Set<String> extract(String text) {
        Set<String> tokens = new HashSet<>();
        Matcher matcher = HARD_TOKEN.matcher(text);
        while (matcher.find()) {
            tokens.add(matcher.group().toLowerCase(Locale.ROOT));
        }
        return tokens;
    }
}
```

正则两段：`[A-Za-z]*\d[A-Za-z0-9.]*` 抓所有含数字的串（`15`、`3.5`、`iphone15`、`v2`），`[A-Z]{2,4}` 抓大写代号（`VIP`、`SKU`、`XR`）。

它是保守的：宁可判成「不同」，也不判成「相同」。判错了最多多花一次模型调用，判反了就是事故。

### 3.4 Redis 语义缓存本体

```java
package com.example.semcache.cache;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Locale;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;

import org.springframework.data.redis.core.StringRedisTemplate;

/**
 * 用普通 Redis 存「问题向量 + 答案」，召回在 Java 侧按余弦相似度算。
 * 没引 RediSearch，规模上限靠 max-entries 卡住。
 */
public class RedisSemanticCache {

    private static final String SEP = "\u0001";

    private final StringRedisTemplate redis;
    private final int maxEntries;
    private final Duration ttl;

    public RedisSemanticCache(StringRedisTemplate redis, int maxEntries, Duration ttl) {
        this.redis = redis;
        this.maxEntries = maxEntries;
        this.ttl = ttl;
    }

    public record Hit(String id, String question, String answer, double score) {
    }

    public Optional<String> exactGet(String scope, String question) {
        return Optional.ofNullable(redis.opsForValue().get(exactKey(scope, question)));
    }

    public void exactPut(String scope, String question, String answer) {
        redis.opsForValue().set(exactKey(scope, question), answer, ttl);
    }

    public List<Hit> topMatches(String scope, float[] queryVector, int limit) {
        Set<String> ids = redis.opsForZSet().range(zsetKey(scope), 0, -1);
        if (ids == null || ids.isEmpty()) {
            return List.of();
        }
        List<String> idList = new ArrayList<>(ids);
        List<String> keys = idList.stream().map(id -> itemKey(scope, id)).toList();
        List<String> payloads = redis.opsForValue().multiGet(keys);
        if (payloads == null) {
            return List.of();
        }

        List<Hit> hits = new ArrayList<>();
        for (int i = 0; i < idList.size(); i++) {
            CacheEntry entry = decode(payloads.get(i));
            if (entry == null) {
                continue;
            }
            double score = VectorCodec.dot(queryVector, entry.vector());
            hits.add(new Hit(idList.get(i), entry.question(), entry.answer(), score));
        }
        hits.sort((left, right) -> Double.compare(right.score(), left.score()));
        return hits.size() > limit ? new ArrayList<>(hits.subList(0, limit)) : hits;
    }

    public void put(String scope, String question, String answer, float[] normalizedVector) {
        String id = UUID.randomUUID().toString().replace("-", "");
        String payload = System.currentTimeMillis()
                + SEP + VectorCodec.encode(normalizedVector)
                + SEP + Base64.getEncoder().encodeToString(question.getBytes(StandardCharsets.UTF_8))
                + SEP + Base64.getEncoder().encodeToString(answer.getBytes(StandardCharsets.UTF_8));

        redis.opsForValue().set(itemKey(scope, id), payload, ttl);
        redis.opsForZSet().add(zsetKey(scope), id, System.currentTimeMillis());

        Long size = redis.opsForZSet().size(zsetKey(scope));
        if (size != null && size > maxEntries) {
            redis.opsForZSet().removeRange(zsetKey(scope), 0, size - maxEntries - 1);
        }
    }

    private record CacheEntry(String question, String answer, float[] vector) {
    }

    private static CacheEntry decode(String payload) {
        if (payload == null || payload.isBlank()) {
            return null;
        }
        String[] parts = payload.split(SEP, -1);
        if (parts.length != 4) {
            return null;
        }
        try {
            float[] vector = VectorCodec.decode(parts[1]);
            String question = new String(Base64.getDecoder().decode(parts[2]), StandardCharsets.UTF_8);
            String answer = new String(Base64.getDecoder().decode(parts[3]), StandardCharsets.UTF_8);
            return new CacheEntry(question, answer, vector);
        } catch (IllegalArgumentException exception) {
            return null;
        }
    }

    private String keyPrefix(String scope) {
        return "semcache:" + scope + ":";
    }

    private String itemKey(String scope, String id) {
        return keyPrefix(scope) + "item:" + id;
    }

    private String zsetKey(String scope) {
        return keyPrefix(scope) + "index";
    }

    private String exactKey(String scope, String question) {
        return keyPrefix(scope) + "exact:" + sha256(question.trim().toLowerCase(Locale.ROOT));
    }

    private static String sha256(String text) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] hash = digest.digest(text.getBytes(StandardCharsets.UTF_8));
            StringBuilder builder = new StringBuilder(hash.length * 2);
            for (byte value : hash) {
                builder.append(String.format("%02x", value));
            }
            return builder.toString();
        } catch (NoSuchAlgorithmException exception) {
            throw new IllegalStateException("当前 JVM 不支持 SHA-256", exception);
        }
    }
}
```

几个设计点值得说清楚：

**ZSet 当索引。** score 存写入时间戳，既能按时间排序，又能直接拿来做容量控制。超过 `max-entries` 就从最老的一端删起，`removeRange` 一步搞定。

**删索引不删数据。** 被挤出去的 item key 还在 Redis 里，但没人再引用它，靠 TTL 自然过期。这样做是为了少一次删除请求，代价是可能短暂多占一点内存。要严格控内存就把 `removeRange` 换成一串 `del`，用 pipeline 批量删。

**payload 用 `\u0001` 分隔。** 这个控制字符不会出现在正常文本里，而问题文本本身又经过 Base64，所以不需要任何转义逻辑。比引 JSON 序列化干净。

**向量在写入前就已归一化**，所以 `topMatches` 里直接点积，不用再处理长度。

### 3.5 服务层和 HTTP 接口

```java
package com.example.semcache.service;

import java.util.List;
import java.util.Optional;

import org.springframework.stereotype.Service;

import com.example.semcache.cache.EntityGuard;
import com.example.semcache.cache.RedisSemanticCache;
import com.example.semcache.cache.VectorCodec;
import com.example.semcache.config.SemanticCacheProperties;

import dev.langchain4j.model.chat.ChatModel;
import dev.langchain4j.model.embedding.EmbeddingModel;

@Service
public class CachedChatService {

    private final ChatModel chatModel;
    private final EmbeddingModel embeddingModel;
    private final RedisSemanticCache cache;
    private final SemanticCacheProperties properties;

    public CachedChatService(ChatModel chatModel,
                             EmbeddingModel embeddingModel,
                             RedisSemanticCache cache,
                             SemanticCacheProperties properties) {
        this.chatModel = chatModel;
        this.embeddingModel = embeddingModel;
        this.cache = cache;
        this.properties = properties;
    }

    public record ChatAnswer(String answer, boolean cached, String source, double score) {
    }

    public ChatAnswer ask(String tenant, String question) {
        String cleanQuestion = question == null ? "" : question.trim();
        String scope = buildScope(tenant);

        Optional<String> exact = cache.exactGet(scope, cleanQuestion);
        if (exact.isPresent()) {
            return new ChatAnswer(exact.get(), true, "exact", 1.0);
        }

        float[] queryVector = VectorCodec.normalize(
                embeddingModel.embed(cleanQuestion).content().vector());

        List<RedisSemanticCache.Hit> candidates =
                cache.topMatches(scope, queryVector, properties.topK());
        for (RedisSemanticCache.Hit candidate : candidates) {
            if (candidate.score() < properties.minScore()) {
                break;
            }
            if (!EntityGuard.sameEntities(cleanQuestion, candidate.question())) {
                continue;
            }
            return new ChatAnswer(candidate.answer(), true, "semantic", candidate.score());
        }

        String answer = chatModel.chat(cleanQuestion);
        cache.exactPut(scope, cleanQuestion, answer);
        cache.put(scope, cleanQuestion, answer, queryVector);
        return new ChatAnswer(answer, false, "model", 0.0);
    }

    private String buildScope(String tenant) {
        String safeTenant = (tenant == null || tenant.isBlank()) ? "default" : tenant.trim();
        return safeTenant + ":" + properties.namespace();
    }
}
```

命中的那两条 `break` 和 `continue` 是重点：

- 候选按相似度降序，`score` 低于阈值就 `break`，后面只会更低。
- `score` 够了但硬信息对不上，`continue` 看下一个。

所以 `top-k` 一般设 3 到 5。设 1 会浪费掉「第一名被硬信息校验否掉、第二名正好对」的情况。

```java
package com.example.semcache.web;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import com.example.semcache.cache.VectorCodec;
import com.example.semcache.service.CachedChatService;

import dev.langchain4j.model.embedding.EmbeddingModel;

@RestController
@RequestMapping("/api")
public class ChatController {

    private final CachedChatService cachedChatService;
    private final EmbeddingModel embeddingModel;

    public ChatController(CachedChatService cachedChatService, EmbeddingModel embeddingModel) {
        this.cachedChatService = cachedChatService;
        this.embeddingModel = embeddingModel;
    }

    public record ChatRequest(String tenant, String question) {
    }

    public record ProbeResult(String left, String right, double score, boolean sameEntities) {
    }

    @PostMapping("/chat")
    public CachedChatService.ChatAnswer chat(@RequestBody ChatRequest request) {
        return cachedChatService.ask(request.tenant(), request.question());
    }

    /**
     * 调阈值专用：给两句话，返回相似度和硬信息是否一致。
     */
    @GetMapping("/probe")
    public ProbeResult probe(@RequestParam String left, @RequestParam String right) {
        float[] leftVector = VectorCodec.normalize(
                embeddingModel.embed(left).content().vector());
        float[] rightVector = VectorCodec.normalize(
                embeddingModel.embed(right).content().vector());
        return new ProbeResult(left, right,
                VectorCodec.dot(leftVector, rightVector),
                com.example.semcache.cache.EntityGuard.sameEntities(left, right));
    }
}
```

```java
package com.example.semcache;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class SemcacheApplication {

    public static void main(String[] args) {
        SpringApplication.run(SemcacheApplication.class, args);
    }
}
```

### 3.6 跑起来，把阈值调出来

启动之后先用 `/api/chat` 验证基本链路。同一个问题问两次，第二次应该看到 `"cached": true, "source": "exact"`。

然后换说法问一次：

```bash
curl -s -X POST http://localhost:8080/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"tenant":"acme","question":"发票怎么开呀"}'
```

如果第一次问的是「怎么开发票」，这次应该返回 `"source": "semantic"`，`score` 大概率在 0.93 到 0.97 之间。

接下来是关键动作——校准。把业务里真实的问题对拿出来，逐对打分：

```bash
curl -s 'http://localhost:8080/api/probe?left=怎么开发票&right=发票在哪开'
curl -s 'http://localhost:8080/api/probe?left=iPhone 15 电池多大&right=iPhone 16 电池多大'
curl -s 'http://localhost:8080/api/probe?left=怎么退款&right=怎么开发票'
```

期望看到三档结果：

- 第一对（真同义）：0.93 以上，`sameEntities` 为 true → 应该命中
- 第二对（差一个数字）：也可能 0.96，但 `sameEntities` 为 false → 被拦下
- 第三对（不同话题）：0.8 上下 → 阈值就该把它挡在外面

如果第一对和第三对的分差很小（比如 0.91 vs 0.88），说明你的 embedding 模型对这种短问句区分度不够，换模型比调阈值有效。

## 四、踩坑经验和最佳实践

### 阈值一开始就设 0.8

我第一次上线设的 0.82，想着「宁滥勿缺」。结果第二天收到投诉：用户问「能不能开专票」，返回的是「能不能开电子发票」的答案——相关，但答非所问。

语义缓存和普通缓存最大的区别就在这里：普通缓存未命中是「没查到」，语义缓存误命中是「查到了错的」。后者用户更难受，因为他不知道答案其实是别人的。

把阈值从 0.82 提到 0.94，命中率掉了大约 15 个点，投诉归零。这笔交易划算。

### 硬信息校验漏了大小写

早期版本我只比数字，忘了型号代号。结果「VIP 会员怎么退」命中了「SVIP 会员怎么退」的答案。加上大写代号抽取之后修好了。

同类问题还有：`Pro` / `Pro Max`、`v1` / `v2`、`5G` / `4G`。凡是「改一个字符含义全变」的 token，都该进硬信息集合。

### 忘了给 scope 带租户

这个坑要是上线了是要写事故报告的。缓存 key 只用了 `semcache:item:xxx`，两家客户共用一套缓存。测试环境就发现了，因为答案里带了公司名字。

修法就是代码里的 `buildScope`：`租户 + 命名空间` 两层前缀，而且租户一定要从服务端鉴权信息里取，不能用请求体里传的——请求体是用户能改的。

### 缓存了时效性内容

「本月优惠活动是什么」这种问题被缓存了 6 小时。运营改了活动规则，用户还在看到旧答案。

现在我的做法是分类 TTL：

- 政策、价格、活动 → 30 分钟，或者干脆不缓存
- 产品文档、操作步骤 → 24 小时
- 概念解释、术语定义 → 7 天

实现上就是缓存里多存一个类型字段，创建 key 时按类型取 TTL。多写十行代码，省掉一堆客诉。

### 流式接口直接套缓存

流式接口套语义缓存有个细节：命中缓存时你手里是一整段文本，得自己切块往下推，否则前端拿到的是一坨一次性返回，体验反而怪。

我的处理很简单——命中缓存时把答案按句号切成小块，每块 sleep 20 毫秒推出去。用户感知上仍然是「在生成」，实际零成本。别小看这个细节，产品经理会盯着这个体验差异问半天。

### 缓存里存了敏感信息

答案里可能有用户手机号、订单号。这些内容进了 Redis 就等于扩大了数据面。

规则：凡是含个人信息的问题，走 `PII` 检测后直接跳过缓存写入。检测不用做得太复杂，正则匹配手机号、身份证、邮箱，命中就不缓存。宁可少省点钱。

### 别忘了预热

新环境上线缓存是空的，前几千个请求全部穿透。如果流量有尖峰，第一天最容易出事。

上线前用历史日志里的高频问题跑一遍预热，成本几乎为零，能挡掉大部分首日穿透。

## 五、性能对比和技术选型

### 三条路径的耗时

以一个 200 字左右的答案为例，量级如下：

| 路径 | 耗时 | 模型费用 |
|---|---|---|
| 精确缓存命中 | 1-3 ms（一次 Redis GET） | 0 |
| 语义缓存命中 | 40-120 ms（embedding + Redis + 本地算） | 一次 embedding |
| 完全未命中 | 1.5-4 s（取决于模型和输出长度） | embedding + 对话 |

语义缓存的主要成本是那次 embedding 调用。它的价格大约是对话模型的百分之一到千分之一，具体看模型。所以只要命中率达到两三成，整体账单就能明显往下降。

省钱多少可以直接算：**节省比例 ≈ 命中率 ×（1 - embedding 费用占单次调用费用的比例）**。命中率 40%、embedding 占比 1% 的话，模型费用降幅接近 40%。别信「省 90%」这种宣传，除非你的命中率真的到 90%。

### 存储方案怎么选

| 方案 | 适用规模 | 优点 | 缺点 |
|---|---|---|---|
| 本地 Caffeine + 内存扫描 | 单机、几千条 | 最快，无网络开销 | 多副本不一致，重启丢失 |
| Redis String + ZSet（本文方案） | 万条以内 | 部署简单，多副本共享 | 每次全量拉取，网络开销随条数涨 |
| Redis + RediSearch KNN | 十万条以内 | 服务端算相似度，只回 top-k | 需要 Redis Stack，多一个组件 |
| Milvus / Qdrant | 百万级以上 | 专业向量检索，支持过滤和分区 | 运维成本高，小项目属于过度设计 |

判断标准就一条：**条目数 × 每次查询延迟**能不能接受。几千条的时候，Java 侧暴力扫比任何索引都快，因为它省掉了网络往返。

### embedding 模型怎么选

- `text-embedding-3-small`：便宜、够用，短问句场景表现稳定。语义缓存首选。
- 本地 bge-m3：数据不出内网，中文短句区分度好，但要自己扛推理资源。
- 维度不是越高越好。缓存场景语义粒度粗，1024 维和 3072 维的命中率差别远小于成本差别。

有一条铁律：**缓存里所有向量必须来自同一个模型。**换模型等于清空重来，没有兼容余地。

## 六、总结

语义缓存的本质，是把「问题 → 答案」的映射从字符串匹配升级成语义匹配。它能省钱、降延迟，前提是你接受一个新风险：命中错了比没命中更糟。

所以整套设计里，最该花心思的不是相似度算法，是那道安全阀：

- 精确匹配先挡一层，零风险
- 相似度阈值挡「不像的」
- 硬信息校验挡「像但不对的」
- 租户前缀挡「串号的」

四道关卡都过了，才允许复用答案。剩下的一律老老实实调模型。

代码层面没有黑魔法：一次 embedding、一次 Redis 批量读、一轮点积。几千条缓存的规模下，Java 自己算比引向量数据库更省事，也更可控。

先把它接到你现有的问答接口前面，观察一周的命中率和误命中率。命中率低于 20% 就别折腾了，说明你的流量里真新问题太多；误命中率只要不是零，就把阈值往上提。

省钱这件事，稳比猛重要。

文 / 会编程的吕洞宾

## 参考资料

- [LangChain4j 官方文档](https://docs.langchain4j.dev/)
- [Spring Data Redis Reference](https://docs.spring.io/spring-data/redis/reference/)
- [Redis Vector Sets and Vector Similarity Search](https://redis.io/docs/latest/develop/interact/search-and-query/advanced-concepts/vectors/)
