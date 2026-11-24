---
title: "Feign太重，Java后端换声明式HTTP客户端"
date: 2026-11-09T09:00:00+08:00
category: "Spring"
tags: ["spring-cloud"]
---

> 两个内部服务互相调个接口，你得引一个 OpenFeign starter、配一遍超时、再对着版本对应表确认 Spring Cloud 和 Spring Boot 能不能搭。等哪天 Boot 升大版本，卡住你的往往不是业务代码，是这层客户端。Spring 框架从 6.0 起自带声明式 HTTP 客户端，Spring Boot 4 直接把它托管成 Bean：写个接口，加上 `@GetExchange`，实现类一行都不用写。这篇文章用两个能直接跑起来的工程，把这套东西的原理、配置和踩过的坑讲清楚。

## 一、这个问题到底是什么

**多数项目用 Feign，只用到了"声明式"这一个能力，却背上了整套 Spring Cloud 客户端的维护成本。**

先把话说明白：Feign 不差。它解决的问题很具体——你不想手写 `RestTemplate` 拼 URL、设请求头、处理反序列化，于是定义一个接口，让框架帮你发请求。

问题是，这个能力的实现方式，和 Spring Cloud 的版本节奏绑在了一起。

### Feign 的隐性成本，不在代码里

```java
@FeignClient(name = "user-service", url = "${user.service.url}")
public interface UserClient {
    @GetMapping("/api/users/{id}")
    UserProfile getById(@PathVariable("id") Long id);
}
```

看着很干净。但为了这四行，你要承担这些东西：

| 成本项 | 具体表现 |
| --- | --- |
| 依赖连带 | `spring-cloud-starter-openfeign` 会带进 `spring-cloud-commons`、`spring-cloud-loadbalancer`、`feign-core` 一整串 |
| 版本矩阵 | Spring Cloud 的 release train 和 Spring Boot 版本强绑定，升级必须成对改，改错一个就是启动报错 |
| 配置分散 | 超时在 `feign.client.config.<name>.connectTimeout`，换底层 HTTP 客户端要换依赖，日志级别又要单独开 |
| 注解翻译 | Feign 要靠 `SpringMvcContract` 把 Spring MVC 注解翻译成自己的模板，翻译不到的地方就静默失效 |

最后一条最坑。比如 `@RequestParam` 不写 `value`，在某些组合下参数名直接变成 `arg0`，请求打到下游 400，日志里还看不出问题。

### 那不用 Feign，用什么

用 Spring 框架自带的 HTTP Interface，也就是**声明式 HTTP 客户端**。它从 Spring Framework 6.0 就有了，Spring Boot 4 提供了自动配置和分组管理，用起来是这样：

```java
public interface UserServiceClient {

    @GetExchange("/api/users/{id}")
    UserProfile getById(@PathVariable("id") Long id);
}
```

没有 `@FeignClient`，没有 starter，没有版本矩阵。接口写完，配一行 base-url，就能注入使用。

### 什么情况下不该换

有三种情况，我建议你继续用 Feign：

- 服务实例是动态的，靠注册中心上下线，你需要客户端负载均衡
- 已经有 Sentinel 或 Resilience4j 的 Feign 适配，熔断降级逻辑写在注解上
- 团队里 Feign 用得很熟，换框架的收益抵不上培训成本

反过来说，如果你的场景是"订单服务调用户服务""报表服务调三个内部接口"这种固定下游，那 Feign 的那套全家桶，八成用不上。

## 二、底层原理到底怎么回事

### 接口没有实现类，请求到底是谁发的

**声明式 HTTP 客户端的本质，是运行时用 JDK 动态代理给你生成了一个实现类。**

整个过程可以拆成三段，用点菜打个比方：

- **菜单**：你写的接口和注解，规定了有哪些菜、要什么参数
- **服务员**：动态代理，接单、把口语翻译成后厨能懂的工单
- **后厨**：`RestClient` 或 `WebClient`，真正把 HTTP 请求发出去

调用 `userServiceClient.getById(1L)` 时，发生的事按顺序是：

