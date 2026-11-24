---
title: "Spring Boot 4 接口版本管理实战"
date: 2026-10-17T09:00:00+08:00
category: "Spring"
tags: ["spring-boot"]
---

> 上周接手一个老项目：手机 App 还在调 v1，新上的运营后台要 v2 字段。原来的做法是路径里塞 /v1/、/v2/，两套 Controller 各写一遍，改一处共用的校验逻辑要改两遍地，漏一处就是线上事故。更麻烦的是老客户端——你不知道它什么时候升级，字段不敢删，语义不敢改。Spring Boot 4 把「接口版本」做进了框架：版本从请求头读，匹配交给框架，废弃版本还能自动回一个标准响应头。这篇把整套机制拆开讲，代码贴全，照抄能跑。

## 一、接口版本管理到底在解决什么问题

结论：接口版本管理要解决的只有一件事——同一份后端代码，同时服务好几代客户端。

后端接口和前端页面不一样。页面发错了，用户刷新一下就是新的；接口一旦放出去，调它的东西就再也不受你控制。手机 App 有审核周期和用户不升级的问题，第三方合作方的代码在别人服务器上，硬件的固件可能三年不动一次。你改了字段，对方的程序就崩，报错还报在你这边。

所以接口一旦对外，就相当于签了合同。合同要改，得先出个新版本，老的继续履约，等对方搬完家再撤。

真干起来，大家一般走这三条路：

- **路径里带版本**：`/api/v1/orders`、`/api/v2/orders`，两套 Controller。最直观，问题是共用逻辑要写两遍。订单查询、权限校验、参数拼装，这些跟版本无关的代码被复制成两份，改一动二，时间一长两边逻辑就会悄悄跑偏。
- **方法里判断版本**：URL 不变，代码里 `if (version.equals("2"))` 决定返回哪套字段。不用复制类了，但判断散落在每个方法里，加一个版本要翻遍所有 Controller，而且这个 if 和业务逻辑缠在一起，测试也不好测。
- **干脆不版本化，只加字段**：怕破坏兼容，就只增不删不改。跑三年下来，一个返回对象四十个字段，一半没人用，谁也不敢删。

三条路都通，但都在同一个地方难受：**版本这件事没有统一的入口**。版本从哪读、怎么比较大小、某个版本还在不在服务、什么时候可以下线，全靠团队自觉和文档约定。约定这东西，人一换就散。

框架原生支持要解决的，就是把这四件事收进一个统一的地方：**解析、校验、匹配、提示**。

## 二、底层原理：版本这件事被拆成了三个角色

结论：Spring 把它拆成「解析、解析器、策略」三层，各管一段，谁也不越界。

### 2.1 版本从哪来：ApiVersionResolver

第一个角色只管一件事：从这次请求里把版本号抠出来。框架内置了四种来源。

- 请求头，比如 `API-Version: 1.1`
- 查询参数，比如 `?version=1.1`
- 路径片段，比如 `/api/{version}/orders`（需要告诉框架版本在第几段）
- 媒体类型参数，比如 `Accept: application/vnd.example.v1+json`

也可以自己写实现，接一个 `ApiVersionResolver` 进去。抠不出来就返回 null，表示这次请求没有版本。

### 2.2 版本怎么比大小：ApiVersionParser

第二个角色负责把 `"1.1"` 这种字符串变成能比较的东西。

默认实现是 `SemanticApiVersionParser`，它把版本切成 major、minor、patch 三个整数，缺的补 0。所以 "1.1" 变成 (1,1,0)，"2" 变成 (2,0,0)。

这一步看着无聊，但很关键：字符串比较会得出 "1.10" 小于 "1.9" 这种鬼结论，切成整数比就不会。你的版本号排出来是什么顺序，框架匹配就是什么顺序。

### 2.3 谁做决策：ApiVersionStrategy

第三个角色是总管，干活最多：拿着解析出来的版本，做三件事。

1. 校验：这个版本我支不支持？不支持直接拒。
2. 匹配：在所有 Controller 方法里，挑出该由谁来响应这次请求。
3. 提示：如果这个版本已经废弃了，往响应头里塞点信息，让客户端早点搬家。

