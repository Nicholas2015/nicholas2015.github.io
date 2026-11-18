---
title: "Spring Boot 4升级，这4处不改编译就挂"
date: 2026-11-01T09:00:00+08:00
category: "Spring"
tags: ["spring-boot"]
---

上周有个朋友把项目从 Spring Boot 3.5 拉到 4.0，`mvn compile` 一跑，满屏红。他以为 IDE 抽风，重装了两遍插件，最后发现是 Jackson 的包名换了、Undertow 的 starter 没了、`@WebMvcTest` 搬到了新包。Spring Boot 4 不是把版本号加一那么简单，它把整个骨架拆开重装了一遍。这篇讲清升级路上最容易翻车的四处，每处都给能直接跑的完整代码。

## 一、这个问题到底是什么

Spring Boot 4 的升级难度，来自四个同时发生的大改动，而不是某一个 API 被删。它们各自都能让项目起不来，叠在一起就是「一编译全是错，一启动缺 bean」。

先说结论：这不是一次常规的小版本升级，而是一次基座更换。Spring Boot 4 基于 Spring Framework 7，要求 Java 17 起步，Jakarta EE 11 和 Servlet 6.1 成为底线。老项目里那些「能跑就不动」的依赖，这次会集中暴露。

四处最容易出问题的地方，对比如下：

| 变化点 | 你会看到的症状 | 根因 |
| --- | --- | --- |
| Starter 与包名重构 | 找不到符号、某个功能静默不生效 | 模块被拆细，包名前缀变成 `org.springframework.boot.<模块>` |
| Jackson 3 接管 JSON | `com.fasterxml.jackson.databind` 全部报红、自定义 `ObjectMapper` 不生效 | 换成了 `tools.jackson`，自动配置的 bean 类型变成 `JsonMapper` |
| Undertow 支持移除 | `spring-boot-starter-undertow` 依赖解析失败 | Servlet 6.1 基线下 Undertow 还不兼容 |
| 配置属性改名或删除 | 启动日志一堆 `Unknown property`，行为悄悄变了 | 3.x 里废弃的属性在 4.0 被彻底删掉 |

这里要强调一点：第四项最阴。前三项编译期就报错，你会立刻去改；配置属性不报错，只是不生效。比如限流阈值、连接池大小，写错了不吭声，压测的时候才发现数字没变。

真实场景里，很多团队是在「编译过了、单测过了、上线后监控指标不对」这一步才发现配置问题的。所以升级 Spring Boot 4，光让代码编译通过远远不够，得让启动日志干净。

## 二、底层原理到底怎么回事

### 2.1 模块化：从几个大 jar 拆成一堆小 jar

Spring Boot 4 把过去几个巨型 jar 拆成了按技术划分的独立模块，命名规则很统一：模块叫 `spring-boot-<technology>`，根包名是 `org.springframework.boot.<technology>`，starter 叫 `spring-boot-starter-<technology>`。

这么拆的好处是按需引入，编译面和启动扫描面都小一圈。代价是依赖不再「顺带给你」了。

举个最容易踩的例子。以前你用 Flyway，只要加 Flyway 自己的依赖，Spring Boot 的自动配置就能认出来。现在自动配置被挪进了 `spring-boot-flyway` 模块，你得显式加 `spring-boot-starter-flyway`。不加会怎样？编译没问题，启动也没报错，就是数据库迁移一声不响地不执行。

一句话：以前靠传递依赖白拿的能力，现在要自己点名。

测试侧同样拆了。规则是 `spring-boot-<technology>-test` 和 `spring-boot-starter-<technology>-test`，包名是 `org.springframework.boot.<technology>.test`。所以老代码里这行 import 会直接失效：

```java
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
```

新的位置在 `org.springframework.boot.webmvc.test.autoconfigure`。这不是改个名字的事，是整个测试基础设施重新归位。

还有个过渡工具值得知道：`spring-boot-starter-classic`。它把 3.x 那套完整 classpath 拼回来，让你先跑通，再一块块换掉。项目大、依赖多的时候，两段式升级比一把梭稳。

### 2.2 Jackson 3：groupID 和包名一起换

Spring Boot 4 的首选 JSON 库换成了 Jackson 3。这是升级里改动量最大的一块，因为它渗透在你写的每一个 DTO、每一个序列化器里。

Jackson 3 把 `com.fasterxml.jackson` 换成了 `tools.jackson`，Maven 的 groupId 也跟着从 `com.fasterxml.jackson.core` 变成 `tools.jackson.core`。

有个例外要记住：`jackson-annotations` 没搬，groupId 还是 `com.fasterxml.jackson.core`，包名还是 `com.fasterxml.jackson.annotation`。所以你的 `@JsonProperty`、`@JsonIgnore` 不用动，只有 databind 那一层要改。