1. 代理拦截这次方法调用
2. 读方法上的 `@GetExchange("/api/users/{id}")`，拿到 HTTP 方法（GET）和 URI 模板
3. 读参数上的 `@PathVariable("id")`，把实参 `1L` 填进模板，得到 `/api/users/1`
4. 打包成一个请求描述对象（URI、请求头、请求体、返回类型）
5. 交给底层的 client adapter 执行，`RestClient` 走同步，`WebClient` 走响应式
6. 拿回响应体，用 `HttpMessageConverter` 反序列化成 `UserProfile`

关键在第 4 步：**注解在这一步就被翻译完了，之后跟普通的 HTTP 调用没有区别。** 所以性能上别指望有什么魔法，它和你手写 `RestClient` 是同一层。

### 为什么它的注解和 Spring MVC 一模一样

因为就是同一套注解。

服务端写 `@GetMapping("/api/users/{id}")`，客户端就写 `@GetExchange("/api/users/{id}")`；服务端 `@PathVariable`，客户端也 `@PathVariable`。区别只在动词：`@GetExchange`、`@PostExchange`、`@PutExchange`、`@DeleteExchange`、`@PatchExchange`。

Feign 走的是另一条路：它有自己的注解体系，为了兼容 Spring MVC 的写法，额外实现了一个 `SpringMvcContract` 做翻译。翻译层越多，"这个注解为什么不生效"的坑就越多。

HTTP Interface 不需要翻译，解析器就是 Spring MVC 自己那套。这是它最大的优势，也是它最大的限制——**它只认 Spring 的注解语义，Feign 那些私有扩展它一个都不认。**

### group 是什么：一组客户端共享同一份配置

这是 Spring Boot 4 加的东西，也是实际项目里最有用的部分。

一个 group 就是一批 HTTP 接口的集合，它们共享：

- 基础地址（base-url）
- 连接超时、读取超时
- SSL 证书配置
- 默认请求头

配置写在 `spring.http.serviceclient.<group名>` 下面：

```yaml
spring:
  http:
    serviceclient:
      user:
        base-url: http://localhost:8081
        connect-timeout: 500ms
        read-timeout: 2s
```

然后注册的时候告诉 Boot，这个包下的接口属于 `user` 组：

```java
@ImportHttpServices(group = "user", basePackages = "com.example.orderservice.client")
```

`@ImportHttpServices` 干的事就三步：扫包、找出带 `@HttpExchange` 的接口、注册成 Bean。不写 `group` 就归到默认组 `default`。

地址的优先级要记牢：**接口上写死的 `@HttpExchange(url = "...")` 优先于 group 的 base-url。** 这不是小事，后面踩坑那节会讲它怎么让配置诡异地失效。

### 超时是谁在管

不是 HTTP Interface 在管，是底层的 `ClientHttpRequestFactory` 在管。

Spring Boot 把 `connect-timeout` 和 `read-timeout` 绑到了 HTTP 客户端的构造参数上：

- `connect-timeout`：TCP 握手等多久。下游机器挂了、网络不通，卡在这一步
- `read-timeout`：连接建立后，等响应等多久。下游业务慢，卡在这一步

**默认不配，读取超时是无限等。** 这是最容易被忽略的一条。同步调用下，一个卡住的下游会把这个 Tomcat 线程一直占着，并发一上来，线程池见底，你的服务跟着一起挂。

所以有一条硬规矩：**下游客户端的超时，必须小于上游调用你的超时。** 否则上游已经放弃了，你还在傻等，白占资源。

## 三、实战：两个 Spring Boot 工程，把声明式客户端跑起来

先看整体结构。两个独立工程，一个提供用户数据，一个下单时去查用户：

