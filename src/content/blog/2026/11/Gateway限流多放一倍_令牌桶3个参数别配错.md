---
title: Gateway限流多放一倍_令牌桶3个参数别配错
date: 2026-11-20T10:40:32+08:00
tags: ["java", "spring-cloud", "redis"]
categories: java
---

> 网关限流配了每秒 10 个，压测第一秒却放进来 20 个请求，业务方咬定"限流没生效"。问题不在限流器，在参数：Spring Cloud Gateway 的 Redis 令牌桶有 replenishRate、burstCapacity、requestedTokens 三个参数，尤其 burstCapacity，它决定第一波突发能放多少。算法、Lua 脚本、六个真坑，往下看。

## 一、限流配了 10 QPS，压测却放进 20 个：问题出在哪

结论先给：**限流失效是错觉，你配的是"平均速率 10 QPS + 突发容量 20"，令牌桶一开始是满的，所以前 20 个请求一个都不会被拒。**

先把三个容易混的东西掰开：

- **QPS（每秒请求数）**：一段时间内的平均速率。10 QPS 不代表第 1 秒只能过 10 个。
- **并发数**：同一时刻还在处理中的请求数量。跟 QPS 不是一回事，一个 100ms 的接口在 10 QPS 下并发只有 1 左右。
- **桶容量（burstCapacity）**：允许"攒着"的额度。桶里初始是满的，攒满 20 个，突发来的时候能一口气放 20 个。

很多人脑子里的限流是这样的：每过一秒清零，重新数 10 个。这叫**固定窗口**，简单但有两个毛病——窗口边界能被打穿（第 1 秒末尾 10 个 + 第 2 秒开头 10 个，瞬间 20 个），而且不允许合理的突发。网关用的不是这套，它用**令牌桶**：桶里有 token，请求拿走 token 才放行，token 按固定速率往桶里补，补满为止。

所以你配的这组值：

| 参数 | 你填的值 | 真实含义 |
| --- | --- | --- |
| `redis-rate-limiter.replenishRate` | 10 | 每秒补 10 个 token，长期平均速率上限 |
| `redis-rate-limiter.burstCapacity` | 20 | 桶最多装 20 个 token，短时间最多放 20 个 |
| `redis-rate-limiter.requestedTokens` | 1 | 每个请求消耗 1 个 token |

压测第一秒：桶满着 20 个 token，前 20 个请求全部通过，剩下的开始 429。从第二秒起，每秒补 10 个，稳定在 10 QPS。这套行为完全正确，只是和你脑子里"每秒 10 个"的预期不一样。

想要严格每秒最多 10 个，把 `burstCapacity` 也填 10。官方文档原话是：`replenishRate` 和 `burstCapacity` 填成一样，就是稳定速率；`burstCapacity` 大于 `replenishRate`，就是允许突发，但连续突发必然被拒。

还有一个常被忽略的第四个能力：**限流维度**。限流器需要一个 key，同一个 key 共用一个桶。key 取用户 ID，就是每人 10 QPS；key 取接口路径，就是这个接口全站 10 QPS；key 取 IP，就是每个 IP 10 QPS。key 由 `KeyResolver` 决定，这是最容易被配错、也最容易出事故的地方——取错了，要么全站共用一个桶（一个用户把所有人拖死），要么每人一个桶（等于没限）。

## 二、原生原理：一个 Lua 脚本加一个 Redis key，就是全部

结论：**Spring Cloud Gateway 的 Redis 限流没有黑魔法，就是把令牌桶的状态存在 Redis 的两个 key 里，用一段 Lua 脚本原子地"取旧值、算新值、写回"。**

为什么必须用 Redis？因为网关通常是多实例的。三台网关各自在 JVM 内存里记数，每台都放 10 QPS，实际就是 30 QPS。计数必须放在所有实例都能读到的地方，Redis 最顺手。

为什么必须用 Lua？因为"读 token → 比较 → 扣减 → 写回"这四步如果分开发命令，两个并发请求会读到同一个旧值，各自扣一次，桶里只少了一个 token，等于超发。Redis 执行 Lua 是单线程原子的，整段脚本要么全做完，要么不做。

