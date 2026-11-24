---
title: "微服务下线了还在被调用，Java后端先查这4处"
date: 2026-11-14T09:00:00+08:00
category: "Spring"
tags: ["spring-cloud"]
---

> 周四晚上线，滚动重启第一台机器。运维在群里说“这台已经停了”，监控上的 502 却还在往上冒，持续了将近两分钟。翻调用方日志，请求打向的是一个已经关掉的端口。不是注册中心坏了，也不是负载均衡配错了，是“服务下线”这件事从来不是瞬时生效的。一台实例从停止到被所有调用方彻底遗忘，中间要穿过四层缓存。这篇把这几层的时间账算清楚，再给一套能直接跑的复现工程和下线脚本。

## 一、这个问题到底是什么

**服务下线是一条传播链，不是一个开关。** 注册中心知道某台实例没了，和调用方停止给它发请求，中间隔着秒级到分钟级的延迟。

先看一个很多人都遇到过的发布现场：

- 20:00 开始滚动发布，第一台实例收到 SIGTERM，进程正常退出
- 20:00:03 运维确认容器已停，开始等健康检查
- 20:00:10 监控出现第一批 `Connection refused`
- 20:01:30 错误率回落到 0，发布继续推第二台
- 20:03 同样的曲线再来一遍

每一台机器都“优雅”地停了，错误却一次没少。原因不复杂：停止动作是瞬间的，缓存过期是慢的。

### 三个容易形成的错觉

| 错觉 | 实际情况 |
| --- | --- |
| 调了 `/actuator/shutdown` 或 `kill` 就没人调了 | 反注册只是通知注册中心，调用方本地还有缓存 |
| 注册中心是关键路径，挂了服务就废 | Eureka 客户端本地存着完整注册表，注册中心短时间挂掉照样能调 |
| 重启快一点就不会有影响 | 重启越快，缓存里留下的“死人”越多，反而更容易打到空端口 |

第三个错觉最反直觉。慢吞吞停十分钟，缓存早就自然过期了；三秒钟停完，调用方还拿着旧名单挨个轮询。

### 四层缓存，四段时间

一台实例从“停止服务”到“全网不再有流量”，要穿过下面四层：

| 层 | 谁在缓存 | 默认时长 | 存在的理由 |
| --- | --- | --- | --- |
| 租约与心跳 | Eureka 服务端 | 心跳 30 秒一次，90 秒没心跳判死 | 网络抖动不能立刻踢人 |
| 服务端只读缓存 | Eureka 服务端 | 30 秒同步一次 | 注册表读多写少，避免每次读都抢锁 |
| 客户端注册表 | 调用方 JVM | 30 秒拉一次增量 | 注册中心不可用时仍能调用 |
| 负载均衡实例缓存 | 调用方 JVM | 35 秒 | 避免每次请求都查一遍注册表 |

这四段不是并行的，是串起来的。正常反注册的场景，最坏要等 30 + 30 + 35 ≈ 95 秒。如果是 `kill -9`、断电、容器被直接杀掉，还要先等 90 秒租约过期，再加最多 60 秒的清理扫描，最坏接近 4 分钟。

你在监控上看到的“下线后还有两分钟流量”，就是这么来的。

## 二、底层原理到底怎么回事

**Eureka 是拉模式，调用方主动来问，注册中心不会主动喊。** 这决定了所有延迟的下限。

### 注册中心不是公告板，是“每 30 秒来一次的公告板”

打个比方：小区门口有块公告栏，物业往上贴“3 号楼电梯维修”。但住户不是实时收到通知，而是每 30 秒下楼看一次。你贴得再快，也有人要等到下一次下楼才知道。

Eureka 就是这个模型。服务启动时向注册中心 `POST` 自己的信息，之后每 30 秒发一次心跳续约；调用方每 30 秒 `GET` 一次注册表增量。中间没有任何推送通道。

这种设计换来的是可用性：注册中心挂了，调用方手里的名单还能用；网络分区时，各自为战也不会全站瘫痪。代价就是你得接受“最终一致”，而且这个“最终”是几十秒起步。

### 服务端自己还套了两层缓存

注册信息写进 Eureka 之后，不是马上就能被其他客户端读到。服务端内部有两层：

1. `registry`：真正的注册表，`ConcurrentHashMap`，写入立刻可见
2. `readWriteCacheMap`：给读请求用的缓存，带过期时间
3. `readOnlyCacheMap`：只读缓存，默认每 30 秒从 `readWriteCacheMap` 同步一次