```text
declarative-http-demo/
├── user-service/          # 端口 8081，被调用方
│   ├── pom.xml
│   └── src/main/
│       ├── java/com/example/userservice/
│       │   ├── UserServiceApplication.java
│       │   └── web/
│       │       ├── UserController.java
│       │       └── UserProfile.java
│       └── resources/application.yml
└── order-service/         # 端口 8080，调用方
    ├── pom.xml
    └── src/main/
        ├── java/com/example/orderservice/
        │   ├── OrderServiceApplication.java
        │   ├── client/UserServiceClient.java
        │   ├── config/HttpClientConfig.java
        │   ├── model/UserProfile.java
        │   ├── model/OrderSummary.java
        │   └── web/
        │       ├── OrderController.java
        │       └── DownstreamExceptionHandler.java
        └── resources/application.yml
```

环境要求：JDK 21、Maven 3.9+。下面每个文件都是完整的，复制过去就能编译。

### 被调用方：user-service

**pom.xml**，父工程管住所有 Spring 依赖的版本：

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
    <artifactId>user-service</artifactId>
    <version>1.0.0</version>
    <name>user-service</name>

    <properties>
        <java.version>21</java.version>
    </properties>

    <dependencies>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-web</artifactId>
            <version>4.1.2</version>
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

**application.yml**，只改端口，其他用默认：

```yaml
server:
  port: 8081
```

**UserServiceApplication.java**，启动类：

```java
package com.example.userservice;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class UserServiceApplication {

    public static void main(String[] args) {
        SpringApplication.run(UserServiceApplication.class, args);
    }
}
```

**UserProfile.java**，用 `record` 当传输对象，序列化不需要额外配置：

```java
package com.example.userservice.web;

public record UserProfile(Long id, String name, int level, int points) {
}
```

**UserController.java**，提供两个接口，一个查资料，一个查积分：

```java
package com.example.userservice.web;

import java.util.Map;

import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

@RestController
@RequestMapping("/api/users")
public class UserController {

    private static final Map<Long, UserProfile> USERS = Map.of(
            1L, new UserProfile(1L, "张三", 3, 1200),
            2L, new UserProfile(2L, "李四", 5, 8600)
    );

    @GetMapping("/{id}")
    public UserProfile getById(@PathVariable("id") Long id) {
        UserProfile profile = USERS.get(id);
        if (profile == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "user not found: " + id);
        }
        return profile;
    }

    @GetMapping("/{id}/points")
    public int points(@PathVariable("id") Long id,
                      @RequestParam("scene") String scene) {
        UserProfile profile = getById(id);
        return switch (scene) {
            case "ORDER" -> profile.points();
            case "PROMOTION" -> profile.points() * 2;
            default -> throw new ResponseStatusException(
                    HttpStatus.BAD_REQUEST, "unknown scene: " + scene);
        };
    }
}
```

数据是内存里的死数据，够验证链路了。`points` 接口故意做一个场景判断，是为了后面演示带查询参数的调用。

### 调用方：order-service

**pom.xml**，和上面基本一样，只换 artifactId。这里没有任何 Feign 依赖：

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
    <artifactId>order-service</artifactId>
    <version>1.0.0</version>
    <name>order-service</name>

    <properties>
        <java.version>21</java.version>
    </properties>

    <dependencies>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-web</artifactId>
            <version>4.1.2</version>
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

**application.yml**，组名 `user` 必须和注册注解里的 `group` 对上：

```yaml
server:
  port: 8080

spring:
  http:
    clients:
      connect-timeout: 1s
      read-timeout: 3s
    serviceclient:
      user:
        base-url: http://localhost:8081
        connect-timeout: 500ms
        read-timeout: 2s
```

这里配了两层。`spring.http.clients` 是全局默认值，对所有自动配置的客户端生效；`spring.http.serviceclient.user` 是 `user` 组的专属配置，会盖掉全局值。

**UserServiceClient.java**，客户端契约。注意接口上**没有**写 `url`，地址交给 group 管：

```java
package com.example.orderservice.client;

import com.example.orderservice.model.UserProfile;

import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.service.annotation.GetExchange;

public interface UserServiceClient {

    @GetExchange("/api/users/{id}")
    UserProfile getById(@PathVariable("id") Long id);

    @GetExchange("/api/users/{id}/points")
    int points(@PathVariable("id") Long id, @RequestParam("scene") String scene);
}
```