网关里那段脚本长这样（`META-INF/scripts/request_rate_limiter.lua`）：

```lua
redis.replicate_commands()

local tokens_key = KEYS[1]
local timestamp_key = KEYS[2]

local rate = tonumber(ARGV[1])
local capacity = tonumber(ARGV[2])
local now = tonumber(ARGV[3]) or redis.call('TIME')[1]
local requested = tonumber(ARGV[4])

local fill_time = capacity / rate
local ttl = math.floor(fill_time * 2)

local last_tokens = tonumber(redis.call("get", tokens_key)) or capacity
local last_refreshed = tonumber(redis.call("get", timestamp_key)) or 0

local delta = math.max(0, now-last_refreshed)
local filled_tokens = math.min(capacity, last_tokens+(delta*rate))
local allowed = filled_tokens >= requested
local new_tokens = allowed and filled_tokens - requested or filled_tokens

if ttl > 0 then
  redis.call("setex", tokens_key, ttl, new_tokens)
  redis.call("setex", timestamp_key, ttl, now)
end

return { allowed and 1 or 0, new_tokens }
```

逐段翻译成人话：

1. **两个 key**。`KEYS[1]` 存当前 token 数，`KEYS[2]` 存上次补充的时间戳。实际 key 名是 `request_rate_limiter.{你的key}.tokens` 和 `request_rate_limiter.{你的key}.timestamp`，比如 `request_rate_limiter.{user:1001}.tokens`。
2. **四个参数**。`rate` 就是 replenishRate，`capacity` 就是 burstCapacity，`now` 是当前秒级时间戳，`requested` 是这次请求要消耗几个 token（requestedTokens）。
3. **首次访问**。`last_tokens` 读不到就取 `capacity`，`last_refreshed` 读不到就取 0。这就是为什么新 key 一开始是满桶——第一次请求进来，桶是满的。这也解释了开头那个"第一秒放 20 个"。
4. **补充 token**。`delta` 是距上次补充过了多少秒，`delta * rate` 就是这段时间该补的量，`math.min(capacity, ...)` 保证补不过头。这一行就是"匀速补充、封顶容量"的全部实现。
5. **判断与扣减**。`filled_tokens >= requested` 才放行。放行就扣 `requested`，不放行就一个都不扣（不是扣一半）。
6. **写回和过期**。`ttl = fill_time * 2`，即桶从空到满所需时间的两倍。rate=10、capacity=20 时，ttl=4 秒。用户不再访问，这两个 key 4 秒后自动消失，不会在 Redis 里越攒越多。
7. **返回值**。第一个是 0 或 1（放不放），第二个是剩余 token 数。

剩余 token 数会被塞进响应头，你能直接在 curl 里看到限流器的实时状态：

- `X-RateLimit-Remaining`：这次之后还剩几个 token
- `X-RateLimit-Replenish-Rate`：补充速率
- `X-RateLimit-Burst-Capacity`：桶容量
- `X-RateLimit-Requested-Tokens`：本次消耗

被拒的时候，默认返回的状态码是 429。这一条很关键，后面踩坑会用到。

顺带说清 `requestedTokens` 的用法。它解决"低频接口"的需求：想限制"每个用户每分钟 1 次"，把 `replenishRate=1`、`requestedTokens=60`、`burstCapacity=60`。意思是每 60 秒补 1 个 token，一次请求要花 60 个。桶里的 60 个 token 只够花一次，下一次要等 60 秒。这是官方文档给的写法，不是我自己推的。

## 三、实战：Spring Cloud Gateway 限流从零跑通

结论：**跑通限流只需要三样东西——网关依赖、一段路由配置、一个 KeyResolver bean，外加一个被限流的下游服务用来验证。**

项目拆两个独立应用，网关 8080，订单服务 8081。先建目录：

```bash
mkdir -p gateway-demo/gateway-app gateway-demo/order-service
```

### 3.1 网关的 pom.xml