客户端拉取注册表时，默认读的是 `readOnlyCacheMap`。所以一台实例注册成功，别的服务最长要等 30 秒才“看得见”它。反过来，实例被移除，也要等这层缓存刷新，别人才“看不见”它。

这也解释了一个常见困惑：新扩容的机器明明注册成功了，为什么流量要等半分钟才过来。不是注册失败，是别人还没刷新名单。

### 调用方本地还有一份完整注册表

`EurekaClient` 在本地维护一份 `Applications` 对象，默认每 30 秒拉一次增量（`eureka.client.registry-fetch-interval-seconds`）。负载均衡器选实例时，读的是这份本地数据，不是实时请求注册中心。

这份本地缓存是 Eureka 的立身之本。注册中心整体挂掉，只要本地名单还在，服务间调用不受影响——代价就是名单会越来越旧。

### LoadBalancer 在最后一公里又缓存了一次

Spring Cloud LoadBalancer 用的是 `ServiceInstanceListSupplier` 责任链。默认链里有一环叫 `CachingServiceInstanceListSupplier`，按 `serviceId` 缓存实例列表，TTL 默认 35 秒。

为什么还要加这一层？因为一次业务请求可能触发多次下游调用，每次都问 `DiscoveryClient` 会放大注册中心压力，也没必要。缓存 35 秒，绝大多数场景无感。

问题是它和上面两层叠加。客户端注册表 30 秒前就更新了，LB 缓存里可能还是旧列表。你以为改完配置立刻生效，实际还要再等半分钟。

### 把时间线拼起来

正常停机（SIGTERM，反注册成功）：

```text
T+0     进程收到 SIGTERM，向 Eureka 发 DELETE 反注册
T+0~30  服务端 readOnlyCacheMap 还没刷新，别的客户端拿到的名单里仍有它
T+30    调用方拉到增量，本地注册表删掉它
T+30~65 调用方 LB 缓存 35 秒到期，才真正停止选它
```

异常宕机（`kill -9`，没有反注册）：

```text
T+0     进程消失，心跳停止
T+90    租约到期，服务端标记可剔除
T+90~150 清理线程下一轮扫描才真正删掉
T+150~180 服务端只读缓存刷新
T+180~210 调用方拉取增量
T+210~245 LB 缓存过期
```

二十多秒的心跳间隔、三十秒的缓存同步、三十五秒的 LB TTL，单看都不大，叠起来就是发布期间那两分钟的错误尖刺。

### 优雅停机为什么也会漏

Spring Boot 的 `server.shutdown=graceful` 只做一件事：停止接收新请求，把手上的请求跑完再关连接。它管的是本机，管不了别人缓存里的自己。

`EurekaAutoServiceRegistration` 会在上下文关闭时调用 `unregister()`。这个动作没错，但它发出的只是“我要走了”的通知。调用方要过完上面那条时间线，才会真的不再发请求。

所以只开 graceful shutdown 不够。你得在“反注册”和“停进程”之间，人为留出一段等待窗口，长度要覆盖调用方的缓存时间。

## 三、实战：手把手写代码

**这一节搭三个可运行的工程，把“下线后仍有流量”完整复现出来，再用脚本消掉它。** 注册中心一个，服务提供者两个实例，调用方一个。

### 3.1 工程结构

```text
eureka-demo/
├── eureka-server/          注册中心，端口 8761
├── order-provider/         服务提供者，用 PORT 环境变量起两个实例
└── order-consumer/         调用方，端口 8080
```

三个工程都是独立 Maven 项目，各自 `mvn package` 就能跑，不需要聚合父工程。

### 3.2 注册中心