**UserProfile.java**，调用方自己也要有一份同样的结构。两个工程是独立的，不共享模块：

```java
package com.example.orderservice.model;

public record UserProfile(Long id, String name, int level, int points) {
}
```

**HttpClientConfig.java**，给这个组统一加个来源头。排查链路时，下游一眼能看出谁调的：

```java
package com.example.orderservice.config;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.client.support.RestClientHttpServiceGroupConfigurer;

@Configuration(proxyBeanMethods = false)
public class HttpClientConfig {

    @Bean
    RestClientHttpServiceGroupConfigurer httpServiceGroupConfigurer() {
        return groups -> groups.forEachClient((group, builder) ->
                builder.defaultHeader("X-Caller", "order-service"));
    }
}
```

`RestClientHttpServiceGroupConfigurer` 是 Boot 提供的扩展点，返回值里你对每个组的 `RestClient.Builder` 做点什么都行——加请求头、加拦截器、换请求工厂。声明式客户端本身没有"全局拦截器配置项"，这类需求都从这里下手。

**OrderSummary.java**，订单摘要的返回结构：

```java
package com.example.orderservice.model;

public record OrderSummary(Long orderId, String userName, int userLevel, int usablePoints) {
}
```

**OrderController.java**，业务入口。查一次用户资料，再查一次可用积分，拼成摘要：

```java
package com.example.orderservice.web;

import java.util.Map;

import com.example.orderservice.client.UserServiceClient;
import com.example.orderservice.model.OrderSummary;
import com.example.orderservice.model.UserProfile;

import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

@RestController
@RequestMapping("/api/orders")
public class OrderController {

    private static final Map<Long, Long> ORDER_OWNER = Map.of(
            1001L, 1L,
            1002L, 2L
    );

    private final UserServiceClient userServiceClient;

    public OrderController(UserServiceClient userServiceClient) {
        this.userServiceClient = userServiceClient;
    }

    @GetMapping("/{orderId}/summary")
    public OrderSummary summary(@PathVariable("orderId") Long orderId) {
        Long userId = ORDER_OWNER.get(orderId);
        if (userId == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "order not found: " + orderId);
        }

        UserProfile profile = userServiceClient.getById(userId);
        int points = userServiceClient.points(userId, "ORDER");

        return new OrderSummary(orderId, profile.name(), profile.level(), points);
    }
}
```

`UserServiceClient` 直接构造器注入，不需要任何工厂、不需要 `@Autowired`。注册工作 `@ImportHttpServices` 已经做完了。

**DownstreamExceptionHandler.java**，把下游的 4xx/5xx 转成 502。不处理的话，下游一个 404 会让你的接口直接 500，报错信息还全是别人家的：

```java
package com.example.orderservice.web;

import java.util.Map;

import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.client.RestClientResponseException;

@RestControllerAdvice
public class DownstreamExceptionHandler {

    @ExceptionHandler(RestClientResponseException.class)
    public ResponseEntity<Map<String, Object>> handleDownstreamError(RestClientResponseException ex) {
        return ResponseEntity.status(HttpStatus.BAD_GATEWAY)
                .body(Map.of(
                        "error", "downstream_failed",
                        "downstreamStatus", ex.getStatusCode().value(),
                        "message", ex.getStatusText()
                ));
    }
}
```

**OrderServiceApplication.java**，启动类，注册客户端就靠这一行注解：

```java
package com.example.orderservice;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.web.service.registry.ImportHttpServices;

@SpringBootApplication
@ImportHttpServices(group = "user", basePackages = "com.example.orderservice.client")
public class OrderServiceApplication {

    public static void main(String[] args) {
        SpringApplication.run(OrderServiceApplication.class, args);
    }
}
```

### 跑起来验证

先起 user-service，再起 order-service：

```bash
cd user-service && mvn spring-boot:run
cd order-service && mvn spring-boot:run
```

直接打被调用方，确认它自己是好的：

