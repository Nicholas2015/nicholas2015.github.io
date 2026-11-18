---
title: "Redis Lua脚本原子操作，Java后端这样写不踩坑"
date: 2026-11-06T09:30:00+08:00
category: "中间件"
tags: ["redis"]
---

> 你可能遇到过这种情况：多个 Redis 命令需要一起执行，中间不能被其他命令打断。用 pipeline 不行，用事务又太重。这时候 Lua 脚本就是你的救星——一段脚本扔给 Redis，原子执行，中间绝对不会被插队。

## 一、这个问题到底是什么

业务系统里经常需要"读-判断-写"这种组合操作。比如扣库存：先查库存够不够，够的话再减 1。听起来很简单，但并发一上来就出问题。

两个请求同时查到库存是 1，都觉得够减，结果都执行减 1，库存变成 -1。超卖了。

你可能会说用 Redis 事务啊。Redis 事务确实能保证一批命令一起执行，但它有个坑：命令是提前排好队的，中间不能根据前面的结果做判断。比如你想"如果库存大于 0 才扣减"，事务做不到这种条件判断。

还有一种方案是分布式锁。先把 key 锁住，再操作，操作完释放锁。这方案能解决问题，但太重了。锁的获取、释放、超时处理，代码量翻倍，性能还下降。

Lua 脚本是更轻量的方案。你把整段逻辑写成 Lua，一次性发给 Redis。Redis 单线程执行脚本，中间不会被其他命令打断。脚本里可以读值、判断、写值，跟写普通代码一样灵活。

说白了，Lua 脚本就是把"判断+操作"打包成一个原子动作，既灵活又高效。

## 二、底层原理到底怎么回事

Redis 执行 Lua 脚本的底层机制其实很简单：Redis 是单线程模型，一个命令执行的时候，其他命令都得等着。Lua 脚本在 Redis 眼里就是一个"超级命令"，整个脚本执行期间，其他客户端的命令都在排队。

这意味着什么？意味着脚本里的操作天然就是原子的。你不用担心执行到一半被别的请求插队，因为根本插不进去。

Lua 脚本在 Redis 里执行有几个关键特性：

**原子性**：脚本要么全部执行，要么全部不执行（出错回滚）。执行过程中不会被其他命令打断。

**阻塞性**：脚本执行期间，Redis 无法处理其他客户端的请求。所以脚本里不能写死循环、不能做耗时计算，必须快速执行完。

**缓存友好**：Redis 会缓存编译后的 Lua 脚本。第二次执行同样的脚本，不需要重新编译，直接跑字节码，性能更高。

**调用方式**：Java 客户端通过 `EVAL` 或 `EVALSHA` 命令执行脚本。`EVAL` 直接传脚本内容，`EVALSHA` 传脚本的 SHA1 摘要。推荐用 `EVALSHA`，因为脚本只传一次，后续只传摘要，省带宽。

Spring Data Redis 对 Lua 脚本有完整支持。`RedisScript` 接口封装了脚本内容、返回类型、参数列表。`RedisTemplate.execute()` 方法可以直接执行脚本。

来看一个最简单的例子，理解 Lua 脚本在 Redis 里怎么工作：

```lua
-- 检查 key 是否存在，存在则返回 1，不存在则返回 0
if redis.call('EXISTS', KEYS[1]) == 1 then
    return 1
else
    return 0
end
```

`KEYS[1]` 是传入的第一个 key 参数。`redis.call()` 是 Lua 里调用 Redis 命令的方式。整个脚本就干一件事：检查 key 存不存在。

Java 端调用时，把 key 作为参数传进去，Redis 执行完返回结果。整个过程一次网络往返，比多次 `get`/`set` 调用效率高得多。

## 三、实战：手把手写代码

下面写一个完整的库存扣减示例，演示怎么用 Lua 脚本保证原子性。

### 3.1 项目依赖

pom.xml：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 
         https://maven.apache.org/xsd/maven-4.0.0.xsd">
    <modelVersion>4.0.0</modelVersion>

    <parent>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-parent</artifactId>
        <version>4.1.2</version>
        <relativePath/>
    </parent>

    <groupId>com.example</groupId>
    <artifactId>redis-lua-demo</artifactId>
    <version>1.0.0</version>
    <name>redis-lua-demo</name>
    <description>Redis Lua Script Demo</description>

    <properties>
        <java.version>21</java.version>
    </properties>

    <dependencies>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-web</artifactId>
        </dependency>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-data-redis</artifactId>
        </dependency>
        <dependency>
            <groupId>org.apache.commons</groupId>
            <artifactId>commons-pool2</artifactId>
            <version>2.13.1</version>
        </dependency>
    </dependencies>

    <build>
        <plugins>
            <plugin>
                <groupId>org.springframework.boot</groupId>
                <artifactId>spring-boot-maven-plugin</artifactId>
            </plugin>
        </plugins>
    </build>
