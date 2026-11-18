---
title: "Spring Cloud灰度发布：按请求头切流量"
date: 2026-10-06T09:00:00+08:00
category: "Spring"
tags: ["spring-cloud"]
---

> 新版本服务上线，你想先放一小撮用户进去试水。网关按请求头把灰度用户导到了新实例，结果这些人下单后，订单服务再去调用户服务，又随机打回了老实例——新老数据一混，页面直接错乱。问题出在很多人只做了"入口灰度"，没管服务之间的第二次、第三次调用。Spring Cloud LoadBalancer 自带一套按请求头选实例的机制，不用自己写路由代码，就能把灰度打通到服务内部。这篇从原理讲到一套能直接跑起来的完整项目。

## 一、灰度发布卡在哪：入口灰度为什么带不动服务内部调用

**灰度发布真正难的不是"把新版本部署上去"，而是"让指定的一批用户从头到尾都走新版本"。**

把这句话拆开，一次灰度要过三道关：

1. **实例关**：老实例和新实例同时在线，注册中心里两个都在。
2. **入口关**：网关或 Nginx 决定第一批请求去哪，比如按权重放 5% 到新实例，或者按请求头把指定用户导过去。
3. **调用关**：服务 A 调服务 B 的时候，到底打哪个实例。

前两关大部分人都会做，翻车基本都在第三关。

原因很直白：微服务里一次用户请求会扇出很多次内部调用。网关只决定了"第一次调用"的落点，后面的调用由各个服务自己选实例。你辛辛苦苦在入口按请求头把用户导进了新版本，下一跳又随机了，等于白干。

说个我自己的经历。有次订单服务做灰度，新版本业务逻辑里多拿了一个用户服务的新字段。网关那边按 `X-Gray: v2` 把 5% 的流量导到了订单服务的新实例，一切看起来很正常。上线十分钟后开始报错：同一个订单号，一会儿成功一会儿失败，日志里全是空指针。

排查了很久，最后发现问题压根不在订单代码上——订单服务新实例调用户服务时没带任何灰度标记，LoadBalancer 按默认的轮询策略在两个用户服务实例之间来回跳，一半请求打到了还没有那个字段的老实例上。

不是代码有 bug，是**实例选择没有跟着灰度走**。

在 Spring Cloud 里，用服务名调用（Feign、`WebClient`、`RestClient` 都一样）时，真正决定"打哪个 IP 和端口"的是 LoadBalancer：它先拿到这个服务的候选实例列表，再按策略挑一个。所以灰度要落地，就得把"挑谁"这一步管起来。

只剩一个要求：灰度标记必须是**用户维度稳定**的。同一个用户这次请求走新版、下次走老版，体验比不灰度还糟。用用户 ID 哈希或者登录态里的标记，别用随机数。

## 二、原理：Spring Cloud LoadBalancer 怎么按标记挑实例

**LoadBalancer 内部就是一条装饰器责任链：每个环节都拿到上一环的实例列表，做点加工再往下传。**

一次服务名调用，实际发生三件事：

1. 拿到候选实例列表，来源是 `ServiceInstanceListSupplier`；
2. 按策略从列表里挑一个，默认实现是轮询（`RoundRobinLoadBalancer`）；
3. 发请求。

灰度路由改的是第 1 步。改第 2 步会很别扭：轮询策略拿不到"这个请求属于哪个用户"这种上下文。

### 2.1 框架自带的标记过滤：HintBasedServiceInstanceListSupplier

Spring Cloud LoadBalancer 里有个现成的类，专门干按标记过滤实例这件事。它的逻辑只有三步：

1. 从请求上下文里取一个 "hint"（提示值）：先看请求头，请求头没有再看到底层的 hint 上下文；
2. 拿这个 hint 去匹配实例 metadata 里的 `hint` 键；
3. 匹配上的实例才返回。

关键信息就这几条，我整理成表：