`eureka-server/pom.xml`。父工程锁 Boot 版本，`dependencyManagement` 导入 Spring Cloud 的 BOM，每个依赖仍然把版本写全，方便你单独核对：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
    <modelVersion>4.0.0</modelVersion>

    <parent>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-parent</artifactId>
        <version>4.0.9</version>
        <relativePath/>
    </parent>

    <groupId>com.example</groupId>
    <artifactId>eureka-server</artifactId>
    <version>1.0.0</version>
    <name>eureka-server</name>

    <properties>
        <java.version>21</java.version>
    </properties>

    <dependencyManagement>
        <dependencies>
            <dependency>
                <groupId>org.springframework.cloud</groupId>
                <artifactId>spring-cloud-dependencies</artifactId>
                <version>2025.1.4</version>
                <type>pom</type>
                <scope>import</scope>
            </dependency>
        </dependencies>
    </dependencyManagement>

    <dependencies>
        <dependency>
            <groupId>org.springframework.cloud</groupId>
            <artifactId>spring-cloud-starter-netflix-eureka-server</artifactId>
            <version>5.0.3</version>
        </dependency>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-webmvc</artifactId>
            <version>4.0.9</version>
        </dependency>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-actuator</artifactId>
            <version>4.0.9</version>
        </dependency>
    </dependencies>

    <build>
        <plugins>
            <plugin>
                <groupId>org.springframework.boot</groupId>
                <artifactId>spring-boot-maven-plugin</artifactId>
                <version>4.0.9</version>
            </plugin>
        </plugins>
    </build>
</project>
```

启动类只需要一个 `@EnableEurekaServer`：

```java
package com.example.eurekaserver;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.cloud.netflix.eureka.server.EnableEurekaServer;

@EnableEurekaServer
@SpringBootApplication
public class EurekaServerApplication {

    public static void main(String[] args) {
        SpringApplication.run(EurekaServerApplication.class, args);
    }
}
```

`eureka-server/src/main/resources/application.yml`。这里的几个值压小了，是为了让你在两分钟内看到现象，生产环境别这么配：

```yaml
server:
  port: 8761

spring:
  application:
    name: eureka-server

eureka:
  client:
    register-with-eureka: false
    fetch-registry: false
  server:
    enable-self-preservation: false
    eviction-interval-timer-in-ms: 5000
    response-cache-update-interval-ms: 5000

management:
  endpoints:
    web:
      exposure:
        include: health,info
```

`register-with-eureka: false` 和 `fetch-registry: false` 是单机注册中心的标准配法，自己不用注册自己。`enable-self-preservation: false` 关掉自我保护，否则演示时死实例会一直挂在名单里，现象变成“永远不恢复”，反而看不出缓存的作用。

### 3.3 服务提供者

`order-provider/pom.xml`，和注册中心只差一个 starter：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
    <modelVersion>4.0.0</modelVersion>

    <parent>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-parent</artifactId>
        <version>4.0.9</version>
        <relativePath/>
    </parent>

    <groupId>com.example</groupId>
    <artifactId>order-provider</artifactId>
    <version>1.0.0</version>
    <name>order-provider</name>

    <properties>
        <java.version>21</java.version>
    </properties>

    <dependencyManagement>
        <dependencies>
            <dependency>
                <groupId>org.springframework.cloud</groupId>
                <artifactId>spring-cloud-dependencies</artifactId>
                <version>2025.1.4</version>
                <type>pom</type>
                <scope>import</scope>
            </dependency>
        </dependencies>
    </dependencyManagement>

    <dependencies>
        <dependency>
            <groupId>org.springframework.cloud</groupId>
            <artifactId>spring-cloud-starter-netflix-eureka-client</artifactId>
            <version>5.0.3</version>
        </dependency>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-webmvc</artifactId>
            <version>4.0.9</version>
        </dependency>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-actuator</artifactId>
            <version>4.0.9</version>
        </dependency>
    </dependencies>

    <build>
        <plugins>
            <plugin>
                <groupId>org.springframework.boot</groupId>
                <artifactId>spring-boot-maven-plugin</artifactId>
                <version>4.0.9</version>
            </plugin>
        </plugins>
    </build>
</project>
```

启动类：

```java
package com.example.orderprovider;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class OrderProviderApplication {

    public static void main(String[] args) {
        SpringApplication.run(OrderProviderApplication.class, args);
    }
}
```

接口里把端口返回出去，方便看请求落到了哪台：

```java
package com.example.orderprovider;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.LinkedHashMap;
import java.util.Map;

@RestController
@RequestMapping("/api/orders")
public class OrderController {

    @Value("${server.port}")
    private int port;

    @GetMapping("/ping")
    public Map<String, Object> ping() {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("service", "order-provider");
        body.put("port", port);
        body.put("time", System.currentTimeMillis());
        return body;
    }
}
```

`order-provider/src/main/resources/application.yml`。这里把租约调成 10 秒续约、30 秒过期，也是为了演示快：