自动配置的 bean 类型也变了。以前注入 `ObjectMapper`，现在自动配置的是一个 `JsonMapper`（JSON 专用），XML 那边是 `XmlMapper`。这里有个坑：你自己定义一个 `ObjectMapper` bean 已经不能覆盖默认配置了，得定义 `JsonMapper`。

几个类名也跟着改：

- `Jackson2ObjectMapperBuilderCustomizer` 改成 `JsonMapperBuilderCustomizer`
- `@JsonComponent` 改成 `@JacksonComponent`
- `@JsonMixin` 改成 `@JacksonMixin`
- `JsonObjectSerializer` / `JsonValueDeserializer` 改成 `ObjectValueSerializer` / `ObjectValueDeserializer`

还有一个行为变化挺关键：Spring Boot 4 会自动发现 classpath 上所有的 Jackson 模块并注册，3.x 只注册「已知的」那些。如果你项目里有模块被意外注册导致输出变了，可以用 `spring.jackson.find-and-add-modules=false` 关掉。

属性也搬了家：原来的 `spring.jackson.read.*` 和 `spring.jackson.write.*`，现在挂在 `spring.jackson.json.read` 和 `spring.jackson.json.write` 下面。

### 2.3 Undertow 下线：不是配置问题，是兼容问题

Spring Boot 4 要求 Servlet 6.1 基线，而 Undertow 目前还跟不上，所以 Undertow 的支持被整个删了——starter 没了，内嵌容器的选项也没了。

这个变化对很多「为了性能换 Undertow」的老项目是硬伤。升级那一刻，`spring-boot-starter-undertow` 直接解析不到，`server.undertow.*` 这一堆调优参数也全部作废。

官方给的路只有两条：回到 Tomcat（默认），或者换 Jetty。别指望用 `spring-boot-starter-classic` 抢救，classic 拼的是 3.x 的 classpath，容器这块该换还得换。

顺带说一句：Spring Boot 4 也建议不要把它部署到非 Servlet 6.1 的容器里。外置容器部署的老项目，升级前先确认容器版本。

### 2.4 配置属性：删得干干净净

3.x 里标了 `@Deprecated` 的属性，4.0 直接删除，不留缓冲。这不只是「写了没效果」，有些默认值也变了。

官方给了个迁移工具：`spring-boot-properties-migrator`。加上去以后，启动时会扫描你的配置，打印哪些属性已经不存在、应该换成什么，并且临时在运行期帮你兼容旧名字。

要提醒的是，这个模块是给迁移期用的。你总不能把「临时兼容层」带上生产，迁移完成后记得删掉。

## 三、实战：手把手写代码

下面是一个完整的订单服务，涵盖 pom、配置、业务代码、测试四块，全部按 Spring Boot 4 的写法来。复制到本地就能跑。

### 3.1 完整的 pom.xml

关键点三个：parent 用 4.x、`java.version` 写 21、Web 依赖用新的 `spring-boot-starter-webmvc`（老的 `spring-boot-starter-web` 还能用，但已经是废弃状态）。

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
    <artifactId>order-demo</artifactId>
    <version>1.0.0</version>
    <name>order-demo</name>

    <properties>
        <java.version>21</java.version>
        <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
    </properties>

    <dependencies>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-webmvc</artifactId>
            <version>4.1.2</version>
        </dependency>

        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-validation</artifactId>
            <version>4.1.2</version>
        </dependency>

        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-actuator</artifactId>
            <version>4.1.2</version>
        </dependency>

        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-webmvc-test</artifactId>
            <version>4.1.2</version>
            <scope>test</scope>
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

注意测试依赖只写了 `spring-boot-starter-webmvc-test`，没有单独写 `spring-boot-starter-test`。新的测试 starter 会把它传递带进来，写两个反而容易版本打架。

### 3.2 完整的 application.yml

```yaml
server:
  port: 8080
  shutdown: graceful

spring:
  application:
    name: order-demo
  jackson:
    default-property-inclusion: non_null

management:
  endpoints:
    web:
      exposure:
        include: health,info,metrics
  endpoint:
    health:
      show-details: always
```

`spring.jackson.default-property-inclusion` 这个属性在 4.x 里仍然有效，属于没有被搬走的那批。JSON 读写特性（原来的 `spring.jackson.read.*`）才需要改成 `spring.jackson.json.read.*`。

### 3.3 启动类和业务代码

启动类没什么变化，还是那个注解。

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

请求体和返回体都用 record，字段校验注解直接标在组件上。

```java
package com.example.order.web;

import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;

public record CreateOrderRequest(
        @NotBlank(message = "sku 不能为空") String sku,
        @Min(value = 1, message = "数量至少为 1") int quantity) {
}
```

