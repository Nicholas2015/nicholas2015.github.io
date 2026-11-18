---
title: "OpenFeign超时配置不生效？到底错在哪"
date: 2026-10-10T09:00:00+08:00
category: "Spring"
tags: ["spring-cloud"]
---

> 线上有个接口偶尔要卡满 60 秒才报错。你翻出 application.yml，明明写了 readTimeout: 3000，感觉跟没配一样，本地却怎么都复现不出来。真到线上抓下来一看，那 60 秒是 Feign 自带的默认值——你写的那行配置压根没绑到发起调用的客户端上。这篇把 Feign 超时的三层来源、配置到底绑给谁，以及一套能直接跑起来的复现代码讲清楚。

## 一、这个问题到底是什么

**Feign 超时"配了不生效"，多数不是值写错，而是没绑到对的服务上，或者只改了其中一层超时。**

一个 HTTP 调用，时间花在三段上：

- 选出目标服务在哪台机器；
- 跟对方把 TCP 连接建起来；
- 把请求发出去，然后等对方把响应吐回来。

三段各自都可能超时，配置项还不在一个地方。很多人只配了中间一段，另外两段还在用默认值，"我明明配了 3 秒"和"它等了 60 秒"就能同时成立。

说个真事。订单服务调用户服务，用户服务有个报表接口偶尔跑几十秒。为了不让订单服务被拖死，同事在 application.yml 里加了这么一段：

```yaml
feign:
  client:
    config:
      user-service:
        readTimeout: 3000
```

上线后接口还是卡满 60 秒。查下来两件事凑一块了。

一是那个 Feign 客户端真实名字叫 userClient，配置里写的 user-service 跟它对不上，配置等于摆设；二是就算名字对上了，等响应这一段的默认值本来就是 60 秒，刚好是现象里那个数字。

名字对不上时，Spring 不报错也不警告，直接跳过这行配置，用默认值。这就是最坑的地方：**配置错了不报错，只是"看起来没生效"**。

默认值 Feign 自己带了一套：

| 超时段 | 默认值 | 谁在管 |
| --- | --- | --- |
| 建立连接 | 10 秒 | Feign 的 Request.Options |
| 等响应返回 | 60 秒 | Feign 的 Request.Options |
| 从连接池拿连接 | 取决于底层客户端 | 底层 HTTP 客户端 |

看到 60 秒，眼熟吧。很多"偶发慢查询""莫名卡一分钟"，根子就在这。

排查步骤其实很固定。先把 Feign 客户端所在包的日志级别开成 debug，让它把真实的超时原因，是"连接超时"还是"读超时"，打出来：

```yaml
logging:
  level:
    com.example.consumer.client: debug
```

拿到原因，再去对上那一层的配置项。别一上来就调大超时，那只是把问题从 3 秒挪到 60 秒。

## 二、底层原理到底怎么回事

**一次 Feign 调用会依次经过"选实例、建连接、等响应"三步，每一步都有自己的超时，改错层等于没改。**

先把完整链路走一遍。

1. @FeignClient 接口被 Spring 扫描成代理对象。你按普通方法去调，实际进的是 SynchronousMethodHandler。
2. Handler 把参数拼成一个 feign.Request，交给 feign.Client 这个接口去发。Client 才是真正碰网络的那层。
3. 接口上写的是服务名（@FeignClient(name = "...")）时，第 2 步外面还套了一层 FeignBlockingLoadBalancerClient：它先让 LoadBalancer 从实例列表里挑一台机器，拼出真实 URL，再交给底层 Client。
4. 底层 Client 建立连接、写请求、读响应。

超时就分散在第 3、4 步。

### 2.1 connectTimeout 和 readTimeout 各管哪段

官方文档对这两个属性的解释翻成人话就是：

- connectTimeout：从"开始连"到"连上"最多等多久。防的是对方机器不可达、网络不通，调用方一直卡在连接阶段。
- readTimeout：连接建好之后，从"开始等响应"到"拿到完整响应"最多等多久。防的是对方处理太慢。

有个反直觉的点：connectTimeout 是在连接池这一层生效的。底层客户端带连接池、池里有现成连接时，这一步几乎瞬间完成，你配的 connect 值根本用不上。想验证连接超时，得让目标地址真的连不上。

### 2.2 配置怎么绑到具体服务

配置前缀是 spring.cloud.openfeign.client.config，下面分 default 和 feignName 两级：

```yaml
spring:
  cloud:
    openfeign:
      client:
        config:
          default:
            connect-timeout: 1000
            read-timeout: 1000
```

default 对所有客户端生效，feignName 只对某一个生效，后者优先级更高。

feignName 到底是什么，取决于 @FeignClient 怎么写：

| 注解写法 | 配置里的 key |
| --- | --- |
| @FeignClient(name = "userClient") | userClient |
| @FeignClient(name = "userClient", contextId = "userV1") | userV1 |