| 项 | 默认值 | 说明 |
| --- | --- | --- |
| 请求头名 | `X-SC-LB-Hint` | 可通过 `spring.cloud.loadbalancer.hint-header-name` 改 |
| 实例 metadata 的键 | `hint` | 注册中心给实例打的标签，键名固定 |
| 请求头带 hint 时 | 只返回 metadata 匹配的实例 | 灰度生效 |
| 请求头没带 hint 时 | 返回全部实例 | 正常流量，不受影响 |
| hint 一个实例都匹配不上 | **返回全部实例** | 最阴的坑，第四节展开 |

最后一行要盯住：灰度值写错、或者老实例上忘了打标签，过滤等于没做，流量会全量放出去。

### 2.2 hint 是怎么传进 LoadBalancer 的

**Feign 在选实例之前，会把这次请求的数据（包括请求头）打包成 `RequestDataContext` 交给 LoadBalancer。**

也就是说，上游传进来的灰度请求头，只要出现在出站请求上，LoadBalancer 就能读到。这里有个反直觉的点：**Feign 默认不转发请求头**。你在 Controller 里拿到的 `X-SC-LB-Hint`，不会自动出现在 Feign 发出的请求里，必须自己加一个 `RequestInterceptor` 把候选头复制过去。不写这一步，灰度标记断在调用方，表现就是"网关明明传了，实例还是随机跳"。

### 2.3 装配顺序：hint 必须放在最外层

**实例列表供应商是一条链，每个供应商包住上一个；只有按请求做过滤的那一环在最外层，灰度才会对每一次请求生效。**

原因在缓存那一环。`CachingServiceInstanceListSupplier` 只重写了"拿全量实例列表"这个方法，它缓存的是列表本身，不关心这次请求是谁发的。如果你把 hint 过滤放在缓存里面，缓存直接把过滤结果吃掉：第一次请求看着生效，后面全乱。

按构造顺序说就是：先 `withDiscoveryClient()`，再 `withCaching()`，最后才加过滤（`withHints()` 或自定义过滤器）。顺序反了，问题很隐蔽，因为不是每次都对、也不是每次都错。

## 三、实战：Spring Cloud 灰度发布完整可运行项目

项目分成两个服务，目录结构如下：

```text
gray-demo/
├── user-service/                 提供方，部署两个实例（v1 / v2）
│   ├── pom.xml
│   └── src/main/
│       ├── java/com/example/userservice/UserServiceApplication.java
│       └── resources/application.yml
└── order-service/                调用方，灰度路由在这一层生效
    ├── pom.xml
    └── src/main/
        ├── java/com/example/
        │   ├── lb/GrayLoadBalancerConfiguration.java
        │   └── orderservice/
        │       ├── OrderServiceApplication.java
        │       ├── client/UserClient.java
        │       ├── config/HintHeaderForwardInterceptor.java
        │       └── controller/OrderController.java
        └── resources/application.yml
```

为了不依赖 Nacos 或 Eureka 就能跑，实例列表用 Spring Cloud 自带的 `SimpleDiscoveryClient`，直接在 `application.yml` 里写两个实例地址和它们的 metadata。真实环境换成 Nacos/Eureka，给实例打标签的方式完全一样，只是标签由注册中心下发。

### 3.1 提供方 user-service

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
        <version>4.0.8</version>
        <relativePath/>
    </parent>

    <groupId>com.example</groupId>
    <artifactId>user-service</artifactId>
    <version>1.0.0</version>

    <properties>
        <java.version>21</java.version>
        <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
    </properties>

    <dependencies>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-web</artifactId>
            <version>4.0.8</version>
        </dependency>
    </dependencies>

    <build>
        <plugins>
            <plugin>
                <groupId>org.springframework.boot</groupId>
                <artifactId>spring-boot-maven-plugin</artifactId>
                <version>4.0.8</version>
            </plugin>
        </plugins>
    </build>
</project>
```

**src/main/java/com/example/userservice/UserServiceApplication.java**

```java
package com.example.userservice;