```yaml
server:
  port: ${PORT:8081}
  shutdown: graceful

spring:
  application:
    name: order-provider
  lifecycle:
    timeout-per-shutdown-phase: 20s

eureka:
  client:
    service-url:
      defaultZone: http://localhost:8761/eureka/
  instance:
    instance-id: order-provider:${server.port}
    prefer-ip-address: true
    lease-renewal-interval-in-seconds: 10
    lease-expiration-duration-in-seconds: 30

management:
  endpoints:
    web:
      exposure:
        include: health,info,service-registry
  endpoint:
    health:
      show-details: always
```

`instance-id` 必须带端口，不然两个实例在同一条注册记录上互相覆盖，你只会看到一个。`prefer-ip-address: true` 让注册的是 IP，不是主机名——容器环境里主机名往往解析不了。`service-registry` 端点要显式暴露，下线脚本要用它。

### 3.4 调用方

`order-consumer/pom.xml`：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
    <modelVersion>4.0.0</modelVersion>

    <parent>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-parent</artifactId>
        <version>4.0.9</version>
        <relativePath/>
    </parent>

    <groupId>com.example</groupId>
    <artifactId>order-consumer</artifactId>
    <version>1.0.0</version>
    <name>order-consumer</name>

    <properties>
        <java.version>21</java.version>
    </properties>

    <dependencyManagement>
        <dependencies>
            <dependency>
                <groupId>org.springframework.cloud</groupId>
                <artifactId>spring-cloud-dependencies</artifactId>
                <version>2025.1.4</version>
                <type>pom</type>
                <scope>import</scope>
            </dependency>
        </dependencies>
    </dependencyManagement>

    <dependencies>
        <dependency>
            <groupId>org.springframework.cloud</groupId>
            <artifactId>spring-cloud-starter-netflix-eureka-client</artifactId>
            <version>5.0.3</version>
        </dependency>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-webmvc</artifactId>
            <version>4.0.9</version>
        </dependency>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-actuator</artifactId>
            <version>4.0.9</version>
        </dependency>
    </dependencies>

    <build>
        <plugins>
            <plugin>
                <groupId>org.springframework.boot</groupId>
                <artifactId>spring-boot-maven-plugin</artifactId>
                <version>4.0.9</version>
            </plugin>
        </plugins>
    </build>
</project>
```

启动类：

```java
package com.example.orderconsumer;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class OrderConsumerApplication {

    public static void main(String[] args) {
        SpringApplication.run(OrderConsumerApplication.class, args);
    }
}
```

关键在 `RestClient` 的那个 Bean。加了 `@LoadBalanced`，它就会把 `http://order-provider` 里的服务名换成真实实例地址：

```java
package com.example.orderconsumer;

import org.springframework.cloud.client.loadbalancer.LoadBalanced;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.client.RestClient;

@Configuration
public class RestClientConfig {

    @Bean
    @LoadBalanced
    public RestClient.Builder loadBalancedRestClientBuilder() {
        return RestClient.builder();
    }
}
```

响应体用一个 record 接：

```java
package com.example.orderconsumer;

public record PingResult(String service, int port, long time) {
}
```

控制器把成功和失败都包成 JSON，失败时不抛 500，方便你循环压着看：

```java
package com.example.orderconsumer;

import org.springframework.cloud.client.loadbalancer.LoadBalanced;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.client.RestClient;

import java.util.LinkedHashMap;
import java.util.Map;

@RestController
@RequestMapping("/api/query")
public class OrderQueryController {

    private final RestClient restClient;

    public OrderQueryController(@LoadBalanced RestClient.Builder loadBalancedRestClientBuilder) {
        this.restClient = loadBalancedRestClientBuilder.build();
    }

    @GetMapping("/ping")
    public Map<String, Object> ping() {
        Map<String, Object> result = new LinkedHashMap<>();
        try {
            PingResult body = restClient.get()
                    .uri("http://order-provider/api/orders/ping")
                    .retrieve()
                    .body(PingResult.class);
            result.put("ok", true);
            result.put("hit", body);
        } catch (Exception e) {
            result.put("ok", false);
            result.put("error", e.getClass().getSimpleName());
            result.put("message", e.getMessage());
        }
        return result;
    }
}
```

`order-consumer/src/main/resources/application.yml`。缓存和时间间隔都调小了，现象才看得快：

```yaml
server:
  port: 8080

spring:
  application:
    name: order-consumer
  cloud:
    loadbalancer:
      cache:
        ttl: 10s

eureka:
  client:
    service-url:
      defaultZone: http://localhost:8761/eureka/
    registry-fetch-interval-seconds: 10
  instance:
    prefer-ip-address: true

management:
  endpoints:
    web:
      exposure:
        include: health,info
```