同一个 name 被多个接口复用时，必须用 contextId 区分。一旦用了 contextId，配置 key 就变成 contextId 的值，名字对不上，配置再次悄悄失效。

### 2.3 底层 HTTP 客户端会改变超时的表现

Feign 默认用 JDK 自带的 HTTP 客户端发请求。类路径上有 Apache HttpClient 5 对应的 Feign 模块时，它会自动切过去，也可以用 spring.cloud.openfeign.httpclient.hc5.enabled=false 关掉。

换不换，差别不小：

- JDK 默认实现每次请求的开销、连接复用能力都有限；
- Apache HttpClient 5 带连接池，可以用 spring.cloud.openfeign.httpclient.* 系列属性配最大连接数、连接存活时间。

连接池一旦被打满，新请求会排队等连接，监控上看起来也像"超时"，但根因根本不是网络慢。只盯着 Feign 那两个超时值调，永远调不到它。

### 2.4 重试是另一层，别和超时混为一谈

Feign 自己的重试默认是关着的。官方文档写得很直白：默认会注册一个 Retryer.NEVER_RETRY，也就是不重试。注意这跟 Feign 原生行为不同，原生会重试 IOException。

但在服务名调用下，外层还有 LoadBalancer 的重试，开关是 spring.cloud.loadbalancer.retry.enabled。

两层职责不一样：超时决定单次尝试等多久，重试决定失败后要不要再来一次。写接口（下单、扣库存）要特别小心，重试一触发就是重复请求。

## 三、实战：手把手搭一个能复现超时的项目

为了让你亲手看到"配了 1 秒就 1 秒失败"，下面搭两个服务：提供方故意提供慢接口，调用方把超时压到 1 秒。项目结构：

```text
feign-timeout-demo/
├── provider-service/       被调用方，端口 8081
│   ├── pom.xml
│   └── src/main/
│       ├── java/com/example/provider/
│       │   ├── ProviderApplication.java
│       │   └── controller/SlowController.java
│       └── resources/application.yml
└── consumer-service/       调用方，端口 8080
    ├── pom.xml
    └── src/main/
        ├── java/com/example/consumer/
        │   ├── ConsumerApplication.java
        │   ├── client/ProviderClient.java
        │   ├── client/UnreachableClient.java
        │   └── controller/CallController.java
        └── resources/application.yml
```

为了不依赖注册中心就能跑，实例列表用 Spring Cloud 自带的 SimpleDiscoveryClient，直接在 yml 里写地址。真实环境换成 Nacos 或 Eureka，超时那几行配置一个字都不用改。

### 3.1 提供方 provider-service

**pom.xml**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
    <modelVersion>4.0.0</modelVersion>

    <parent>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-parent</artifactId>
        <version>4.0.7</version>
        <relativePath/>
    </parent>

    <groupId>com.example</groupId>
    <artifactId>provider-service</artifactId>
    <version>1.0.0</version>
    <name>provider-service</name>

    <properties>
        <java.version>21</java.version>
    </properties>

    <dependencies>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-web</artifactId>
            <version>4.0.7</version>
        </dependency>
    </dependencies>

    <build>
        <plugins>
            <plugin>
                <groupId>org.springframework.boot</groupId>
                <artifactId>spring-boot-maven-plugin</artifactId>
                <version>4.0.7</version>
            </plugin>
        </plugins>
    </build>
</project>
```

**application.yml**

```yaml
server:
  port: 8081

spring:
  application:
    name: provider-service
```

**ProviderApplication.java**

```java
package com.example.provider;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class ProviderApplication {

    public static void main(String[] args) {
        SpringApplication.run(ProviderApplication.class, args);
    }
}
```

**SlowController.java**

```java
package com.example.provider.controller;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class SlowController {

    @GetMapping("/fast")
    public String fast() {
        return "fast-ok";
    }

    @GetMapping("/slow")
    public String slow(@RequestParam(name = "ms", defaultValue = "3000") long ms) throws InterruptedException {
        Thread.sleep(ms);
        return "slow-ok after " + ms + "ms";
    }
}
```

/slow 接口按传入的毫秒数睡一会儿再返回，专门用来制造"对方处理太慢"的场景。

### 3.2 调用方 consumer-service

**pom.xml**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
    <modelVersion>4.0.0</modelVersion>

    <parent>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-parent</artifactId>
        <version>4.0.7</version>
        <relativePath/>
    </parent>

    <groupId>com.example</groupId>
    <artifactId>consumer-service</artifactId>
    <version>1.0.0</version>
    <name>consumer-service</name>

    <properties>
        <java.version>21</java.version>
        <spring-cloud.version>2025.1.2</spring-cloud.version>
    </properties>

    <dependencyManagement>
        <dependencies>
            <dependency>
                <groupId>org.springframework.cloud</groupId>
                <artifactId>spring-cloud-dependencies</artifactId>
                <version>${spring-cloud.version}</version>
                <type>pom</type>
                <scope>import</scope>
            </dependency>
        </dependencies>
    </dependencyManagement>

    <dependencies>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-web</artifactId>
            <version>4.0.7</version>
        </dependency>
        <dependency>
            <groupId>org.springframework.cloud</groupId>
            <artifactId>spring-cloud-starter-openfeign</artifactId>
            <version>5.0.2</version>
        </dependency>
        <dependency>
            <groupId>org.springframework.cloud</groupId>
            <artifactId>spring-cloud-starter-loadbalancer</artifactId>
            <version>5.0.2</version>
        </dependency>
    </dependencies>

    <build>
        <plugins>
            <plugin>
                <groupId>org.springframework.boot</groupId>
                <artifactId>spring-boot-maven-plugin</artifactId>
                <version>4.0.7</version>
            </plugin>
        </plugins>
    </build>
</project>
```