前两件事由 MVC 配置初始化，你不用手动管。第三件事需要你自己配（后面实战里写）。

### 2.4 匹配规则：固定版本、基线版本、兜底版本

`@RequestMapping`（包括 `@GetMapping` 这些组合注解）多了一个 `version` 属性，可以写三种值：

| 写法 | 例子 | 含义 |
|---|---|---|
| 不写 version | `@GetMapping("/account/{id}")` | 匹配任意版本，但优先级最低，永远排在带版本的方法后面 |
| 固定版本 | `@GetMapping(version = "1.1")` | 只匹配 1.1 |
| 基线版本 | `@GetMapping(version = "1.2+")` | 匹配 1.2 以及所有比 1.2 高的已支持版本 |

规则一句话：**在「版本小于等于请求版本」的候选里，挑最高的那个。**

假设四个方法长这样：无版本、`1.1`、`1.2+`、`1.5`，那么：

| 请求版本 | 谁响应 | 为什么 |
|---|---|---|
| 1.3 | `1.2+` 那个 | 1.1 不够，1.2+ 是「≤1.3」里最高的；1.5 比 1.3 高，不参与 |
| 1.5 | `version = "1.5"` 那个 | 精确匹配压过基线匹配 |
| 1.6 | 没人响应，返回 400 | 被 1.5 的精确匹配顶掉了：既然有精确到 1.5 的方法，就说明 1.6 还没准备好，基线那套不能兜到 1.6 |

第三条最容易踩。基线版本不是「万能兜底」，它的作用范围会被更精确的高版本方法切断。

### 2.5 三种 400：别把它们当成一个错

版本相关的问题有三种，全部返回 400，但原因完全不同，排错时别搞混：

- `MissingApiVersionException`：请求没带版本，而你配置了「必须带」。默认就是必须带，这条最坑老客户端。
- `InvalidApiVersionException`：带了版本，但这个版本不在支持列表里。支持列表默认从 Controller 的映射里自动探测，可以关掉改用显式配置。
- `NotAcceptableApiVersionException`：版本本身合法，但找不到能响应它的方法（比如上面 1.6 那种情况）。

### 2.6 废弃提示：让客户端知道你该搬家了

版本要下线，最忌讳突然消失。框架内置了一个 `StandardApiVersionDeprecationHandler`，按 RFC 9745 和 RFC 8594 往响应头里写三样东西：`Deprecation`（什么时候开始废弃）、`Sunset`（什么时候彻底关掉）、`Link`（去哪看迁移文档）。

客户端那边只要有人盯着日志和监控，就能提前收到信号。这比在群里发通知靠谱。

另外提一句：RestClient、WebClient、HTTP Service 客户端，以及测试用的 MockMvc、WebTestClient 也都支持 API 版本，服务端和调用端可以用同一套规则，不用自己拼 header。

## 三、实战：手把手写代码

结论：一个订单接口，同时提供 v1、v1.1、v2 三个版本，老客户端不带版本也能进。

### 3.1 pom.xml

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
    <artifactId>api-versioning-demo</artifactId>
    <version>1.0.0</version>
    <name>api-versioning-demo</name>
    <description>Spring Boot 接口版本管理示例</description>

    <properties>
        <java.version>21</java.version>
        <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
    </properties>

    <dependencies>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-webmvc</artifactId>
            <version>4.1.1</version>
        </dependency>

        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-test</artifactId>
            <version>4.1.1</version>
            <scope>test</scope>
        </dependency>
    </dependencies>

    <build>
        <plugins>
            <plugin>
                <groupId>org.springframework.boot</groupId>
                <artifactId>spring-boot-maven-plugin</artifactId>
                <version>4.1.1</version>
            </plugin>
        </plugins>
    </build>