import java.util.LinkedHashMap;
import java.util.Map;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RestController;

@SpringBootApplication
@RestController
public class UserServiceApplication {

    public static void main(String[] args) {
        SpringApplication.run(UserServiceApplication.class, args);
    }

    @Value("${server.port}")
    private String port;

    @Value("${app.version:v1}")
    private String version;

    @GetMapping("/users/{id}")
    public Map<String, Object> getUser(@PathVariable("id") Long id) {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("id", id);
        result.put("name", "用户" + id);
        result.put("version", version);
        // 把处理请求的实例信息带回去，方便肉眼确认请求打到了哪个实例
        result.put("instance", port + "#" + version);
        return result;
    }
}
```

**src/main/resources/application.yml**

```yaml
server:
  port: 8081
app:
  version: v2
```

第二个实例不需要改代码，启动时用命令行参数覆盖端口和版本即可。

### 3.2 调用方 order-service

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
        <version>4.0.8</version>
        <relativePath/>
    </parent>

    <groupId>com.example</groupId>
    <artifactId>order-service</artifactId>
    <version>1.0.0</version>

    <properties>
        <java.version>21</java.version>
        <spring-cloud.version>2025.1.3</spring-cloud.version>
        <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
    </properties>

    <dependencies>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-web</artifactId>
            <version>4.0.8</version>
        </dependency>
        <dependency>
            <groupId>org.springframework.cloud</groupId>
            <artifactId>spring-cloud-starter-openfeign</artifactId>
            <version>5.0.3</version>
        </dependency>
        <dependency>
            <groupId>org.springframework.cloud</groupId>
            <artifactId>spring-cloud-starter-loadbalancer</artifactId>
            <version>5.0.3</version>
        </dependency>
    </dependencies>

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

    <build>
        <plugins>
            <plugin>
                <groupId>org.springframework.boot</groupId>
                <artifactId>spring-boot-maven-plugin</artifactId>
                <version>4.0.8</version>
            </plugin>
        </plugins>
    </build>
</project>
```

**src/main/java/com/example/orderservice/OrderServiceApplication.java**

```java
package com.example.orderservice;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.cloud.loadbalancer.annotation.LoadBalancerClients;
import org.springframework.cloud.openfeign.EnableFeignClients;

import com.example.lb.GrayLoadBalancerConfiguration;

@SpringBootApplication
@EnableFeignClients
@LoadBalancerClients(defaultConfiguration = GrayLoadBalancerConfiguration.class)
public class OrderServiceApplication {

    public static void main(String[] args) {
        SpringApplication.run(OrderServiceApplication.class, args);
    }
}
```

**src/main/java/com/example/lb/GrayLoadBalancerConfiguration.java**

这个类故意放在 `com.example.lb` 包里，不在 `@SpringBootApplication` 的扫描路径下。原因：被扫描到的话，它会变成全局配置，而不是只作用于被 `@LoadBalancerClients` 指定的那些客户端。

```java
package com.example.lb;

import org.springframework.cloud.loadbalancer.core.ServiceInstanceListSupplier;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration(proxyBeanMethods = false)
public class GrayLoadBalancerConfiguration {

    @Bean
    public ServiceInstanceListSupplier grayServiceInstanceListSupplier(ConfigurableApplicationContext context) {
        // 顺序不能改：先拿到实例列表，再加缓存，最后才挂按请求过滤的环节
        return ServiceInstanceListSupplier.builder()
                .withDiscoveryClient()
                .withCaching()
                .withHints()
                .build(context);
    }
}
```

**src/main/java/com/example/orderservice/client/UserClient.java**

```java
package com.example.orderservice.client;

import java.util.Map;

import org.springframework.cloud.openfeign.FeignClient;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;

@FeignClient(name = "user-service")
public interface UserClient {

    @GetMapping("/users/{id}")
    Map<String, Object> getUser(@PathVariable("id") Long id);
}
```