注意 spring-cloud-starter-loadbalancer 是单独加的。spring-cloud-starter-openfeign 把它当可选依赖，漏了它，服务名调用会直接失败，报找不到实例。

**application.yml**

```yaml
server:
  port: 8080

spring:
  application:
    name: consumer-service
  cloud:
    discovery:
      client:
        simple:
          instances:
            provider-service:
              - uri: http://localhost:8081
            unreachable-service:
              - uri: http://10.255.255.1:9999
    openfeign:
      client:
        config:
          default:
            connect-timeout: 1000
            read-timeout: 1000
            logger-level: basic
          provider-service:
            connect-timeout: 1000
            read-timeout: 1000
          unreachable-service:
            connect-timeout: 1000
            read-timeout: 1000

logging:
  level:
    com.example.consumer.client: debug
```

这里刻意把 connect-timeout 和 read-timeout 都压到 1000 毫秒。unreachable-service 指向一个不可路由的地址，专门用来触发连接超时。

**ConsumerApplication.java**

```java
package com.example.consumer;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.cloud.openfeign.EnableFeignClients;

@SpringBootApplication
@EnableFeignClients
public class ConsumerApplication {

    public static void main(String[] args) {
        SpringApplication.run(ConsumerApplication.class, args);
    }
}
```

**ProviderClient.java**

```java
package com.example.consumer.client;

import org.springframework.cloud.openfeign.FeignClient;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;

@FeignClient(name = "provider-service")
public interface ProviderClient {

    @GetMapping("/fast")
    String fast();

    @GetMapping("/slow")
    String slow(@RequestParam(name = "ms") long ms);
}
```

**UnreachableClient.java**

```java
package com.example.consumer.client;

import org.springframework.cloud.openfeign.FeignClient;
import org.springframework.web.bind.annotation.GetMapping;

@FeignClient(name = "unreachable-service")
public interface UnreachableClient {

    @GetMapping("/fast")
    String fast();
}
```

**CallController.java**

```java
package com.example.consumer.controller;

import com.example.consumer.client.ProviderClient;
import com.example.consumer.client.UnreachableClient;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class CallController {

    private static final Logger log = LoggerFactory.getLogger(CallController.class);

    private final ProviderClient providerClient;
    private final UnreachableClient unreachableClient;

    public CallController(ProviderClient providerClient, UnreachableClient unreachableClient) {
        this.providerClient = providerClient;
        this.unreachableClient = unreachableClient;
    }

    @GetMapping("/call/fast")
    public String callFast() {
        return providerClient.fast();
    }

    @GetMapping("/call/slow")
    public String callSlow(@RequestParam(name = "ms", defaultValue = "3000") long ms) {
        long start = System.currentTimeMillis();
        try {
            String body = providerClient.slow(ms);
            return body + " | cost=" + (System.currentTimeMillis() - start) + "ms";
        } catch (Exception e) {
            log.warn("call slow failed", e);
            return "FAILED after " + (System.currentTimeMillis() - start) + "ms, ex="
                    + e.getClass().getName()
                    + ", cause=" + (e.getCause() == null ? "null" : e.getCause().getClass().getName());
        }
    }

    @GetMapping("/call/unreachable")
    public String callUnreachable() {
        long start = System.currentTimeMillis();
        try {
            return unreachableClient.fast();
        } catch (Exception e) {
            return "FAILED after " + (System.currentTimeMillis() - start) + "ms, ex="
                    + e.getClass().getName()
                    + ", cause=" + (e.getCause() == null ? "null" : e.getCause().getClass().getName());
        }
    }
}
```

三个接口各自演一个场景：成功调用、读超时、连接超时。返回值里带上实际耗时和异常类名，一眼就能看出是哪一层在超时。