</project>
```

有个小变化要提醒：Spring Boot 4 里 Web MVC 的推荐 starter 改名叫 `spring-boot-starter-webmvc`，老名字 `spring-boot-starter-web` 还在，但已经标注为 deprecated，新项目直接上新名字。

### 3.2 启动类

```java
package com.example.apiversioning;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class ApiVersioningApplication {

    public static void main(String[] args) {
        SpringApplication.run(ApiVersioningApplication.class, args);
    }
}
```

### 3.3 三个版本的返回结构

版本升级最怕的就是「同一个对象改字段」。v2 要改语义，就该有自己的类，让编译器帮你守住边界。

```java
package com.example.apiversioning.dto;

import java.math.BigDecimal;

public record OrderViewV1(String orderNo, String statusText, BigDecimal amount) {
}
```

```java
package com.example.apiversioning.dto;

import java.math.BigDecimal;
import java.time.LocalDateTime;

public record OrderViewV1_1(String orderNo, String statusText, BigDecimal amount, LocalDateTime paidAt) {
}
```

```java
package com.example.apiversioning.dto;

import java.math.BigDecimal;
import java.time.LocalDateTime;
import java.util.List;

public record OrderViewV2(String orderNo, String statusCode, BigDecimal amount,
                          LocalDateTime paidAt, List<String> changedFields) {
}
```

v1 到 v1.1 是加字段，v1.1 到 v2 是改语义：`statusText` 变成 `statusCode`，从中文文案改成枚举码。这种改动没法靠加字段兼容，只能开新版本。

### 3.4 Controller：一个版本一个方法

```java
package com.example.apiversioning.controller;

import com.example.apiversioning.dto.OrderViewV1;
import com.example.apiversioning.dto.OrderViewV1_1;
import com.example.apiversioning.dto.OrderViewV2;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.math.BigDecimal;
import java.time.LocalDateTime;
import java.util.List;

@RestController
@RequestMapping("/api/orders")
public class OrderController {

    /** 不带版本：老客户端兜底，优先级最低 */
    @GetMapping("/{orderNo}")
    public OrderViewV1 getWithoutVersion(@PathVariable String orderNo) {
        return new OrderViewV1(orderNo, "已付款", new BigDecimal("99.00"));
    }

    @GetMapping(value = "/{orderNo}", version = "1.0")
    public OrderViewV1 getV1(@PathVariable String orderNo) {
        return new OrderViewV1(orderNo, "已付款", new BigDecimal("99.00"));
    }

    @GetMapping(value = "/{orderNo}", version = "1.1")
    public OrderViewV1_1 getV1_1(@PathVariable String orderNo) {
        return new OrderViewV1_1(orderNo, "已付款", new BigDecimal("99.00"), LocalDateTime.now());
    }

    @GetMapping(value = "/{orderNo}", version = "2.0+")
    public OrderViewV2 getV2(@PathVariable String orderNo) {
        return new OrderViewV2(orderNo, "PAID", new BigDecimal("99.00"), LocalDateTime.now(),
                List.of("statusText -> statusCode", "新增 changedFields"));
    }
}
```

四个方法路径完全一样，靠 `version` 区分优先级。注意最后一个用的是 `2.0+`（基线），意思是「2.0 以及之后所有已支持的版本都由它来答」，因为 v2 之后短期内不会再有新的结构变化。

### 3.5 开启版本管理（含废弃提示）

```java
package com.example.apiversioning.config;

import org.springframework.context.annotation.Configuration;
import org.springframework.web.accept.StandardApiVersionDeprecationHandler;
import org.springframework.web.servlet.config.annotation.ApiVersionConfigurer;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

import java.net.URI;
import java.time.ZonedDateTime;

@Configuration
public class ApiVersioningConfig implements WebMvcConfigurer {