**src/main/java/com/example/orderservice/config/HintHeaderForwardInterceptor.java**

Feign 默认不转发上游的请求头，灰度标记得自己搬过去。

```java
package com.example.orderservice.config;

import org.springframework.stereotype.Component;
import org.springframework.util.StringUtils;
import org.springframework.web.context.request.RequestContextHolder;
import org.springframework.web.context.request.ServletRequestAttributes;

import feign.RequestInterceptor;
import feign.RequestTemplate;
import jakarta.servlet.http.HttpServletRequest;

@Component
public class HintHeaderForwardInterceptor implements RequestInterceptor {

    private static final String HINT_HEADER = "X-SC-LB-Hint";

    @Override
    public void apply(RequestTemplate template) {
        ServletRequestAttributes attributes =
                (ServletRequestAttributes) RequestContextHolder.getRequestAttributes();
        if (attributes == null) {
            return;
        }
        HttpServletRequest request = attributes.getRequest();
        String hint = request.getHeader(HINT_HEADER);
        if (StringUtils.hasText(hint)) {
            template.header(HINT_HEADER, hint);
        }
    }
}
```

**src/main/java/com/example/orderservice/controller/OrderController.java**

```java
package com.example.orderservice.controller;

import java.util.LinkedHashMap;
import java.util.Map;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RestController;

import com.example.orderservice.client.UserClient;

@RestController
public class OrderController {

    private final UserClient userClient;

    public OrderController(UserClient userClient) {
        this.userClient = userClient;
    }

    @GetMapping("/orders/{id}")
    public Map<String, Object> getOrder(@PathVariable("id") Long id) {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("orderId", id);
        result.put("amount", 99);
        result.put("user", userClient.getUser(id));
        return result;
    }
}
```

**src/main/resources/application.yml**

```yaml
server:
  port: 8080

spring:
  application:
    name: order-service
  cloud:
    discovery:
      client:
        simple:
          instances:
            user-service:
              - uri: http://localhost:8081
                metadata:
                  hint: v2
              - uri: http://localhost:8082
                metadata:
                  hint: v1
    loadbalancer:
      hint-header-name: X-SC-LB-Hint

logging:
  level:
    org.springframework.cloud.loadbalancer: DEBUG
```

### 3.3 跑起来验证

先把两个提供方实例起起来（同一个 jar，换个端口和版本号）：

```bash
mvn -f user-service/pom.xml clean package
java -jar user-service/target/user-service-1.0.0.jar --server.port=8081 --app.version=v2
java -jar user-service/target/user-service-1.0.0.jar --server.port=8082 --app.version=v1
```

再起调用方：

```bash
mvn -f order-service/pom.xml spring-boot:run
```

**不带灰度头**，请求应该在两个实例之间轮询：

```bash
curl -s http://localhost:8080/orders/1
```

多执行几次，返回里的 `instance` 会在 `8081#v2` 和 `8082#v1` 之间来回变。

**带上灰度头**，请求应该只落到 v2 实例：

```bash
curl -s -H "X-SC-LB-Hint: v2" http://localhost:8080/orders/1
```

执行多少次，`instance` 都是 `8081#v2`。换成 `-H "X-SC-LB-Hint: v1"`，结果稳定是 `8082#v1`。

**故意传一个不存在的值**，就能看到那个坑：

```bash
curl -s -H "X-SC-LB-Hint: v9" http://localhost:8080/orders/1
```

结果又是两个实例轮询跳。因为没有任何实例的 metadata 能匹配上 `v9`，框架直接放全量。

## 四、踩坑经验：灰度发布最常见的五个坑

### 4.1 坑一：hint 匹配不上，流量直接全放

上面第三节最后的 `v9` 就是现场演示。这不是 bug，是框架的既定行为：过滤后一个实例都不剩，它宁可返回全量，也不让你拿不到一个可用实例。

真实项目里这个坑最致命的形态是：某个老实例上忘了配 metadata。灰度值传对了，但那个实例不在候选里，过滤结果和预期对不上。