### 3.3 跑起来验证

两个终端，分别启动：

```bash
cd provider-service && mvn spring-boot:run
cd consumer-service && mvn spring-boot:run
```

再开一个终端，逐个敲：

```bash
# 1. 正常调用，秒回
curl http://localhost:8080/call/fast
# 输出：fast-ok

# 2. 对方要睡 3 秒，但读超时只有 1 秒，会在 1 秒左右失败
curl "http://localhost:8080/call/slow?ms=3000"
# 输出：FAILED after 1015ms, ex=feign.RetryableException, cause=java.net.SocketTimeoutException

# 3. 目标地址连不上，连接超时同样约 1 秒
curl http://localhost:8080/call/unreachable
# 输出：FAILED after 1003ms, ex=feign.RetryableException, cause=java.net.SocketTimeoutException
```

看到耗时停在 1000 毫秒出头，说明你配的值真的生效了。想确认配置确实绑到了这个客户端，把 consumer 的 read-timeout 改成 5000 重启，再打第 2 个请求，这次会成功，cost 约 3000 毫秒。改配置前后耗时对得上，配置就是挂上去了。

## 四、踩坑经验和最佳实践

**超时排查的顺序应该固定：先确认异常类型，再核对配置 key，最后才动数值。**

### 4.1 名字对不上，配置静默失效

这是最高频的坑。@FeignClient 的 name、contextId 和配置里的 feignName 必须完全一致。用了 contextId 却还在按 name 写配置，同样白配。验证办法就一个：改小超时，看耗时有没有跟着变。没变就是没绑上。

### 4.2 忘了加 spring-cloud-starter-loadbalancer

spring-cloud-starter-openfeign 把负载均衡器当可选依赖，官方文档明确要求自己补上 spring-cloud-starter-loadbalancer。漏了它，服务名调用会直接报找不到实例，而不是超时，报错信息还容易让人以为是注册中心的问题。

### 4.3 只盯 Feign 超时，忽略连接池

默认的 JDK HTTP 客户端连接复用能力有限。并发一上来，请求会卡在"等一个可用连接"上，表现出来也是超时。加 Apache HttpClient 5 的 Feign 模块并用 spring.cloud.openfeign.httpclient.* 系列属性把连接数配起来，是这个场景的正解。

### 4.4 read-timeout 要一层比一层短

链路超时要逐层递减：网关 5 秒、业务服务 3 秒、下游依赖 1 秒。反过来的话，下游早就没响应了，上游还在傻等，白白占着线程。

### 4.5 写接口慎开重试

超时是"等多久"，重试是"要不要再来一次"。对下单、扣库存这类写操作，重试意味着重复请求。要么关掉重试，要么让接口本身幂等，别指望调用方帮你兜住。

## 五、性能对比和技术选型

**超时值没有放之四海皆准的答案，但"逐层递减"是硬规矩。**

| 场景 | connect-timeout | read-timeout |
| --- | --- | --- |
| 普通查询接口 | 1000ms | 2000-3000ms |
| 报表、导出类接口 | 1000ms | 单独一个 clientId，放到 30000ms 以上 |
| 内部强依赖 | 500-1000ms | 1000ms 内，宁可快速失败 |

底层客户端怎么选：

- 并发不高、调用简单的内部接口，用 Feign 默认实现就够，少一个依赖少一份麻烦。
- 并发明显、需要连接复用的，加 Apache HttpClient 5 的 Feign 模块，用连接池把开销压下去。

新项目也可以看看 Spring 自带的声明式 HTTP 客户端（HTTP Interface）配 RestClient，少一层 Feign 依赖，底层直接是 JDK 的 HTTP 客户端。存量系统里 Feign 已经铺开的，别为了迁移而迁移，先把超时理顺，收益更实在。

## 六、总结

超时这个问题，难就难在"不报错"。配错了不会有人提醒你，只是行为跟预期不一样。

三个要点记住就够了：

1. 超时按层查：选实例、建连接、等响应，各自对应不同的配置项，改错层等于没改。
2. 配置 key 必须和 @FeignClient 的 name 或 contextId 对上。对不上，Spring 一声不吭地跳过。
3. Feign 默认 connect 10 秒、read 60 秒，60 秒的"莫名卡死"多半就是它。数值要逐层递减，写接口慎开重试。

下次再碰到"我明明配了却不生效"，先别急着调大数值，回头看看配置到底挂在哪个客户端上。

## 参考资料

- [Spring Cloud OpenFeign Reference Documentation](https://docs.spring.io/spring-cloud-openfeign/reference/spring-cloud-openfeign.html)
- [Spring Cloud Commons - Spring Cloud LoadBalancer](https://docs.spring.io/spring-cloud-commons/reference/spring-cloud-commons/loadbalancer.html)

文 / 会编程的吕洞宾