```java
package com.example.order.web;

import java.time.Instant;

public record OrderView(long id, String sku, int quantity, Instant createdAt) {
}
```

服务层用内存 Map 顶着，重点看写法不看存储。

```java
package com.example.order.service;

import com.example.order.web.CreateOrderRequest;
import com.example.order.web.OrderView;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;

@Service
public class OrderService {

    private final Map<Long, OrderView> store = new ConcurrentHashMap<>();
    private final AtomicLong idGenerator = new AtomicLong(0);

    public OrderView create(CreateOrderRequest request) {
        long id = idGenerator.incrementAndGet();
        OrderView view = new OrderView(id, request.sku(), request.quantity(), Instant.now());
        store.put(id, view);
        return view;
    }

    public List<OrderView> findAll() {
        return store.values().stream()
                .sorted(Comparator.comparingLong(OrderView::id))
                .toList();
    }
}
```

控制器只做转发和参数校验。

```java
package com.example.order.web;

import com.example.order.service.OrderService;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

@RestController
@RequestMapping("/api/orders")
public class OrderController {

    private final OrderService orderService;

    public OrderController(OrderService orderService) {
        this.orderService = orderService;
    }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    public OrderView create(@Valid @RequestBody CreateOrderRequest request) {
        return orderService.create(request);
    }

    @GetMapping
    public List<OrderView> list() {
        return orderService.findAll();
    }
}
```

校验失败时返回标准的 `ProblemDetail`，前端拿到的是一段结构化 JSON，不是一坨 500 堆栈。这块 API 在 Framework 7 里没动。

```java
package com.example.order.web;

import org.springframework.http.HttpStatus;
import org.springframework.http.ProblemDetail;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

@RestControllerAdvice
public class GlobalExceptionHandler {

    @ExceptionHandler(MethodArgumentNotValidException.class)
    public ProblemDetail handleInvalidArgument(MethodArgumentNotValidException ex) {
        ProblemDetail problem = ProblemDetail.forStatus(HttpStatus.BAD_REQUEST);
        problem.setTitle("参数校验失败");
        String detail = ex.getBindingResult().getFieldErrors().stream()
                .map(error -> error.getField() + ": " + error.getDefaultMessage())
                .reduce((left, right) -> left + "; " + right)
                .orElse("未知字段");
        problem.setDetail(detail);
        return problem;
    }
}
```

### 3.4 测试类：import 全换新包

这段是升级时最容易卡住的地方，注意 `@WebMvcTest` 和 `@AutoConfigureMockMvc` 的包名，以及 `@MockitoBean` 的用法。

```java
package com.example.order.web;

import com.example.order.service.OrderService;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.WebMvcTest;
import org.springframework.http.MediaType;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;

import java.time.Instant;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.BDDMockito.given;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

@WebMvcTest(OrderController.class)
class OrderControllerTest {

    @Autowired
    private MockMvc mockMvc;

    @MockitoBean
    private OrderService orderService;

    @Test
    void createOrderReturns201() throws Exception {
        given(orderService.create(any(CreateOrderRequest.class)))
                .willReturn(new OrderView(1L, "SKU-1001", 2, Instant.parse("2026-11-01T00:00:00Z")));

        mockMvc.perform(post("/api/orders")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"sku\":\"SKU-1001\",\"quantity\":2}"))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.sku").value("SKU-1001"))
                .andExpect(jsonPath("$.quantity").value(2));
    }
}
```

跑起来：

```bash
mvn test
mvn spring-boot:run
curl -X POST http://localhost:8080/api/orders \
  -H 'Content-Type: application/json' \
  -d '{"sku":"SKU-1001","quantity":2}'
```

返回 `{"id":1,"sku":"SKU-1001","quantity":2,"createdAt":"..."}`，`createdAt` 的格式由 Jackson 的日期处理决定，不影响业务流程。

### 3.5 用过 Undertow 的，容器怎么换

把 `spring-boot-starter-undertow` 删掉，在 `spring-boot-starter-webmvc` 上排掉 Tomcat，再加 Jetty：

```xml
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-webmvc</artifactId>
    <version>4.1.2</version>
    <exclusions>
        <exclusion>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-tomcat</artifactId>
        </exclusion>
    </exclusions>
</dependency>

<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-jetty</artifactId>
    <version>4.1.2</version>
</dependency>
```

同时把 `application.yml` 里的 `server.undertow.*` 整段删掉——这些属性在 4.x 已经不存在了，留着只会让启动日志变脏。

## 四、踩坑经验和最佳实践

升级踩过的坑，按疼的程度排：

**只改了 parent 版本，没改 starter。** 编译能过，启动少 bean。典型受害者是 Flyway、Liquibase 这种「以前只靠第三方依赖就能自动配置」的组件。判断方法很简单：启动日志里搜 `Flyway` 或 `Liquibase`，如果没有迁移记录，就是没生效。