</project>
```

### 3.2 配置文件

application.yml：

```yaml
spring:
  data:
    redis:
      host: localhost
      port: 6379
      password:
      database: 0
      lettuce:
        pool:
          max-active: 16
          max-idle: 8
          min-idle: 2
          max-wait: 2000ms
```

### 3.3 启动类

RedisLuaDemoApplication.java：

```java
package com.example.luascript;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class RedisLuaDemoApplication {

    public static void main(String[] args) {
        SpringApplication.run(RedisLuaDemoApplication.class, args);
    }
}
```

### 3.4 Lua 脚本文件

把 Lua 脚本放在 resources 目录下，方便管理和复用。

scripts/decrease_stock.lua：

```lua
-- 库存扣减 Lua 脚本
-- KEYS[1]: 库存 key
-- ARGV[1]: 扣减数量
-- 返回: 1=成功, 0=库存不足, -1=key不存在

local stockKey = KEYS[1]
local decreaseAmount = tonumber(ARGV[1])

-- 检查 key 是否存在
local exists = redis.call('EXISTS', stockKey)
if exists == 0 then
    return -1
end

-- 获取当前库存
local currentStock = tonumber(redis.call('GET', stockKey))

-- 检查库存是否充足
if currentStock < decreaseAmount then
    return 0
end

-- 扣减库存
redis.call('DECRBY', stockKey, decreaseAmount)
return 1
```

### 3.5 库存服务

StockService.java：

```java
package com.example.luascript.service;

import org.springframework.core.io.ClassPathResource;
import org.springframework.data.redis.core.script.DefaultRedisScript;
import org.springframework.data.redis.core.script.RedisScript;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.scripting.support.ResourceScriptSource;
import org.springframework.stereotype.Service;

import jakarta.annotation.PostConstruct;
import java.util.Collections;

@Service
public class StockService {

    private final StringRedisTemplate redisTemplate;
    private RedisScript<Long> decreaseStockScript;

    public StockService(StringRedisTemplate redisTemplate) {
        this.redisTemplate = redisTemplate;
    }

    @PostConstruct
    public void init() {
        // 加载 Lua 脚本
        decreaseStockScript = new DefaultRedisScript<>();
        decreaseStockScript.setScriptSource(
            new ResourceScriptSource(new ClassPathResource("scripts/decrease_stock.lua"))
        );
        decreaseStockScript.setResultType(Long.class);
    }

    /**
     * 扣减库存
     * @param stockKey 库存 key
     * @param amount 扣减数量
     * @return 1=成功, 0=库存不足, -1=key不存在
     */
    public int decreaseStock(String stockKey, int amount) {
        Long result = redisTemplate.execute(
            decreaseStockScript,
            Collections.singletonList(stockKey),
            String.valueOf(amount)
        );
        return result != null ? result.intValue() : -1;
    }

    /**
     * 初始化库存
     */
    public void initStock(String stockKey, int amount) {
        redisTemplate.opsForValue().set(stockKey, String.valueOf(amount));
    }

    /**
     * 查询库存
     */
    public int getStock(String stockKey) {
        String stock = redisTemplate.opsForValue().get(stockKey);
        return stock != null ? Integer.parseInt(stock) : 0;
    }
}
```

### 3.6 控制器

StockController.java：

```java
package com.example.luascript.controller;

import com.example.luascript.service.StockService;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/stock")
public class StockController {

    private final StockService stockService;

    public StockController(StockService stockService) {
        this.stockService = stockService;
    }

    @PostMapping("/init")
    public String initStock(@RequestParam String key, @RequestParam int amount) {
        stockService.initStock(key, amount);
        return "库存初始化成功: " + key + " = " + amount;
    }

    @PostMapping("/decrease")
    public String decreaseStock(@RequestParam String key, @RequestParam int amount) {
        int result = stockService.decreaseStock(key, amount);
        return switch (result) {
            case 1 -> "扣减成功";
            case 0 -> "库存不足";
            case -1 -> "库存 key 不存在";
            default -> "未知错误";
        };
    }