    @Override
    public void configureApiVersioning(ApiVersionConfigurer configurer) {
        // 1. 从请求头 API-Version 里读版本
        configurer.useRequestHeader("API-Version");

        // 2. 不强制每个请求都带版本，老客户端不带就走无版本兜底方法
        configurer.setVersionRequired(false);

        // 3. 告诉客户端 1.0 已经废弃、什么时候彻底关掉
        StandardApiVersionDeprecationHandler deprecation = new StandardApiVersionDeprecationHandler();
        deprecation.configureVersion("1.0")
                .setDeprecationDate(ZonedDateTime.parse("2026-12-31T00:00:00Z"))
                .setDeprecationLink(URI.create("https://api.example.com/docs/deprecation"))
                .setSunsetDate(ZonedDateTime.parse("2027-06-30T00:00:00Z"))
                .setSunsetLink(URI.create("https://api.example.com/docs/migrate-to-v2"));
        configurer.setDeprecationHandler(deprecation);
    }
}
```

三步分别是解析、校验松紧、废弃提示。`setVersionRequired(false)` 这一行是给老客户端的活路：不写它，只要请求没带 `API-Version`，框架直接回 400。

### 3.6 application.yml

```yaml
server:
  port: 8080

spring:
  application:
    name: api-versioning-demo
```

版本管理已经在 Java 配置里开了，配置文件里不用再写一遍。如果不想写配置类，这三行属性也能达到同样效果（废弃提示除外）：

```yaml
spring:
  mvc:
    apiversion:
      use:
        header: API-Version
      required: false
      detect-supported: true
```

`detect-supported` 打开时，框架从 Controller 的映射里自动收集支持列表。想手工指定就写 `spring.mvc.apiversion.supported: 1.0,1.1,2.0`；想给不带版本的请求一个默认版本，用 `spring.mvc.apiversion.default: 1.0`。两种配法别同时用，挑一种，不然出问题不好定位。

### 3.7 跑起来验证

```bash
mvn spring-boot:run
```

另开一个终端，逐条试：

```bash
# 1.0：v1 结构
curl -s http://localhost:8080/api/orders/1001 -H "API-Version: 1.0"

# 1.1：多了 paidAt
curl -s http://localhost:8080/api/orders/1001 -H "API-Version: 1.1"

# 2.0：走基线版本，statusCode + changedFields
curl -s -i http://localhost:8080/api/orders/1001 -H "API-Version: 2.0"

# 不带版本：不强制，走无版本兜底方法
curl -s http://localhost:8080/api/orders/1001