完整的 `gateway-app/pom.xml`。三件事要说清：网关用 `spring-cloud-starter-gateway-server-webflux`（旧的 `spring-cloud-starter-gateway` 在 5.x 已经不再发布，坐标对不上会直接拉不到包）；限流器要操作 Redis，所以必须用 **reactive** 那个 starter，非 reactive 的 `spring-boot-starter-data-redis` 里没有 `ReactiveStringRedisTemplate`，限流器起不来。

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
    <artifactId>gateway-app</artifactId>
    <version>1.0.0</version>

    <properties>
        <java.version>21</java.version>
    </properties>

    <dependencyManagement>
        <dependencies>
            <dependency>
                <groupId>org.springframework.cloud</groupId>
                <artifactId>spring-cloud-dependencies</artifactId>
                <version>2026.0.0</version>
                <type>pom</type>
                <scope>import</scope>
            </dependency>
        </dependencies>
    </dependencyManagement>

    <dependencies>
        <dependency>
            <groupId>org.springframework.cloud</groupId>
            <artifactId>spring-cloud-starter-gateway-server-webflux</artifactId>
            <version>5.1.0</version>
        </dependency>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-data-redis-reactive</artifactId>
            <version>4.2.0</version>
        </dependency>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-actuator</artifactId>
            <version>4.2.0</version>
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

### 3.2 网关的 application.yml

完整的 `gateway-app/src/main/resources/application.yml`。重点是路由那段的缩进和参数名，写错一个就静默不生效。

```yaml
server:
  port: 8080

spring:
  application:
    name: gateway-app
  data:
    redis:
      host: 127.0.0.1
      port: 6379
      database: 0
      timeout: 3s
  cloud:
    gateway:
      server:
        webflux:
          routes:
            - id: order-service
              uri: http://127.0.0.1:8081
              predicates:
                - Path=/api/order/**
              filters:
                - name: RequestRateLimiter
                  args:
                    key-resolver: "#{@userKeyResolver}"
                    redis-rate-limiter.replenishRate: 10
                    redis-rate-limiter.burstCapacity: 10
                    redis-rate-limiter.requestedTokens: 1
      filter:
        request-rate-limiter:
          deny-empty-key: true
          empty-key-status-code: 401

management:
  endpoints:
    web:
      exposure:
        include: health,gateway
```

几个必须点名的细节：

- 路由前缀是 `spring.cloud.gateway.server.webflux.routes`。网上大量老文章写的 `spring.cloud.gateway.routes` 是 4.2 之前的写法，配在新版本上不出错也不生效，排查起来非常费劲。
- `redis-rate-limiter.burstCapacity` 这里我填 10，跟 `replenishRate` 一致，就是严格每秒 10 个。开头那个"多放一倍"的场景，填 20 就会复现。
- `key-resolver: "#{@userKeyResolver}"` 是 SpEL，`@userKeyResolver` 指的是 bean 名字。bean 改名了这里必须跟着改。
- `deny-empty-key: true` 表示 KeyResolver 拿不到 key 时直接拒绝，`empty-key-status-code: 401` 把默认的 403 改成 401。这段配置的真实前缀是 `spring.cloud.gateway.server.webflux.filter.request-rate-limiter`，少写 `server.webflux` 同样静默失效。

### 3.3 三种限流维度的 KeyResolver

完整的 `gateway-app/src/main/java/com/example/gateway/config/RateLimiterKeyConfig.java`。三个 resolver 覆盖最常用的三种维度，`@Primary` 标在用户维度上，因为网关内部按类型注入一个 KeyResolver，声明多个却不指定主 bean，启动时会被多个候选绑住，直接报 `NoUniqueBeanDefinitionException`。

