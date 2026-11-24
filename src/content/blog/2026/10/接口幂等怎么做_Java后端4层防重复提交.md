---
title: "接口幂等怎么做？Java后端4层防重复提交"
date: 2026-10-31T09:00:00+08:00
category: "java"
tags: ["idempotency"]
---

> 摘要：用户连点、网关重试、MQ 重投，都能让同一笔订单落两次库。这篇讲透接口幂等的四层防线：Redis 预检挡并发、数据库唯一索引兜底、状态机更新防重复流转、MQ 消费端去重。全程 Spring Boot 完整代码，复制能跑。

用户手抖点了两下提交，订单列表里躺着两笔一模一样的单。你在前端加了按钮置灰，第二天客服又找上门——App 弱网重试、网关超时重发、MQ 重投，全都能绕过置灰。

接口幂等解决的就是这件事：同一个请求来一次和来十次，数据库里的结果必须一样。这篇文章用一个下单场景，把 Redis 预检、数据库唯一索引、状态机更新、MQ 消费去重这四层防线写成能直接跑的代码，再说清楚每一层会在什么情况下漏。

## 一、接口幂等到底是什么，为什么按钮置灰挡不住

接口幂等的定义只有一句话：**同一个业务请求，执行一次和执行 N 次，对系统状态的改变完全相同**。

关键词是"系统状态"。返回值一样不算幂等，没多写一行数据才算。比如扣库存接口，第一次扣 1 件返回成功，第二次返回"库存不足"，两次返回值不同，但库存只被扣了一次——这依然是幂等的。反过来，两次都返回成功、库存扣了 2 件，返回值一致却完全不幂等。

重复请求不会只从"用户点两下"这一个口子进来。真实线上至少有六条路：

| 重复来源 | 典型场景 | 两次请求体一样吗 |
| --- | --- | --- |
| 用户重复点击 | 手抖、页面卡住连点 | 一样 |
| 客户端超时重试 | App 弱网，3 秒没响应自动重发 | 一样 |
| 网关重试 | Nginx、Spring Cloud Gateway 配了 retry | 一样 |
| RPC 框架重试 | OpenFeign、Dubbo 超时重发 | 一样 |
| 消息重投 | Kafka 重平衡、RocketMQ 消费失败重试 | 一样 |
| 定时任务重跑 | 补数据、人工触发两次 | 一样 |

看第三列。所有这些重复请求，请求体是一模一样的，服务端没有任何天然线索能区分"这是新请求"还是"上一笔的重发"。前端置灰只能挡住第一行，后面五行它一个都管不了。更何况用户换个手机、清个缓存，置灰直接失效。

下面三种写法，是线上最常见的"以为做了幂等"：

**第一种，先查后插。** 下单前先 `select` 一下订单存不存在，不存在再 `insert`。单线程跑没问题，两个请求同时到达就完了——两个线程都查到"不存在"，然后都插进去了。

**第二种，只加 Redis 锁，不加数据库约束。** Redis 主从切换的那几秒，锁数据可能还没同步过去，新请求拿到锁，照样重复插入。

**第三种，只在业务代码里做判断。** 比如"如果订单状态是已支付就直接返回"。这个思路是对的，但它只能防住有明确状态流转的业务，防不住"新增"这种没有前置状态的操作。

顺便把三个容易混的概念分开：

- **幂等**是目标：重复执行不出错。
- **去重**是手段之一：记录处理过的请求。
- **分布式锁**是另一回事：它保证同一时刻只有一个线程在跑，跑完锁就释放，下一个请求照样能进来。锁管"同时"，幂等管"曾经"。

## 二、底层原理：原子占位 + 唯一约束 + 状态判断

幂等能成立，靠的是三个东西凑齐：**一个唯一的标识、一次原子的占位、一个不可回退的状态判断**。缺一个就会漏。

### 2.1 唯一标识：幂等键从哪来

幂等键（idempotency key）是这次业务操作的身份证。同一个业务动作，重发多少次，键都一样。

设计幂等键有三条硬规矩：

1. **由客户端生成**，一次业务动作生成一个 UUID，放在请求头里。服务端生成没用——服务端每次收到请求都会生成新的，等于没做。
2. **不能拼业务字段**。有人用 `userId + skuId` 当键，用户想买第二件同款就被挡住了。业务字段会变，幂等键不能变。
3. **不能带时间戳、随机数、traceId**。这三个东西每次请求都不一样，拼进去等于每次都换新键。