**自定义 ObjectMapper 不生效。** 很多人有这么一个配置类，里面 `@Bean` 返回 `ObjectMapper`。4.x 里自动配置的是 `JsonMapper`，你定义的 `ObjectMapper` 成了另一个孤立 bean，业务里注入的仍然是默认那个，于是日期格式、空值策略全都不按你想的来。改成返回 `JsonMapper`。

**测试类 import 没换。** `org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest` 在 4.x 不存在了，得改成 `org.springframework.boot.webmvc.test.autoconfigure.WebMvcTest`。同类问题还有 `@AutoConfigureMockMvc`。

**Spring Security 的测试注解失灵。** `@WithMockUser` 和 `@WithUserDetails` 现在依赖 `spring-boot-starter-security-test`，不引这个 starter，注解会被忽略，测试直接 401。这个报错信息很难往依赖上想。

**properties-migrator 留在生产。** 它在启动时做运行期属性映射，是个临时脚手架。迁移验证完就删，别舍不得。

**自研 starter 想同时兼容 3 和 4。** 官方明确不建议在同一个 artifact 里同时支持两个大版本，因为包结构和自动配置的注册文件都变了。老实开分支，或者发两个 artifact。

关于升级顺序，我的建议是两段式：

1. 先升到 3.5 的最新维护版，把所有 `@Deprecated` 的调用清干净，把配置属性改到位。
2. 再加 `spring-boot-starter-classic` 过渡，把能编译通过的先跑起来。
3. 最后逐个替换成新 starter，删掉 classic。

项目里的 Spring Cloud 要一起看。Spring Cloud 2025.1.x 这条线对应的是 Spring Boot 4.0.x，硬拉 4.1.x 会出现 Bean 找不到的问题，因为自动配置类的注册方式对不上。

## 五、性能对比和技术选型

先说容器。三个内嵌容器里，Undertow 在 4.x 已经出局，可选项只剩 Tomcat 和 Jetty。

- Tomcat：默认选项，社区最大，出问题最好查，吞吐在常规业务下完全够用。
- Jetty：轻量，启动快，适合资源受限或者需要嵌入的场景，生态比 Tomcat 小一圈。
- Undertow：4.x 不可用。Servlet 6.1 兼容之前，别指望。

我的态度很直接：没有明确压测数据支撑，就用 Tomcat。为了「听说 Undertow 性能好」去换容器，最后大概率是给自己找了个没人能救的坑。

再说 JSON。Jackson 3 相比 2.x 主要是 API 清理和模块自动发现策略的调整，序列化吞吐不是一个数量级的差别。升级的真正收益是跟上 Spring 生态的主线，别指望换个 JSON 库把接口耗时降下来。真正的性能瓶颈，八成在数据库和锁上。

选型建议按项目状态分：

| 项目情况 | 建议 |
| --- | --- |
| 新项目 | 直接 4.1.x，配 Java 21 |
| 存量项目，依赖干净 | 走两段式升级，一周内能完成 |
| 存量项目，用了 Undertow | 先做容器替换和压测，再动版本 |
| 存量项目，有自研 starter | 先拆兼容层，升级排到最后 |

## 六、总结

Spring Boot 4 的升级，本质是把「隐式依赖」变成「显式声明」。模块拆细了，Jackson 换代了，Undertow 下线了，废弃属性删干净了——每一条都在逼你把项目里那些「反正能跑」的东西写清楚。

记住四件事就够动手：

- Web 依赖换成 `spring-boot-starter-webmvc`，测试注解的包名跟着换
- Jackson 用 `tools.jackson`，自定义 bean 从 `ObjectMapper` 改成 `JsonMapper`
- Undertow 用不了，回 Tomcat 或换 Jetty
- 配置属性先上 `spring-boot-properties-migrator` 扫一遍，迁完删掉

升级前把这三件事准备好：一份干净的启动日志、一套能跑的单测、一个能回滚的镜像。剩下的就是照报错一个个改，没有玄学。

## 参考资料

- [Spring Boot 4.0 Migration Guide](https://github.com/spring-projects/spring-boot/wiki/Spring-Boot-4.0-Migration-Guide)
- [Spring Boot System Requirements](https://docs.spring.io/spring-boot/system-requirements.html)
- [Jackson 3.0 Release Notes](https://github.com/FasterXML/jackson/wiki/Jackson-Release-3.0)
- [What's New in Spring Framework 7.x](https://github.com/spring-projects/spring-framework/wiki/What%27s-New-in-Spring-Framework-7.x)
- [spring-boot-starter-parent on Maven Central](https://central.sonatype.com/artifact/org.springframework.boot/spring-boot-starter-parent)

文 / 会编程的吕洞宾