```bash
curl http://localhost:8081/api/users/1
# {"id":1,"name":"张三","level":3,"points":1200}
```

再打调用方，验证声明式客户端：

```bash
curl http://localhost:8080/api/orders/1001/summary
# {"orderId":1001,"userName":"张三","userLevel":3,"usablePoints":1200}
```

最后验证异常链路，取一个不存在的用户：

```bash
curl -i http://localhost:8080/api/orders/9999/summary
# HTTP/1.1 404
```

订单不存在走本地异常，404。如果把 `application.yml` 里的 base-url 改成一个不存在的端口再请求 1001，就会看到 502 和 `downstream_failed`，说明异常处理器生效了。

## 四、踩坑经验和最佳实践

**下面这六条，都是我在真实项目里撞过的墙，按遇到频率排序。**

### 1. `@PathVariable` 一定写名字

```java
// 别这么写
@GetExchange("/api/users/{id}")
UserProfile getById(@PathVariable Long id);
```

编译时如果没保留参数名，Spring 拿到的就是 `arg0`，运行时报 `Could not resolve placeholder 'id'`。Spring Boot 的 Maven 插件默认开了 `-parameters`，正常没事；但只要你动过编译配置、或者用了某些代码生成工具，这行就废了。

显式写 `@PathVariable("id")`，一行字的事，能省掉一次深夜排查。

### 2. base-url 和接口路径，两边都别同时带斜杠

```yaml
base-url: http://localhost:8081/
```

```java
@GetExchange("/api/users/{id}")   // 前面也有斜杠
```

拼出来是 `http://localhost:8081//api/users/1`。多数服务端能容忍，但网关、Nginx 的某些 rewrite 规则、还有对路径做严格校验的框架，会直接给你 404。规矩很简单：**base-url 结尾不带斜杠，接口路径开头带斜杠。**

### 3. group 名字写错，报的是"URI is not absolute"

```java
@ImportHttpServices(group = "users", ...)   // 多了一个 s
```

```yaml
spring.http.serviceclient.user.base-url: ...  # 这里是 user
```

启动不报错，一调用就炸：`URI is not absolute`。因为 `users` 组没配 base-url，框架只能拿一个相对路径去发请求。

这类错误启动期发现不了，配置类的坑大多这样。建议把组名抽成常量，注册注解和 yml 一起改。

### 4. 4xx/5xx 是抛异常，不是返回 null

Feign 默认把非 2xx 当异常抛，HTTP Interface 也一样，抛的是 `RestClientResponseException`。别写成这样：

```java
UserProfile profile = userServiceClient.getById(userId);
if (profile == null) { ... }   // 永远进不来
```

要么像上面那样加 `@RestControllerAdvice` 统一兜住，要么在 group 配置里用 `defaultStatusHandler` 自己定义映射规则。

### 5. 不配超时，等于把线程交给下游保管

`SimpleClientHttpRequestFactory` 的读取超时默认是无限。下游一个慢查询卡 30 秒，你的线程就陪着站 30 秒。

配置顺序照这个来：**先配全局兜底，再给慢接口单独放宽。**

```yaml
spring:
  http:
    clients:
      connect-timeout: 1s
      read-timeout: 3s
    serviceclient:
      user:
        read-timeout: 2s
```

顺序反了没意义——组的配置会覆盖全局，你给全局配 3 秒，组里配 10 秒，实际生效的是 10 秒。

### 6. 接口上写死 url，会让 group 的 base-url 静默失效

```java
@HttpExchange(url = "http://localhost:8081")   // 类型级别写死
public interface UserServiceClient { ... }
```

上线换环境，你把 yml 里的 base-url 改成生产地址，请求还是打到 `localhost:8081`。因为类型级别的 `url` 优先级更高。

用 group 管地址，就一条路走到黑，别在接口上留硬编码。测试环境想临时切地址，用 profile 覆盖 yml 就行。

### 一条额外建议：一个组只对应一个下游

group 的 base-url 是唯一的。你要是把用户接口和库存接口塞进同一个组，必然有一个打不通。接口按下游服务分包，组按包划分，一一对应，后面加超时、加证书都不会打架。