### 3.5 把问题复现出来

四个终端，先在各自目录里打包：

```bash
cd eureka-server && mvn -q clean package
cd order-provider && mvn -q clean package
cd order-consumer && mvn -q clean package
```

依次启动。提供者用 `PORT` 起两份：

```bash
java -jar eureka-server/target/eureka-server-1.0.0.jar
PORT=8081 java -jar order-provider/target/order-provider-1.0.0.jar
PORT=8082 java -jar order-provider/target/order-provider-1.0.0.jar
java -jar order-consumer/target/order-consumer-1.0.0.jar
```

打开 <http://localhost:8761> 能看到 `ORDER-PROVIDER` 下有两条实例。然后循环打调用方：

```bash
for i in $(seq 1 10); do
  curl -s http://localhost:8080/api/query/ping
  echo
  sleep 1
done
```

正常情况下 8081 和 8082 会交替出现，说明轮询生效。

现在直接给 8082 发 `kill -9`，然后立刻再跑上面那段循环。你会看到一批这样的返回：

```json
{"ok":false,"error":"ResourceAccessException","message":"I/O error on GET request for \"http://order-provider/api/orders/ping\""}
```

这就是“死实例还在被调用”。继续跑，过一阵子才会恢复成全部 8081。恢复时间取决于你在 yml 里把那几个间隔调到了多少；用默认值就是文章开头那两分钟。

### 3.6 正确的下线流程

先把实例在注册中心标成 `DOWN`，等调用方缓存过期，再停进程：

```bash
#!/usr/bin/env bash
# offline.sh  用法: ./offline.sh <端口> <进程号>
set -euo pipefail

PORT=${1:?用法: ./offline.sh <端口> <进程号>}
PID=${2:?用法: ./offline.sh <端口> <进程号>}

curl -fsS -X POST "http://localhost:${PORT}/actuator/service-registry" \
  -H 'Content-Type: application/json' \
  -d '{"status":"DOWN"}'

echo "实例 ${PORT} 已标记 DOWN，等待调用方缓存过期"
sleep 60

kill -TERM "${PID}"
echo "已发送 SIGTERM，等待优雅停机完成"
```

这个脚本干了三件事，顺序不能换：

1. 通过 `/actuator/service-registry` 把实例状态改成 `DOWN`，调用方拉到的名单里就不会再有它
2. 睡 60 秒，覆盖客户端拉取间隔加 LB 缓存的时间
3. 发 `SIGTERM`，让 Spring 走优雅停机，把手上的请求处理完

第 2 步的等待时间按你的实际配置算：`registry-fetch-interval-seconds` + `spring.cloud.loadbalancer.cache.ttl`，再留 10 秒余量。用默认值就是 30 + 35 + 余量，70 秒左右比较稳妥。

放在 Kubernetes 里，这段等待等价于 `preStop` 钩子：

```yaml
lifecycle:
  preStop:
    exec:
      command: ["sh", "-c", "curl -fsS -X POST http://localhost:8080/actuator/service-registry -H 'Content-Type: application/json' -d '{\"status\":\"DOWN\"}'; sleep 70"]
```

`preStop` 执行完，kubelet 才发 TERM。顺序对了，滚动发布期间就不会有错误尖刺。

## 四、踩坑经验和最佳实践

**这套机制里，最容易出事的不是配置值，是停机方式。** 下面几条都是真实踩过的。

### 坑一：`kill -9` 把反注册也杀了

`SIGKILL` 不给进程任何清理机会，Eureka 收不到 `DELETE`，只能等租约过期。90 秒租约加 60 秒清理扫描，再加两层缓存，最坏四分钟。

容器里更隐蔽：`docker stop` 默认先发 `SIGTERM` 等 10 秒，超时才 `SIGKILL`。你的 `spring.lifecycle.timeout-per-shutdown-phase` 要是配了 20 秒，10 秒就被砍了，优雅停机等于没开。把容器的 `stopGracePeriod` 调到比 Spring 的超时更长，比如 40 秒。

### 坑二：健康检查与手动 DOWN 打架

`eureka.client.healthcheck.enabled=true` 打开后，实例状态由 `/actuator/health` 决定。这时候你用端点手动设 `DOWN`，下一次心跳可能又被健康检查改回 `UP`。

两种方案选一个，别混用：