两条应对：

- 灰度头必须有默认值。网关给非灰度用户也带上 `X-SC-LB-Hint: v1`，别让请求裸奔。
- 想要"匹配不上就报错"的严格模式，把 `withHints()` 换成自己的过滤器。下面这个类直接替换掉构建链里的 `withHints()`：

```java
package com.example.lb;

import java.util.List;

import org.springframework.cloud.client.ServiceInstance;
import org.springframework.cloud.client.loadbalancer.Request;
import org.springframework.cloud.client.loadbalancer.RequestDataContext;
import org.springframework.cloud.loadbalancer.core.DelegatingServiceInstanceListSupplier;
import org.springframework.cloud.loadbalancer.core.ServiceInstanceListSupplier;
import org.springframework.http.HttpHeaders;
import org.springframework.util.StringUtils;

import reactor.core.publisher.Flux;

public class StrictHintServiceInstanceListSupplier extends DelegatingServiceInstanceListSupplier {

    private static final String HINT_METADATA_KEY = "hint";

    private final String headerName;

    public StrictHintServiceInstanceListSupplier(ServiceInstanceListSupplier delegate, String headerName) {
        super(delegate);
        this.headerName = headerName;
    }

    @Override
    public Flux<List<ServiceInstance>> get(Request request) {
        String hint = resolveHint(request);
        return delegate.get(request).map(instances -> filterByHint(instances, hint));
    }

    private String resolveHint(Request request) {
        Object context = request.getContext();
        if (context instanceof RequestDataContext requestDataContext && requestDataContext.getClientRequest() != null) {
            HttpHeaders headers = requestDataContext.getClientRequest().getHeaders();
            if (headers != null) {
                return headers.getFirst(headerName);
            }
        }
        return null;
    }

    private List<ServiceInstance> filterByHint(List<ServiceInstance> instances, String hint) {
        if (!StringUtils.hasText(hint)) {
            return instances;
        }
        List<ServiceInstance> matched = instances.stream()
                .filter(instance -> hint.equalsIgnoreCase(instance.getMetadata().get(HINT_METADATA_KEY)))
                .toList();
        if (matched.isEmpty()) {
            // 宁可失败也不放全量：灰度配错了要在启动阶段就暴露出来
            throw new IllegalStateException("没有实例匹配灰度标记 " + hint + "，检查实例 metadata 是否漏配");
        }
        return matched;
    }
}
```

装配方式就是把原来那一行的 `.withHints()` 换成自己的过滤器：

```java
@Bean
public ServiceInstanceListSupplier grayServiceInstanceListSupplier(ConfigurableApplicationContext context) {
    return ServiceInstanceListSupplier.builder()
            .withDiscoveryClient()
            .withCaching()
            .with((ctx, delegate) -> new StrictHintServiceInstanceListSupplier(delegate, "X-SC-LB-Hint"))
            .build(context);
}
```

### 4.2 坑二：Feign 不转发请求头，灰度断在中间

第一节讲的那次事故就是它。排查时有个很好用的判断方法：如果网关日志里有灰度头，但下游实例收到的请求头里没有，那问题一定在调用方的转发上，跟 LoadBalancer 无关。

注意 `RequestInterceptor` 只能在同一线程里拿到原始请求。业务代码如果把它丢进线程池、或者用了 `@Async`，`RequestContextHolder` 是空的，灰度头就丢了。这种场景要把灰度值当参数显式传下去，别指望上下文。

### 4.3 坑三：装配顺序写反，效果时好时坏

`withCaching()` 写在 `withHints()` 后面，过滤器就被缓存包在里面。表现是第一次请求正常，之后偶尔乱跳，本地测还测不出来。记住顺序：缓存在内，过滤在外。

### 4.4 坑四：灰度标记不稳定

用随机数或者时间戳当 hint，同一个用户每个请求都可能换版本，购物车、登录态这类有状态的东西立刻出问题。灰度标记要么来自用户 ID 取模，要么来自登录态里的白名单。