标准做法是请求头 `X-Idempotency-Key: 8f3c...`，客户端在用户点提交的那一刻生成，重试时复用同一个值。Stripe 的支付接口就是这么设计的。

### 2.2 原子占位：为什么 `SET NX EX` 能挡住并发

**Redis 的 `SET key value NX EX seconds` 是一条命令完成"判断存在 + 写入 + 设过期"，所以它是原子的。**

拆开写就会出问题。先 `GET` 判断，再 `SET`，两步之间别的线程能插进来，两个线程都判断"不存在"，都写成功。Redis 单线程串行执行命令，把判断和写入压进同一条命令，中间没有缝。

`NX` 的意思是"key 不存在才写"，`EX` 是过期时间。用官方命令参考里的写法就是：

```
SET idem:order:create:8f3c... 7d1e... NX EX 600
```

返回 `OK` 说明抢到了，返回 `nil` 说明有人已经占了位。

### 2.3 value 为什么要放一个随机 token

**value 里放随机 token，是为了删除时只删自己的锁。**

想象这个时序：请求 A 抢到锁，业务卡了 700 秒，锁在 600 秒时自动过期；请求 B 进来抢到锁开始跑；这时 A 终于跑完，执行 `DEL` 把 B 的锁删了；请求 C 立刻又抢到锁——同一时刻 B 和 C 在跑，幂等失效。

正确做法是删除前先比对 value：

```lua
if redis.call('get', KEYS[1]) == ARGV[1] then
    return redis.call('del', KEYS[1])
else
    return 0
end
```

比对和删除必须在 Redis 里一次做完，所以要用 Lua 脚本。放 Java 里先 get 再 del，中间又有窗口。

### 2.4 过期时间怎么定，失败要不要删 key

**幂等键的 TTL 要大于"业务最长执行时间 + 客户端重试窗口"，成功了不删，失败了必须删。**

不删成功记录的 key，是因为重复请求还得靠它挡。TTL 到了自然消失，用户过十分钟再点就是一笔新业务，这符合直觉。

失败必须删，是因为业务没成功，用户有权重试。如果业务抛异常了 key 还留着，用户在这 600 秒里怎么点都被拒绝，体验极差——这是新手最容易踩的坑。

### 2.5 三层防线各自管什么

| 防线 | 位置 | 挡住什么 | 漏在哪 |
| --- | --- | --- | --- |
| Redis 预检 | 请求入口 | 并发重复、短时间连点 | Redis 故障、主从切换丢锁 |
| 数据库唯一索引 | 存储层 | 所有并发重复（强一致） | 挡不住，但会抛异常，要处理 |
| 状态机更新 | 业务层 | 重复流转（重复支付、重复发货） | 只适用有状态流转的业务 |

三层不是三选一，是叠加。Redis 挡掉 99% 的重复，少打一次数据库；唯一索引兜住剩下的和 Redis 挂掉时的；状态机保证"重复请求不会推动业务往前走第二步"。

## 三、实战：一套能跑的下单幂等

下面是一个完整工程，Spring Boot + MySQL + Redis，复制到本地配好数据库和 Redis 就能启动。目录结构如下，`schema.sql` 放在 resources 根目录下，启动时会被自动执行：

```
idempotent-demo
├── pom.xml
└── src/main
    ├── java/com/example/idempotent
    │   ├── IdempotentApplication.java
    │   ├── config/WebMvcConfig.java
    │   ├── idempotent/Idempotent.java
    │   ├── idempotent/IdempotentGuard.java
    │   ├── idempotent/IdempotentInterceptor.java
    │   ├── mq/OrderPaidConsumer.java
    │   ├── repository/OrderRepository.java
    │   ├── service/OrderNoGenerator.java
    │   ├── service/OrderService.java
    │   └── web
    │       ├── ApiResponse.java
    │       ├── GlobalExceptionHandler.java
    │       ├── OrderController.java
    │       ├── OrderRequest.java
    │       └── OrderView.java
    └── resources
        ├── application.yml
        └── schema.sql
```

### 3.1 pom.xml