```java
package com.example.gateway.config;

import java.net.InetSocketAddress;

import org.springframework.cloud.gateway.filter.ratelimit.KeyResolver;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Primary;
import reactor.core.publisher.Mono;

@Configuration
public class RateLimiterKeyConfig {

    /**
     * 按用户限流：请求头 X-User-Id 作为维度。
     * 没有带用户标识时返回空 Mono，交给 deny-empty-key 处理，直接拒绝。
     */
    @Bean
    @Primary
    public KeyResolver userKeyResolver() {
        return exchange -> {
            String userId = exchange.getRequest().getHeaders().getFirst("X-User-Id");
            if (userId == null || userId.isBlank()) {
                return Mono.empty();
            }
            return Mono.just("user:" + userId);
        };
    }

    /**
     * 按调用方 IP 限流：适合没登录态的开放接口。
     */
    @Bean
    public KeyResolver ipKeyResolver() {
        return exchange -> {
            InetSocketAddress remote = exchange.getRequest().getRemoteAddress();
            if (remote == null || remote.getAddress() == null) {
                return Mono.empty();
            }
            String ip = remote.getAddress().getHostAddress();
            return Mono.just("ip:" + ip);
        };
    }

    /**
     * 按接口路径限流：整个接口全站共享一个桶。
     */
    @Bean
    public KeyResolver apiKeyResolver() {
        return exchange -> Mono.just("api:" + exchange.getRequest().getPath().value());
    }
}
```

想让某个路由走 IP 维度，只改路由里的 args 就行，不用改代码：

```yaml
                    key-resolver: "#{@ipKeyResolver}"
```

### 3.4 网关启动类

完整的 `gateway-app/src/main/java/com/example/gateway/GatewayApplication.java`：

```java
package com.example.gateway;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class GatewayApplication {

    public static void main(String[] args) {
        SpringApplication.run(GatewayApplication.class, args);
    }
}
```

### 3.5 把 429 变成统一 JSON

网关被拒时默认只回一个状态码，响应体是空的。前端 `response.json()` 直接抛解析异常，最后在群里问"接口报错了但我看不到原因"。用响应装饰器补一段固定 JSON，是最省事的做法。

完整的 `gateway-app/src/main/java/com/example/gateway/filter/RateLimitResponseFilter.java`。这里没有拦截请求，而是把响应包了一层：限流器调用 `setComplete()` 结束时，先判断状态码是不是 429，是就写 JSON，不是就走原逻辑。

```java
package com.example.gateway.filter;

import java.nio.charset.StandardCharsets;

import org.springframework.cloud.gateway.filter.GatewayFilterChain;
import org.springframework.cloud.gateway.filter.GlobalFilter;
import org.springframework.core.Ordered;
import org.springframework.core.io.buffer.DataBuffer;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.server.reactive.ServerHttpResponse;
import org.springframework.http.server.reactive.ServerHttpResponseDecorator;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ServerWebExchange;
import reactor.core.publisher.Mono;

@Component
public class RateLimitResponseFilter implements GlobalFilter, Ordered {

    private static final String BODY = "{\"code\":429,\"message\":\"请求太频繁，请稍后再试\"}";

    @Override
    public Mono<Void> filter(ServerWebExchange exchange, GatewayFilterChain chain) {
        ServerHttpResponseDecorator decorator = new ServerHttpResponseDecorator(exchange.getResponse()) {
            @Override
            public Mono<Void> setComplete() {
                if (getStatusCode() != null && getStatusCode().value() == HttpStatus.TOO_MANY_REQUESTS.value()) {
                    ServerHttpResponse delegate = getDelegate();
                    byte[] bytes = BODY.getBytes(StandardCharsets.UTF_8);
                    delegate.getHeaders().setContentType(MediaType.APPLICATION_JSON);
                    delegate.getHeaders().setContentLength(bytes.length);
                    DataBuffer buffer = delegate.bufferFactory().wrap(bytes);
                    return delegate.writeWith(Mono.just(buffer));
                }
                return super.setComplete();
            }
        };
        return chain.filter(exchange.mutate().response(decorator).build());
    }

    @Override
    public int getOrder() {
        return Ordered.HIGHEST_PRECEDENCE;
    }
}
```

### 3.6 下游订单服务

`order-service/pom.xml`，完整内容：

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
    <artifactId>order-service</artifactId>
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

`order-service/src/main/resources/application.yml`：

```yaml
server:
  port: 8081
spring:
  application:
    name: order-service
```