### 4.5 坑五：把 hint 当权重使

hint 是"过滤"，只分两类：匹配的和不匹配的。想要 5%、10% 这种按比例放量，得用带权重的负载均衡（`withWeighted()`）、按实例数分桶的 subset，或者在网关层做权重路由。用 hint 硬凑比例，最后一定是某几个用户被反复灰度，其他人永远进不去。

## 五、技术选型：请求头灰度、权重灰度、双集群怎么选

**三种常见灰度方式解决的不是同一个问题，按"要不要按用户定向"和"要不要覆盖服务内部调用"两个维度选。**

| 方案 | 灰度粒度 | 服务内部调用是否生效 | 改动量 | 适合场景 |
| --- | --- | --- | --- | --- |
| 网关权重路由 | 实例级按比例 | 不生效 | 小，只改网关 | 纯比例放量，不看用户 |
| 请求头 + LoadBalancer hint | 用户级定向 | 生效 | 中，调用方加拦截器 | 定向灰度、内部员工先行 |
| 独立服务名双集群 | 服务级隔离 | 生效（改调用方服务名） | 大 | 整链路强隔离、大版本并行 |

补几句实话：

- 只做入口权重、不管内部调用，是半成品。比例对，用户体验不一定对。
- hint 方案的成本主要在"把灰度头一路带下去"，涉及几个服务就要在几个调用方加拦截器。链路长的话，考虑在网关统一注入、下游统一用同一个拦截器实现。
- 双集群隔离最干净，也最贵：注册中心里的实例、配置、数据库连接都要分离，适合新老版本差异大到无法共存的情况。

性能上不用担心 hint 过滤：它只是对实例列表做一次内存过滤，实例数量通常是个位数，开销可以忽略。真正要关注的是别在链路上反复执行实例列表的远程拉取——缓存那一环就是干这个的。

## 六、总结

灰度的难点不在部署新版本，在于让"同一批用户"在整条调用链上稳定地走新版本。网关只管第一次调用，服务之间的调用得靠 LoadBalancer 的实例选择来接管。

Spring Cloud LoadBalancer 自带的 hint 机制，就是拿一个请求头（默认 `X-SC-LB-Hint`）去匹配实例 metadata 里的 `hint` 标签，匹配上的实例才进候选列表。要让它按每次请求生效，记住两件事：

- `withCaching()` 在前，过滤环节在后，别让缓存把过滤吃掉；
- Feign 默认不转发请求头，用 `RequestInterceptor` 把灰度头搬过去，或者用它自带的严格模式在配错时直接报错。

还有一句要刻在脑子里：**hint 匹配不上时，框架会返回全部实例**。灰度配错不会报错，只会静悄悄地全量放出去。上线前拿一个不存在的 hint 值打一次请求，看它是不是还在所有实例之间乱跳，是的话，配置就有漏。

文 / 会编程的吕洞宾

## 参考资料

- [Spring Cloud LoadBalancer](https://docs.spring.io/spring-cloud-commons/reference/spring-cloud-commons/loadbalancer.html)
- [Spring Cloud OpenFeign](https://docs.spring.io/spring-cloud-openfeign/reference/)
- [HintBasedServiceInstanceListSupplier 源码](https://github.com/spring-cloud/spring-cloud-commons/blob/main/spring-cloud-loadbalancer/src/main/java/org/springframework/cloud/loadbalancer/core/HintBasedServiceInstanceListSupplier.java)
- [CachingServiceInstanceListSupplier 源码](https://github.com/spring-cloud/spring-cloud-commons/blob/main/spring-cloud-loadbalancer/src/main/java/org/springframework/cloud/loadbalancer/core/CachingServiceInstanceListSupplier.java)
- [spring-cloud-dependencies（Maven Central）](https://repo1.maven.org/maven2/org/springframework/cloud/spring-cloud-dependencies/)