用的是 Spring Boot 4 的模块化 starter，`spring-boot-starter-webmvc` 是新的 Web 起点，老的 `spring-boot-starter-web` 已经标记为不推荐。

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
    <artifactId>idempotent-demo</artifactId>
    <version>1.0.0</version>
    <name>idempotent-demo</name>

    <properties>
        <java.version>21</java.version>
    </properties>

    <dependencies>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-webmvc</artifactId>
            <version>4.1.2</version>
        </dependency>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-jdbc</artifactId>
            <version>4.1.2</version>
        </dependency>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-data-redis</artifactId>
            <version>4.1.2</version>
        </dependency>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-validation</artifactId>
            <version>4.1.2</version>
        </dependency>
        <dependency>
            <groupId>com.mysql</groupId>
            <artifactId>mysql-connector-j</artifactId>
            <version>26.10.0</version>
            <scope>runtime</scope>
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

### 3.2 application.yml

```yaml
server:
  port: 8080

spring:
  application:
    name: idempotent-demo
  datasource:
    url: jdbc:mysql://127.0.0.1:3306/idem_demo?useUnicode=true&characterEncoding=utf8&serverTimezone=Asia/Shanghai&useSSL=false
    username: root
    password: root123
    driver-class-name: com.mysql.cj.jdbc.Driver
    hikari:
      maximum-pool-size: 20
      minimum-idle: 5
      connection-timeout: 3000
  sql:
    init:
      mode: always
      schema-locations: classpath:schema.sql
  data:
    redis:
      host: 127.0.0.1
      port: 6379
      timeout: 2s

logging:
  level:
    com.example.idempotent: debug
```

`spring.sql.init` 会在启动时执行建表脚本，省得你手动跑 SQL。表用 `IF NOT EXISTS`，重复启动不会报错。

### 3.3 建表脚本 schema.sql

关键在 `uk_idem_key` 这个唯一索引上——它是最后一道防线，Redis 全挂了也靠它。