启动类 `order-service/src/main/java/com/example/order/OrderApplication.java`：

```java
package com.example.order;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class OrderApplication {

    public static void main(String[] args) {
        SpringApplication.run(OrderApplication.class, args);
    }
}
```

接口 `order-service/src/main/java/com/example/order/controller/OrderController.java`。返回包里带一个自增序号和时间戳，压测时能一眼看出哪些请求真的打到了下游：

```java
package com.example.order.controller;

import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/order")
public class OrderController {

    private static final DateTimeFormatter FMT = DateTimeFormatter.ofPattern("HH:mm:ss.SSS");

    private final AtomicLong counter = new AtomicLong();

    @GetMapping("/{id}")
    public Map<String, Object> detail(@PathVariable("id") Long id,
                                      @RequestHeader(value = "X-User-Id", required = false) String userId) {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("orderId", id);
        result.put("userId", userId == null ? "anonymous" : userId);
        result.put("seq", counter.incrementAndGet());
        result.put("time", LocalDateTime.now().format(FMT));
        return result;
    }
}
```

### 3.7 跑起来验证

三个终端：Redis、订单服务、网关。然后压 30 个请求：

```bash
for i in $(seq 1 30); do
  curl -s -o /dev/null -w "%{http_code} " \
    -H "X-User-Id: 1001" "http://127.0.0.1:8080/api/order/1"
done
echo
```

`burstCapacity=10` 时会看到前 10 个 200，后面一串 429；等一秒再压，又能过 10 个。把配置改成 `burstCapacity: 20`，前 20 个全过——开头那个"多放一倍"就这么复现出来了。

盯一下 Redis，能看到桶的真实状态：

```bash
redis-cli --scan --pattern 'request_rate_limiter.*'
redis-cli get 'request_rate_limiter.{user:1001}.tokens'
redis-cli ttl 'request_rate_limiter.{user:1001}.tokens'
```

换个用户 ID 再压，`X-User-Id: 1002` 会拿到独立的桶，互不影响。这正好验证了限流维度是按 key 切的。

## 四、踩过的 6 个坑

结论：**限流配不好，九成不是算法问题，是配置前缀、bean 冲突、key 取值这三类问题。**

**坑 1：把 burstCapacity 当成 QPS 上限。** 这是最常见的误判。`replenishRate=10`、`burstCapacity=20` 的正确读法是"平均 10 QPS，允许 20 的突发"。要严格限速，两个值填一样。要限"每分钟 1 次"，用 `replenishRate=1`、`requestedTokens=60`、`burstCapacity=60`。

**坑 2：照着老文档写配置前缀。** `spring.cloud.gateway.routes`、`spring.cloud.gateway.filter.request-rate-limiter` 都是过去式，现在的真实前缀是 `spring.cloud.gateway.server.webflux.routes` 和 `spring.cloud.gateway.server.webflux.filter.request-rate-limiter`。Spring Boot 对未知配置项不报错，所以你只会看到"限流没反应"。查这个别靠猜，直接看 `RequestRateLimiterGatewayFilterFactory` 里的常量。

**坑 3：声明了多个 KeyResolver 没指定主 bean。** 网关内部按类型注入单个 KeyResolver，你有三个候选它不知道选谁，启动就报 `NoUniqueBeanDefinitionException`。给默认那个加 `@Primary`，其余的在路由里用 `#{@beanName}` 显式引用。别把三个都加 `@Primary`，那更热闹。

**坑 4：KeyResolver 返回空 Mono，以为会放行。** 默认行为是**拒绝**，状态码 403。用户没带 `X-User-Id` 就全站 401/403，很容易被当成鉴权 bug。要么让 resolver 兜底给个 `anonymous`，要么明确配置 `deny-empty-key` 和 `empty-key-status-code`。

**坑 5：按 IP 限流，结果取到的是 Nginx 地址。** `getRemoteAddress()` 拿的是直连对端地址。网关前面有一层 Nginx 或 SLB 时，所有请求的对端都是同一个内网 IP，全站共用一个桶，一个人就能把所有人的额度吃光。要么从 `X-Forwarded-For` 第一个地址取值，要么让代理层把真实 IP 透传过来，别指望 `getRemoteAddress()` 自己变聪明。