## 五、性能对比和技术选型

**两者不是两套 HTTP 实现，是同一层之上的两种封装，性能差异可以忽略，选型该看维护成本。**

| 维度 | Spring Cloud OpenFeign | 声明式 HTTP 客户端 |
| --- | --- | --- |
| 额外依赖 | `spring-cloud-starter-openfeign` 及一串传递依赖 | 无，`spring-boot-starter-web` 自带 |
| 声明方式 | `@FeignClient` + Spring MVC 注解 | `@HttpExchange` + Spring MVC 注解 |
| 地址配置 | 注解 `url` 或注册中心服务名 | `spring.http.serviceclient.<group>.base-url` |
| 超时配置 | `feign.client.config.*` | `spring.http.clients.*` + 组配置 |
| 客户端负载均衡 | 内置，配合注册中心开箱可用 | 不内置，要自己接 `LoadBalancer` |
| 熔断降级 | Sentinel / Resilience4j 有现成适配 | 需要自己在拦截器或上层做 |
| 重试 | 有 `spring-cloud-openfeign` 的 Retryer | 没有内置，自己加 |
| 版本耦合 | 与 Spring Cloud release train 强绑定 | 只跟 Spring Boot 走 |
| 上手成本 | 概念多（Contract、Encoder、Decoder、Retryer） | 会写 Controller 就会用 |

性能那一栏单独说一句。两者最终都把请求交给同一个 HTTP 客户端库——JDK 的 `HttpClient`、Apache HttpClient 或者 Reactor Netty。差别只在"注解翻译成请求描述"这一步，而且都是一次性解析加缓存，单次调用的差距在微秒级。**拿性能当换框架的理由，站不住脚。**

我给三个判断条件，对上了就换：

- **下游地址固定在配置文件里**，不依赖注册中心动态发现 → 换，省一个 starter 和一堆版本麻烦
- **只需要调接口，不需要熔断降级** → 换，`@RestControllerAdvice` 加超时配置足够覆盖
- **需要服务发现 + 客户端负载均衡 + 熔断** → 别换，Feign 生态成熟，硬换等于自己造轮子

还有个中间态值得提：注册中心照用，但客户端换掉。这时候 base-url 指向网关或者一个固定域名，让网关去做负载均衡。多一跳网络，换来的是一整层依赖的消失，很多团队算过这笔账是划算的。

## 六、总结：该换的换，不该换的别折腾

声明式 HTTP 客户端解决的问题很窄：**让你在不引入 Spring Cloud 的前提下，用接口的方式调 HTTP。**

它的原理不神秘——JDK 动态代理翻译注解，`RestClient` 发请求，`HttpMessageConverter` 反序列化。真正省事的是三件事：注解和 Controller 完全一致、地址和超时集中在一个 group 里、没有版本矩阵要记。

要记住的坑也就那么几个：`@PathVariable` 写名字、斜杠别重复、组名和 yml 对齐、4xx 会抛异常、超时必须配、别在接口上硬编码地址。

至于换不换，我的态度很明确：**新项目、固定下游、没有熔断需求，直接用声明式客户端，别再引 Feign 了。** 已经在 Spring Cloud 全家桶里跑得好好的存量项目，为了"技术更新"去动它，收益是负的。

工具的价值在于解决问题，不在于用的人多。你调三个内部接口，不需要一支舰队。

## 参考资料

- [HTTP Service Clients - Spring Boot Reference](https://docs.spring.io/spring-boot/reference/io/rest-client.html)
- [HTTP Interface - Spring Framework Reference](https://docs.spring.io/spring-framework/reference/integration/rest-clients.html#rest-http-service-client)
- [Spring Cloud OpenFeign Reference](https://docs.spring.io/spring-cloud-openfeign/reference/)
- [spring-boot-starter-parent - Maven Central](https://central.sonatype.com/artifact/org.springframework.boot/spring-boot-starter-parent/versions)

文 / 会编程的吕洞宾