```sql
CREATE TABLE IF NOT EXISTS `t_order` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `order_no` VARCHAR(40) NOT NULL,
  `idempotency_key` VARCHAR(128) NOT NULL,
  `user_id` VARCHAR(64) NOT NULL,
  `sku_id` VARCHAR(64) NOT NULL,
  `quantity` INT NOT NULL,
  `amount` DECIMAL(12,2) NOT NULL,
  `status` VARCHAR(16) NOT NULL DEFAULT 'PENDING',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_order_no` (`order_no`),
  UNIQUE KEY `uk_idem_key` (`idempotency_key`),
  KEY `idx_user_created` (`user_id`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

`idempotency_key` 给 128 位，够放 UUID 加业务前缀。别图省事用 `VARCHAR(255)`，`utf8mb4` 下 255 乘 4 是 1020 字节，虽然现在 InnoDB 单列索引上限是 3072 字节扛得住，但索引占的空间白白翻倍。

### 3.4 启动类

```java
package com.example.idempotent;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class IdempotentApplication {

    public static void main(String[] args) {
        SpringApplication.run(IdempotentApplication.class, args);
    }
}
```

### 3.5 自定义注解 @Idempotent

注解只做标记，标在需要幂等的接口方法上，带上场景名和过期秒数。场景名会拼进 Redis key，避免不同接口的键撞车。

```java
package com.example.idempotent.idempotent;

import java.lang.annotation.Documented;
import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

@Target(ElementType.METHOD)
@Retention(RetentionPolicy.RUNTIME)
@Documented
public @interface Idempotent {

    /** 业务场景，会拼进 Redis key，不同接口不要重名 */
    String scene();

    /** 幂等窗口，单位秒 */
    long expireSeconds() default 300;
}
```

### 3.6 Redis 守卫 IdempotentGuard

这个类封装三件事：拼 key、抢位、安全释放。Lua 脚本在类加载时就建好，不用每次请求都拼字符串。

```java
package com.example.idempotent.idempotent;

import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.script.DefaultRedisScript;
import org.springframework.data.redis.core.script.RedisScript;
import org.springframework.stereotype.Component;

import java.time.Duration;
import java.util.List;
import java.util.UUID;

@Component
public class IdempotentGuard {

    /** 只有 value 匹配才删除，防止误删别人的锁 */
    private static final RedisScript<Long> RELEASE_SCRIPT = new DefaultRedisScript<>(
            "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
            Long.class);

    private final StringRedisTemplate redisTemplate;

    public IdempotentGuard(StringRedisTemplate redisTemplate) {
        this.redisTemplate = redisTemplate;
    }

    public String buildKey(String scene, String idempotencyKey) {
        return "idem:" + scene + ":" + idempotencyKey;
    }

    /**
     * SET key value NX EX ttl，返回 true 表示抢到位置
     */
    public boolean tryAcquire(String key, String ownerToken, Duration ttl) {
        Boolean acquired = redisTemplate.opsForValue().setIfAbsent(key, ownerToken, ttl);
        return Boolean.TRUE.equals(acquired);
    }

    public void release(String key, String ownerToken) {
        redisTemplate.execute(RELEASE_SCRIPT, List.of(key), ownerToken);
    }

    public static String newOwnerToken() {
        return UUID.randomUUID().toString().replace("-", "");
    }
}
```

`setIfAbsent(key, value, Duration)` 这一行就是 `SET NX EX`，Spring Data Redis 没有把它拆成两条命令发出去。

### 3.7 拦截器 IdempotentInterceptor

拦截器在 Controller 之前跑，只做一件事：看看这个请求对应的 Redis key 还能不能抢到。抢不到就直接返回 409，业务代码一行都不执行。

```java
package com.example.idempotent.idempotent;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.stereotype.Component;
import org.springframework.web.method.HandlerMethod;
import org.springframework.web.servlet.HandlerInterceptor;

import java.io.IOException;
import java.time.Duration;

@Component
public class IdempotentInterceptor implements HandlerInterceptor {

    public static final String HEADER = "X-Idempotency-Key";
    private static final String ATTR_KEY = "IDEMPOTENT_REDIS_KEY";
    private static final String ATTR_TOKEN = "IDEMPOTENT_OWNER_TOKEN";

    private final IdempotentGuard guard;

    public IdempotentInterceptor(IdempotentGuard guard) {
        this.guard = guard;
    }

    @Override
    public boolean preHandle(HttpServletRequest request, HttpServletResponse response, Object handler)
            throws IOException {
        if (!(handler instanceof HandlerMethod handlerMethod)) {
            return true;
        }
        Idempotent annotation = handlerMethod.getMethodAnnotation(Idempotent.class);
        if (annotation == null) {
            return true;
        }

        String idempotencyKey = request.getHeader(HEADER);
        if (idempotencyKey == null || idempotencyKey.isBlank()) {
            writeJson(response, HttpServletResponse.SC_BAD_REQUEST,
                    "IDEMPOTENCY_KEY_MISSING", "请求头 X-Idempotency-Key 不能为空");
            return false;
        }

        String key = guard.buildKey(annotation.scene(), idempotencyKey);
        String ownerToken = IdempotentGuard.newOwnerToken();
        boolean acquired = guard.tryAcquire(key, ownerToken, Duration.ofSeconds(annotation.expireSeconds()));
        if (!acquired) {
            writeJson(response, HttpServletResponse.SC_CONFLICT,
                    "IDEMPOTENT_REJECTED", "同一个幂等键的请求正在处理或已处理完成");
            return false;
        }

        request.setAttribute(ATTR_KEY, key);
        request.setAttribute(ATTR_TOKEN, ownerToken);
        return true;
    }

    @Override
    public void afterCompletion(HttpServletRequest request, HttpServletResponse response,
                                Object handler, Exception ex) {
        Object key = request.getAttribute(ATTR_KEY);
        Object token = request.getAttribute(ATTR_TOKEN);
        if (!(key instanceof String redisKey) || !(token instanceof String ownerToken)) {
            return;
        }
        // 4xx/5xx 说明这次业务没成功，释放位置让用户能重试；成功则保留到 TTL 到期
        if (ex != null || response.getStatus() >= 400) {
            guard.release(redisKey, ownerToken);
        }
    }

    private void writeJson(HttpServletResponse response, int status, String code, String message)
            throws IOException {
        response.setStatus(status);
        response.setContentType("application/json;charset=UTF-8");
        response.getWriter().write(
                "{\"code\":\"" + code + "\",\"message\":\"" + message + "\",\"data\":null}");
    }
}
```

`afterCompletion` 里那个 `response.getStatus() >= 400` 很关键。参数校验失败返回 400、业务异常返回 500，这两种情况下位置必须让出来，否则用户改完参数重试还是被拒。

### 3.8 注册拦截器 WebMvcConfig

```java
package com.example.idempotent.config;

import com.example.idempotent.idempotent.IdempotentInterceptor;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.config.annotation.InterceptorRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

@Configuration
public class WebMvcConfig implements WebMvcConfigurer {

    private final IdempotentInterceptor idempotentInterceptor;

    public WebMvcConfig(IdempotentInterceptor idempotentInterceptor) {
        this.idempotentInterceptor = idempotentInterceptor;
    }

    @Override
    public void addInterceptors(InterceptorRegistry registry) {
        registry.addInterceptor(idempotentInterceptor).addPathPatterns("/api/**");
    }
}
```

### 3.9 请求和响应对象

```java
package com.example.idempotent.web;

import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;

public record OrderRequest(
        @NotBlank(message = "userId 不能为空") String userId,
        @NotBlank(message = "skuId 不能为空") String skuId,
        @Min(value = 1, message = "quantity 至少为 1") int quantity) {
}
```

```java
package com.example.idempotent.web;

public record ApiResponse<T>(String code, String message, T data) {

    public static <T> ApiResponse<T> ok(T data) {
        return new ApiResponse<>("OK", "success", data);
    }

    public static <T> ApiResponse<T> fail(String code, String message) {
        return new ApiResponse<>(code, message, null);
    }
}
```

```java
package com.example.idempotent.web;

import java.math.BigDecimal;
import java.time.LocalDateTime;

public record OrderView(
        String orderNo,
        String userId,
        String skuId,
        int quantity,
        BigDecimal amount,
        String status,
        LocalDateTime createdAt) {
}
```

### 3.10 数据访问 OrderRepository

用 `JdbcTemplate` 写，不引入 ORM，逻辑看得更清楚。用 MyBatis 或 JPA 的话，把下面几个方法换成对应实现，业务层的判断一个字都不用改。

```java
package com.example.idempotent.repository;

import com.example.idempotent.web.OrderView;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;

import java.math.BigDecimal;
import java.util.List;
import java.util.Optional;

@Repository
public class OrderRepository {

    private static final String INSERT_SQL = """
            INSERT INTO t_order (order_no, idempotency_key, user_id, sku_id, quantity, amount, status)
            VALUES (?, ?, ?, ?, ?, ?, 'PENDING')
            """;

    private static final RowMapper<OrderView> ROW_MAPPER = (rs, rowNum) -> new OrderView(
            rs.getString("order_no"),
            rs.getString("user_id"),
            rs.getString("sku_id"),
            rs.getInt("quantity"),
            rs.getBigDecimal("amount"),
            rs.getString("status"),
            rs.getTimestamp("created_at").toLocalDateTime());

    private final JdbcTemplate jdbcTemplate;

    public OrderRepository(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    public void insert(String orderNo, String idempotencyKey, String userId,
                       String skuId, int quantity, BigDecimal amount) {
        jdbcTemplate.update(INSERT_SQL, orderNo, idempotencyKey, userId, skuId, quantity, amount);
    }

    public Optional<OrderView> findByIdempotencyKey(String idempotencyKey) {
        List<OrderView> rows = jdbcTemplate.query("""
                SELECT order_no, user_id, sku_id, quantity, amount, status, created_at
                FROM t_order WHERE idempotency_key = ?
                """, ROW_MAPPER, idempotencyKey);
        return rows.stream().findFirst();
    }

    public Optional<String> findStatus(String orderNo) {
        List<String> rows = jdbcTemplate.query(
                "SELECT status FROM t_order WHERE order_no = ?",
                (rs, rowNum) -> rs.getString("status"),
                orderNo);
        return rows.stream().findFirst();
    }

    /** 只有 PENDING 才能改成 PAID，返回 0 表示已经被改过了 */
    public int markPaid(String orderNo) {
        return jdbcTemplate.update(
                "UPDATE t_order SET status = 'PAID' WHERE order_no = ? AND status = 'PENDING'",
                orderNo);
    }
}
```

### 3.11 业务层 OrderService

这里是第二层和第三层防线。`insert` 撞唯一索引时捕获 `DuplicateKeyException`，把已经存在的订单查出来返回——用户看到的是"下单成功"，而不是一个红叉。

```java
package com.example.idempotent.service;

import com.example.idempotent.repository.OrderRepository;
import com.example.idempotent.web.OrderRequest;
import com.example.idempotent.web.OrderView;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.math.BigDecimal;
import java.util.Optional;

@Service
public class OrderService {

    private static final BigDecimal UNIT_PRICE = new BigDecimal("99.00");

    private final OrderRepository orderRepository;

    public OrderService(OrderRepository orderRepository) {
        this.orderRepository = orderRepository;
    }

    @Transactional(rollbackFor = Exception.class)
    public OrderView createOrder(OrderRequest request, String idempotencyKey) {
        Optional<OrderView> existing = orderRepository.findByIdempotencyKey(idempotencyKey);
        if (existing.isPresent()) {
            return existing.get();
        }

        BigDecimal amount = UNIT_PRICE.multiply(BigDecimal.valueOf(request.quantity()));
        String orderNo = OrderNoGenerator.next();
        try {
            orderRepository.insert(orderNo, idempotencyKey, request.userId(),
                    request.skuId(), request.quantity(), amount);
        } catch (DuplicateKeyException e) {
            // 并发下两边都没查到，另一边先插进去了，这里把它的结果捞出来
            return orderRepository.findByIdempotencyKey(idempotencyKey)
                    .orElseThrow(() -> e);
        }

        return orderRepository.findByIdempotencyKey(idempotencyKey)
                .orElseThrow(() -> new IllegalStateException("订单写入后查不到：" + orderNo));
    }

    @Transactional(rollbackFor = Exception.class)
    public String pay(String orderNo) {
        int updated = orderRepository.markPaid(orderNo);
        if (updated == 1) {
            return "PAID";
        }
        return orderRepository.findStatus(orderNo)
                .orElseThrow(() -> new IllegalArgumentException("订单不存在：" + orderNo));
    }
}
```

`pay` 方法没有加锁、没有查状态再更新，就靠 `WHERE status = 'PENDING'` 这一句。第一次更新返回 1，第二次返回 0，然后查出当前状态返回 `PAID`。调用方看到的两次结果一模一样，数据库只改了一次。

`OrderNoGenerator` 单独放一个类，单机自增加随机数，生产环境换成雪花算法即可：

```java
package com.example.idempotent.service;

import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.atomic.AtomicInteger;

public final class OrderNoGenerator {

    private static final DateTimeFormatter FORMATTER = DateTimeFormatter.ofPattern("yyyyMMddHHmmssSSS");
    private static final AtomicInteger SEQ = new AtomicInteger(0);

    private OrderNoGenerator() {
    }

    public static String next() {
        return "ORD"
                + LocalDateTime.now().format(FORMATTER)
                + String.format("%04d", SEQ.incrementAndGet() % 10000)
                + ThreadLocalRandom.current().nextInt(100, 999);
    }
}
```

### 3.12 接口层 OrderController

```java
package com.example.idempotent.web;

import com.example.idempotent.idempotent.Idempotent;
import com.example.idempotent.idempotent.IdempotentInterceptor;
import com.example.idempotent.service.OrderService;
import jakarta.validation.Valid;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/orders")
public class OrderController {

    private final OrderService orderService;

    public OrderController(OrderService orderService) {
        this.orderService = orderService;
    }

    @Idempotent(scene = "order:create", expireSeconds = 600)
    @PostMapping
    public ApiResponse<OrderView> create(
            @RequestHeader(IdempotentInterceptor.HEADER) String idempotencyKey,
            @Valid @RequestBody OrderRequest request) {
        return ApiResponse.ok(orderService.createOrder(request, idempotencyKey));
    }

    @PostMapping("/{orderNo}/pay")
    public ApiResponse<String> pay(@PathVariable String orderNo) {
        return ApiResponse.ok(orderService.pay(orderNo));
    }
}
```

### 3.13 全局异常处理

```java
package com.example.idempotent.web;

import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

@RestControllerAdvice
public class GlobalExceptionHandler {

    @ExceptionHandler(MethodArgumentNotValidException.class)
    public ResponseEntity<ApiResponse<Void>> handleInvalid(MethodArgumentNotValidException ex) {
        String message = ex.getBindingResult().getFieldErrors().stream()
                .map(error -> error.getField() + ": " + error.getDefaultMessage())
                .findFirst()
                .orElse("参数校验失败");
        return ResponseEntity.badRequest().body(ApiResponse.fail("INVALID_ARGUMENT", message));
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<ApiResponse<Void>> handleOther(Exception ex) {
        return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                .body(ApiResponse.fail("INTERNAL_ERROR", ex.getMessage()));
    }
}
```

### 3.14 跑起来验证

建库、起 Redis，然后 `mvn spring-boot:run`。用同一把幂等键连发两次：

```bash
curl -i -X POST http://127.0.0.1:8080/api/orders \
  -H "Content-Type: application/json" \
  -H "X-Idempotency-Key: 8f3c9a1e2b7d4f60" \
  -d '{"userId":"u1001","skuId":"sku-88","quantity":2}'
```

第一次返回 200 和订单号。第二次拿同一把键再发，返回 409 和 `IDEMPOTENT_REJECTED`。把内容里 `quantity` 改成 `0` 再发（参数校验失败返回 400），之后改回 `2` 重发——依然能成功，说明 400 时 key 被正确释放了。

支付接口连调两次，把上一步返回的 `orderNo` 填进去：

```bash
ORDER_NO="把上一步返回的 orderNo 粘到这里"
curl -X POST "http://127.0.0.1:8080/api/orders/${ORDER_NO}/pay"
curl -X POST "http://127.0.0.1:8080/api/orders/${ORDER_NO}/pay"
```

两次都返回 `PAID`，`t_order` 里那条记录的 `updated_at` 只变了一次。

### 3.15 MQ 消费端怎么复用

HTTP 请求有拦截器，MQ 消费端没有。消费逻辑里直接把 `IdempotentGuard` 注进去用，逻辑一模一样：

```java
package com.example.idempotent.mq;

import com.example.idempotent.idempotent.IdempotentGuard;
import org.springframework.stereotype.Component;

import java.time.Duration;

@Component
public class OrderPaidConsumer {

    private final IdempotentGuard guard;

    public OrderPaidConsumer(IdempotentGuard guard) {
        this.guard = guard;
    }

    public void onMessage(String orderNo, String messageId) {
        String key = guard.buildKey("mq:order-paid", messageId);
        String token = IdempotentGuard.newOwnerToken();
        if (!guard.tryAcquire(key, token, Duration.ofHours(24))) {
            return;
        }
        boolean success = false;
        try {
            // 真正的业务：发券、加积分、发通知
            success = true;
        } finally {
            if (!success) {
                guard.release(key, token);
            }
        }
    }
}
```

MQ 的幂等键用生产者生成的 `messageId`，不要用消息体算 MD5。消息体里经常带 traceId、发送时间、重试次数，每次重投都不一样，算出来的键也就每次都不同。

## 四、踩坑经验：这七处最容易被漏掉

**1. 幂等键拼了业务字段，用户买不了第二件。**
有人图省事用 `userId:skuId`，结果同一个人想再买一件同款直接被拒。幂等键描述的是"这一次操作"，不是"这个人买了什么"。

**2. 业务失败没释放 key，用户被锁十分钟。**
`afterCompletion` 里漏了状态码判断，参数校验失败的请求也占着位置。用户改完参数再提交，600 秒内全是 409。改法就是上面那个 `response.getStatus() >= 400`。

**3. TTL 比业务耗时短，锁提前过期。**
下单要调三个下游、跑十几秒，TTL 设了 5 秒。第 6 秒锁没了，重试请求又进来一遍。TTL 至少要是 P99 耗时的 10 倍，并且业务里最好加个"续期"兜底。

**4. 只做了 Redis，没做唯一索引。**
Redis 主从异步复制，主挂了切到从，最后几百毫秒的写可能丢。丢的正好是幂等键，重复请求就穿过去了。数据库唯一索引不依赖任何缓存，这一层不能省。

**5. 唯一索引建在 `order_no` 上，没建在幂等键上。**
`order_no` 是服务端生成的，每次都不一样，天然不会冲突。真正要挡的是"同一个幂等键插两次"，所以唯一索引必须建在 `idempotency_key` 上。

**6. 网关重试时把请求头丢了。**
Nginx 的 `proxy_next_upstream` 默认会重发请求，但有些自定义网关只转发 body，`X-Idempotency-Key` 到不了后端，后端每次看到一个空值。要么在网关白名单里放行这个头，要么统一在网关层补。

**7. 事务里 catch 了 `DuplicateKeyException`，换库就崩。**
MySQL 遇到唯一键冲突只回滚当前语句，事务还能继续用，所以 catch 完还能接着查。PostgreSQL 不行，整个事务直接 abort，再查就报错。跨库迁移时这块要重写。

沉淀下来的几条规矩：

- 幂等键由客户端生成，一次业务动作一个，重试复用
- Redis 预检挡并发，TTL 覆盖"最长业务耗时 + 重试窗口"
- 成功不释放，失败（4xx/5xx）必须释放
- 释放锁用 Lua 比对 value，别裸 `DEL`
- 数据库唯一索引必须有，位置在幂等键字段上
- 有状态流转的业务，用 `UPDATE ... WHERE status = ?` 而不是先查后改
- 重复请求返回什么要定清楚：快速失败给 409，或者返回上次的结果，二选一

## 五、性能对比和技术选型

**四种方案的额外开销都在毫秒级以下，选型的依据是"能挡住哪类重复"，不是快慢。**

| 方案 | 单次额外开销 | 挡住什么 | 主要缺点 |
| --- | --- | --- | --- |
| Redis `SET NX EX` | 同机房 0.2~0.5ms | 并发重复、短时间连点 | Redis 故障时失效，需唯一索引兜底 |
| 数据库唯一索引 | 一次 B+ 树查找，约 0.1ms | 所有并发重复，强一致 | 冲突时抛异常，必须写捕获逻辑 |
| 状态机 `UPDATE ... WHERE` | 一次行锁更新 | 重复流转（支付、发货） | 只适用有状态业务 |
| 分布式锁（Redisson） | 0.5~1ms | 长事务串行化 | 粒度粗，吞吐掉得厉害 |

我的建议是组合，不是选一个：

- **写接口（下单、支付、退款）**：`@Idempotent` 注解 + Redis 预检 + 唯一索引，两层都上
- **状态流转**：`UPDATE ... WHERE status = ?`，不要先查后改
- **MQ 消费**：用 `messageId` 做键，TTL 按消息保留期设
- **读接口**：不用做，天然幂等
- **分布式锁**：留给"同一资源串行处理"的场景，比如库存扣减，别拿它当幂等方案

还有个常被忽略的点：幂等键的存储本身要有高可用。Redis 用集群或哨兵，别用单机；数据库唯一索引是最后防线，它挂了整个系统都挂了，那是另一个层面的问题。

## 六、总结

接口幂等的本质是"原子占位 + 唯一约束 + 状态判断"，三层叠加才不漏。

落地就四步：客户端生成 `X-Idempotency-Key` 并透传到后端；拦截器用 `SET NX EX` 抢位，抢不到直接 409；数据库在幂等键上建唯一索引，捕获 `DuplicateKeyException` 后查回已有记录返回；状态流转用 `WHERE status = ?` 的条件更新。

最容易翻车的地方不在代码，在细节：TTL 设短了、失败没释放、唯一索引建错字段、网关把请求头吃了。这几个坑我都在线上见过，改起来都是几行代码，但排查起来能耗掉一整天。

最后说一句什么时候不用做：只读接口、天然幂等的 `PUT`/`DELETE`、以及"每次调用都必须产生新数据"的接口（比如记流水账），都不需要幂等键。别为了统一，给所有接口都套一层 Redis，白扛一次网络往返。

## 参考资料

- [SET | Redis 官方命令参考](https://redis.io/docs/latest/commands/set/)
- [Spring Data Redis Reference](https://docs.spring.io/spring-data/redis/reference/)
- [Interceptors | Spring Framework Reference](https://docs.spring.io/spring-framework/reference/web/webmvc/mvc-config/interceptors.html)
- [MySQL 8.4 Reference Manual: CREATE INDEX Statement](https://dev.mysql.com/doc/refman/8.4/en/create-index.html)
- [RFC 9110: HTTP Semantics - Idempotent Methods](https://www.rfc-editor.org/rfc/rfc9110.html)

文 / 会编程的吕洞宾