- 依赖健康检查：数据库、Redis 挂了自动摘流量，适合有外部依赖的服务
- 依赖手动下线：发布流程可控，适合纯计算型服务

### 坑三：自我保护模式让死实例赖着不走

`enable-self-preservation` 默认开着。它判断“最近一分钟续约成功率低于 85%”就停止剔除实例，防止网络抖动误杀。测试环境经常一半机器关着，续约率天然低于阈值，死实例就永远留在名单里。

测试环境关掉它，生产环境留着——生产环境真正该做的是保证心跳网络稳定，而不是关保护。

### 坑四：`instance-id` 不带端口，多实例互相覆盖

默认 `instance-id` 由主机名、应用名和端口拼出来，多实例之间天然不同，通常没问题。但你自己写死成 `order-provider` 又不带端口，两台机器注册的是同一条记录，后注册的覆盖先注册的，负载均衡永远只看到一台。

### 坑五：把 LB 缓存 TTL 调到 1 秒

有人为了“下线立刻生效”，把 `spring.cloud.loadbalancer.cache.ttl` 设成 1 秒。结果每次请求都重新拉实例列表，QPS 一上来，注册中心的读请求被打爆，反过来拖慢整个调用链。

这个值有下限，5 到 10 秒比较合理。想更快感知，应该换推送型注册中心，而不是把缓存拆了。

### 坑六：只配了超时，没配重试

缓存没来得及过期时，请求打到死实例就是一次硬失败。调用方加一层重试，能把这类失败吃掉大半。重试要配在“连接失败”这种幂等安全的情况上，业务异常别重试。

## 五、性能对比和技术选型

**要压低下线延迟，换注册中心比调缓存参数有效得多。** 四种常见方案的差别主要在“服务端能不能主动通知”。

| 方案 | 感知模型 | 下线感知延迟 | 一致性 | 运维成本 |
| --- | --- | --- | --- | --- |
| Eureka | 客户端定时拉取 | 秒级到分钟级，取决于缓存 | AP，节点异步复制 | 低，一个 Java 进程 |
| Nacos | gRPC 长连接，服务端推送变更 | 通常秒级 | AP/CP 可切换 | 中，要维护集群和数据库 |
| Consul | 服务端健康检查 + 阻塞查询 | 秒级 | CP（Raft） | 中，Go 二进制，运维友好 |
| Zookeeper | Watch 推送 | 毫秒级到秒级 | CP（Zab） | 高，会话和节点要调 |

怎么选，看你的痛点在哪：

- 已经在用 Spring Cloud Netflix 全家桶，机器规模不大，接受发布时几十秒的抖动 → 留在 Eureka，把优雅下线流程做扎实，成本最低
- 对下线延迟敏感，服务实例频繁弹性伸缩 → 换 Nacos 或 Consul，推送模型能从根上解决问题
- 需要强一致的选主、配置管理 → Zookeeper，但别拿它当纯注册中心用，运维负担不划算

我的建议：**别为了几十秒的延迟重做注册中心，先把下线脚本和 `preStop` 补上。** 大部分团队的问题不是 Eureka 慢，是压根没有下线流程，全靠 `kill`。

## 六、总结

**“服务下线了还在被调用”不是 bug，是拉模型加多层缓存的必然结果。** 记住那条传播链：租约、服务端只读缓存、客户端注册表、负载均衡实例缓存，四段串起来，正常停机最坏约 95 秒，异常宕机接近 4 分钟。

落地就三件事：

1. 停机一律走 `SIGTERM`，容器 `stopGracePeriod` 要大于 Spring 的优雅停机超时
2. 下线前先把实例标 `DOWN`，等够“拉取间隔 + LB 缓存 TTL”，再停进程
3. 调用方配一层针对连接失败的重试，兜住缓存没过期的那几秒

缓存不是敌人。它让注册中心挂掉时服务还能跑，代价就是你得尊重它的时间。发布流程里留出的那 70 秒，买的是整条链路不抖。

## 参考资料

- [Spring Cloud Netflix Reference](https://docs.spring.io/spring-cloud-netflix/reference/)
- [Spring Cloud Commons — Spring Cloud LoadBalancer](https://docs.spring.io/spring-cloud-commons/reference/spring-cloud-commons/loadbalancer.html)
- [Spring Boot — Graceful Shutdown](https://docs.spring.io/spring-boot/reference/web/graceful-shutdown.html)

文 / 会编程的吕洞宾