# 1.7：既不是 1.0/1.1，也够不到 2.0+，返回 400
curl -s -i http://localhost:8080/api/orders/1001 -H "API-Version: 1.7"
```

第三条命令加了 `-i`，是为了看响应头。1.0 的请求你会在响应头里看到 `Deprecation` 和 `Sunset`：

```text
Deprecation: @1782777600
Sunset: @1814284800
Link: <https://api.example.com/docs/deprecation>; rel="deprecation"; type="text/html"
Link: <https://api.example.com/docs/migrate-to-v2>; rel="sunset"; type="text/html"
```

那两个 `@数字` 是 Unix 时间戳的秒数，RFC 9745 规定的写法。客户端拿到就能算出还剩多少天，不用自己去翻文档。

## 四、踩坑经验和最佳实践

结论：这套机制上线前，有五件事必须自己验一遍。

**第一件：`required` 默认为 true，这个默认值会直接打挂老客户端。** 我第一次在生产开版本管理时就栽在这。灰度发出去十分钟，监控上 400 开始涨，全是没带 `API-Version` 的老版本 App。要么 `setVersionRequired(false)`，要么留一个无版本兜底方法，上线前用真实客户端跑一遍。这个坑的代价是十分钟的全量 400，不算大，但足够吓人。

**第二件：兜底方法会被悄悄顶掉。** 无版本方法的优先级最低，一旦你给同路径加了带版本的方法，无版本那个就再也进不来了。这是设计如此，但它反直觉：你以为留着兜底很安全，实际上它只在你「一个带版本的方法都没有」时生效。加版本前先确认老客户端到底还调不调这个路径。

**第三件：基线 `+` 别乱加。** 写 `2.0+` 等于承诺「2.0 之后所有版本都由这个方法答」。如果你其实还想给 2.1 单独做点差异，这个 `+` 会挡住你的路。只有确定后面长期兼容，才用基线。

**第四件：接口版本和应用版本、框架版本是三件事。** pom 里那个版本号是框架版本，打出来的 jar 包版本号是应用版本，接口对外承诺的版本是对外契约版本。混在一起讲，开会就没人知道你在说哪个了。

**第五件：删字段只能靠新版本，别用序列化注解偷偷删。** 给字段加个「不序列化」，v1 和 v2 客户端拿到的是同一份 JSON，会一起崩。要区分，就用两套 DTO，各返回各的。

另外两条经验：

- **网关层和框架层选一层做版本路由。** Spring Cloud Gateway 能按 header 分流，框架里也能解析 header，两边都配，规则迟早对不上。我的建议是网关只做转发和限流，版本管理留在业务服务里。
- **下线流程要留时间。** 先加新版本 → 观察调用量 → 标记废弃（响应头自动提示）→ 至少留一两个发布周期的 sunset 窗口 → 确认没人调了再删方法。删之前先看监控，别看群里的消息。

## 五、版本放哪：四种解析方式对比

结论：内部接口用请求头，对外网关类接口用路径，其他两种按需用。

| 解析方式 | 请求长什么样 | 好处 | 代价 |
|---|---|---|---|
| 请求头 | `API-Version: 1.1` | URL 不变，缓存、书签、监控规则都不用动 | 浏览器地址栏试不了，日志里要额外记 header |
| 路径片段 | `GET /api/v1/orders` | 一眼看出调哪版；网关按路径分流最省事 | URL 会变，缓存、告警规则得跟着改；版本混进资源路径 |
| 查询参数 | `GET /api/orders?version=1.1` | 浏览器随手能试 | 和业务参数混在一起，容易被当成业务字段 |
| 媒体类型参数 | `Accept: application/vnd.example.v1+json` | 最贴 HTTP 语义，版本属于「表示」而不是「资源」 | 客户端改造麻烦，团队接受度低 |

我自己的取舍：前后端一体的内部服务，请求头，因为 URL 稳定对前端路由和 CDN 都友好；给第三方开放的接口，路径片段，对方看文档和排错都更直观；查询参数只在临时排查时用，别写进正式契约。

## 六、总结

版本管理说白了就三件事：**版本从请求的哪里读**（Resolver）、**怎么比大小**（Parser）、**谁该响应以及该不该拒**（Strategy）。Spring Boot 4 把这三件事做成了框架能力，你要写的只是注解和一行配置。

真正容易出事的不是技术，是流程：`required` 的默认值会打挂老客户端，兜底方法会被高版本方法顶掉，基线 `+` 会挡住后续的差异化。这三条都跟代码无关，跟「有没有在灰度前用真实客户端验一遍」有关。

最后一句：别为了省一个方法就复用 DTO，也别为了兼容把所有版本都塞进一个类。版本管理的成本是可控的，混乱的成本不可控。

文 / 会编程的吕洞宾

## 参考资料

- [Spring Framework Reference — API Versioning](https://docs.spring.io/spring-framework/reference/web/webmvc-versioning.html)
- [Spring Framework Reference — API Version（MVC Config）](https://docs.spring.io/spring-framework/reference/web/webmvc/mvc-config/api-version.html)
- [Spring Framework Reference — Mapping Requests（version 属性）](https://docs.spring.io/spring-framework/reference/web/webmvc/mvc-controller/ann-requestmapping.html)
- [ApiVersionConfigurer Javadoc](https://docs.spring.io/spring-framework/docs/current/javadoc-api/org/springframework/web/servlet/config/annotation/ApiVersionConfigurer.html)
- [StandardApiVersionDeprecationHandler Javadoc](https://docs.spring.io/spring-framework/docs/current/javadoc-api/org/springframework/web/accept/StandardApiVersionDeprecationHandler.html)
- [Spring Boot Application Properties](https://docs.spring.io/spring-boot/appendix/application-properties/index.html)
- [RFC 9745 — The Deprecation HTTP Response Header Field](https://datatracker.ietf.org/doc/html/rfc9745)
- [RFC 8594 — The Sunset HTTP Header Field](https://datatracker.ietf.org/doc/html/rfc8594)