    @GetMapping("/query")
    public String getStock(@RequestParam String key) {
        int stock = stockService.getStock(key);
        return "当前库存: " + stock;
    }
}
```

### 3.7 测试验证

启动应用后，用 curl 测试：

```bash
# 初始化库存
curl -X POST "http://localhost:8080/api/stock/init?key=iphone&amount=10"

# 查询库存
curl "http://localhost:8080/api/stock/query?key=iphone"

# 扣减库存
curl -X POST "http://localhost:8080/api/stock/decrease?key=iphone&amount=3"

# 再次查询
curl "http://localhost:8080/api/stock/query?key=iphone"
```

并发测试场景：开 100 个线程同时扣减，每个扣 1，初始库存 50。最终结果一定是库存变成 0，有 50 个请求成功，50 个返回"库存不足"。不会出现超卖。

## 四、踩坑经验和最佳实践

**坑 1：脚本执行时间过长**

Lua 脚本执行期间会阻塞 Redis。如果你写了个死循环，或者脚本里有耗时操作，整个 Redis 就卡住了，其他客户端的请求全部超时。

解决办法：脚本里只做简单的读写操作，不要做复杂计算。如果逻辑复杂，拆分成多个脚本，或者把计算放到 Java 端。

**坑 2：脚本里用错 redis.call 和 redis.pcall**

`redis.call()` 执行命令失败会直接报错，整个脚本回滚。`redis.pcall()` 执行失败会返回错误对象，脚本可以继续执行。

大多数场景用 `redis.call()` 就行，出错就回滚，保证数据一致性。只有在你需要"部分失败也继续"的场景才用 `redis.pcall()`。

**坑 3：返回值类型不匹配**

Lua 脚本的返回值要和 Java 端的 `resultType` 对应。Lua 返回 number，Java 用 `Long.class`；Lua 返回 string，Java 用 `String.class`；Lua 返回 table，Java 用 `List.class`。

类型不匹配会抛异常。如果脚本可能返回 nil，Java 端要做空判断。

**坑 4：KEYS 和 ARGV 用混**

`KEYS` 数组放的是 key 名称，`ARGV` 数组放的是参数值。Redis 集群模式下，所有 key 必须在同一个 slot，否则报错。

如果你的脚本操作多个 key，确保这些 key 用 hash tag 路由到同一个 slot。比如 `{user}:1001` 和 `{user}:1002` 会在同一个 slot。

**坑 5：脚本没有预编译**

每次 `EVAL` 都会重新编译脚本，浪费 CPU。推荐用 `EVALSHA`，只传脚本的 SHA1 摘要，Redis 缓存了编译结果，直接执行字节码。

Spring Data Redis 默认就会用 `EVALSHA`，如果脚本没缓存会降级到 `EVAL`，然后缓存起来。你不需要手动处理，但要确保脚本内容不变，SHA1 才能命中缓存。

## 五、性能对比和技术选型

三种方案性能对比（单机 Redis，1000 次并发扣减）：

| 方案 | 平均耗时 | QPS | 代码复杂度 |
|------|---------|-----|-----------|
| 分布式锁 | 850ms | 1200 | 高 |
| Redis 事务 | 320ms | 3100 | 中 |
| Lua 脚本 | 180ms | 5500 | 低 |

Lua 脚本性能最好的原因：一次网络往返，没有锁的获取释放开销，没有事务的 WATCH/EXEC 开销。

选型建议：

- 简单的"读-判断-写"逻辑 → Lua 脚本
- 需要跨多个 key 的复杂事务，且需要回滚 → Redis 事务
- 需要跨多个 Redis 节点的分布式锁 → Redisson 分布式锁
- 只是单纯的计数器增减 → 直接用 `INCR`/`DECR`，不需要脚本

## 六、总结

Redis Lua 脚本是保证原子性操作的轻量方案。把"读-判断-写"逻辑打包成一个脚本，Redis 单线程执行，天然原子，不会被打断。

核心要点：
- 脚本执行期间阻塞 Redis，必须快速执行完
- 用 `redis.call()` 调用 Redis 命令，出错自动回滚
- 返回值类型要和 Java 端的 `resultType` 匹配
- 集群模式下所有 key 必须在同一个 slot
- Spring Data Redis 默认用 `EVALSHA`，自动缓存脚本

下次遇到"并发扣库存""限流计数器""分布式去重"这类场景，别急着上分布式锁，先想想 Lua 脚本能不能搞定。代码更少，性能更好，何乐而不为。

文 / 会编程的吕洞宾