**坑 6：依赖引成了非 reactive 版本。** `spring-boot-starter-data-redis` 提供的是 `StringRedisTemplate`，限流器要的是 `ReactiveStringRedisTemplate`。少一个 reactive，轻则限流器装配失败启动报错，重则你为了"绕过去"自己写了个本地计数器，多实例部署后限流形同虚设。

再补一个不算坑但常被问的：Redis 里冒出一堆 `request_rate_limiter.{xxx}.tokens`，不是内存泄漏。每个 key 都带 TTL（桶从空到满时间的两倍），用户不访问就自动过期。真要清理，按前缀扫就行，别用 `keys *`。

## 五、三种限流方案怎么选

结论：**要跨实例共享计数、按业务维度限流，就用网关 + Redis 令牌桶；只在单机内控速，用本地桶；要做集群整体配额，才考虑 Sentinel 集群流控。**

| 方案 | 计数存在哪 | 维度 | 适合场景 | 代价 |
| --- | --- | --- | --- | --- |
| Gateway + Redis 令牌桶 | Redis，多实例共享 | 用户/IP/接口/自定义 | 统一入口限流，按业务维度配额 | 每请求一次 Redis 往返，Lua 保证原子 |
| Bucket4j / 本地令牌桶 | JVM 内存 | 单实例 | 保护本机资源、挡住突发 | 实例数×N，总配额随扩容漂移 |
| Sentinel 集群流控 | Token Server | 集群总量 | 精确的集群级 QPS 配额 | 多一个组件要运维，规则要持久化 |
| Nginx `limit_req` | Nginx worker 内存 | IP/连接 | 最外层的粗粒度防护 | 拿不到用户身份，只能按 IP |

我的选择很直接：**业务维度的限流放网关，用 Redis 令牌桶**。理由有三点。一是维度自由，用户、租户、API Key 都只是换一个 KeyResolver。二是多实例天然一致，扩网关不用改配额。三是可观测，`X-RateLimit-*` 响应头直接告诉调用方还剩多少额度。

Nginx 那层限流别省，它挡的是恶意流量和连接数洪水，跟业务限流不是一件事。Sentinel 适合已经有整套流控治理体系的团队，为了一个限流单独引入 Token Server，运维成本不划算。

一个数字参考：Redis 令牌桶每次限流判断是一次 Lua 调用，本地 Redis 通常 0.2~0.5ms，同机房跨机器 1ms 上下。对绝大多数业务接口，这点开销可以忽略；真到每秒几十万请求的入口，先在 Nginx 挡一层，再谈网关限流。

## 六、总结

三个参数，记住三句话就够了：`replenishRate` 是长期平均速率，`burstCapacity` 是短时间能放多少（也是桶的初始容量），`requestedTokens` 是一个请求花几个 token。

"限流多放一倍"不是 bug，是桶初始满、容量大于速率时的正常表现。要严格限速，把容量填成和速率一样。

真正容易翻车的地方不在参数，在配置前缀和 key 的选择。前缀写错静默失效，key 选错则是全站共用桶或者等于没限流。上线前用两个不同用户 ID 压一遍，看 Redis 里是不是两个独立的桶，比看十篇文章都管用。

文 / 会编程的吕洞宾

## 参考资料

- [RequestRateLimiter GatewayFilter Factory - Spring Cloud Gateway](https://docs.spring.io/spring-cloud-gateway/reference/5.1/spring-cloud-gateway-server-webflux/gatewayfilter-factories/requestratelimiter-factory.html)
- [Spring Boot v4.2.0 Release Notes](https://github.com/spring-projects/spring-boot/releases/tag/v4.2.0)
- [spring-cloud-dependencies 2026.0.0 - Maven Central](https://repo1.maven.org/maven2/org/springframework/cloud/spring-cloud-dependencies/2026.0.0/)
- [EVAL - Redis Documentation](https://redis.io/docs/latest/commands/eval/)
