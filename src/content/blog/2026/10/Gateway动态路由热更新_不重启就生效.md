---
title: "Gateway动态路由热更新：不重启就生效"
date: 2026-10-16T09:00:00+08:00
category: "Spring"
tags: ["spring-cloud"]
---

> 上线一个新服务，网关里加一条路由，改 yml、打包、重启——整套流程十分钟。赶上白天发版，这十分钟里所有经过网关的请求都受影响，用户看到的就是一片 5xx。上个月做灰度，我们一天改了 6 次路由，同事重启到自闭。后来我把动态路由这条路走通了：加路由、删路由都走接口，改完立刻生效，进程不动。过程里还撞上一个新版本的坑——路由明明写在 yml 里，启动不报错，访问就是 404，排查半小时才发现是配置前缀搬了家。

## 一、动态路由到底解决什么问题

结论先给：动态路由就是让网关的路由规则在运行期能被新增、删除、修改，改完立刻生效，不用重启进程。

静态路由的写法你肯定见过：yml 里写几条 routes，启动时加载进内存，之后再也不变。路由稳定的项目里这么写够用，但真跑起来会碰到三种场景：

- **新服务上线**：网关要加一条路由，只能重启。
- **某台后端要摘掉**：临时下线、扩容切流，还是只能重启。
- **灰度或多租户**：给特定客户临时开一条通道，做完再撤。重启成本比业务本身还高。

重启的代价经常被低估。网关是入口，重启期间流量要么被拒，要么被其他实例接走——实例少的时候直接被压满。发布窗口被卡死在凌晨，白天想动一下路由都不敢。

所以动态路由的目标很朴素：把路由定义从"启动时读一次的文件"变成"运行期可以写的数据"。

## 二、底层原理：路由是怎么加载的，为什么改了不一定生效

结论：一条路由要能被访问到，得同时满足三件事——定义在内存里，加载器能读到它，缓存层被通知刷新。少一件，你改了也没用。

### 2.1 一条路由在内存里长什么样

路由在内存里就是一个 RouteDefinition 对象，字段只有六个：id、uri、predicates、filters、order、metadata。yml 里那段配置，本质是它的文本形式：

```yaml
- id: order-route
  uri: http://localhost:8081
  predicates:
    - Path=/api/order/**
  filters:
    - StripPrefix=1
```

predicates 回答"什么请求进来"，filters 回答"进来之后怎么处理"，uri 回答"转发到哪去"。上面这条 Path=/api/order/** 的意思是：请求路径以 /api/order/ 开头就命中；StripPrefix=1 表示转发前砍掉第一段路径，`/api/order/1001` 到后端就变成 `/order/1001`。

### 2.2 谁负责提供路由定义

给网关提供路由定义的接口叫 RouteDefinitionLocator，只有一个方法，返回一堆 RouteDefinition。默认有这几种来源：

| 来源 | 实现类 | 能不能被程序改写 |
|---|---|---|
| yml / properties 文件 | PropertiesRouteDefinitionLocator | 不能 |
| 注册中心的服务列表 | DiscoveryClientRouteDefinitionLocator | 不能 |
| 上面几种的合并 | CompositeRouteDefinitionLocator | 不能 |
| 可写的仓库 | RouteDefinitionRepository | **能** |

关键在最后一行。RouteDefinitionRepository 同时继承了 Locator 和 RouteDefinitionWriter，后者就两个方法：save 和 delete。

**只有走这个接口改路由，才有机会生效。** 直接去改 yml 文件没用，因为 PropertiesRouteDefinitionLocator 读的是已经绑定好的 Environment 对象，文件改了没人通知它重新读。

好消息是网关默认就注册了一个可写仓库：InMemoryRouteDefinitionRepository，数据存内存里。这也是为什么你什么都不配，Actuator 的网关端点就能直接加路由。

### 2.3 存进去的定义，怎么变成能跑的 Route

RouteDefinitionRouteLocator 负责翻译。它拿着 predicates 里的 "Path=/api/order/**" 去找到对应的断言工厂，拿着 filters 里的名字去找到对应的过滤器工厂，拼成一条真正参与匹配的 Route 对象。

这一步是"定义"到"可执行"的转换，你平时不用碰它，但要知道它存在——因为翻译结果是会被缓存的。

### 2.4 缓存层：漏掉它，前面全白干

翻译好的 Route 列表被 CachingRouteLocator 缓存着，匹配请求时直接用缓存，不会每次重算。缓存什么时候失效？只有一个条件：收到 RefreshRoutesEvent 事件。

于是整条链路是：

写仓库（save / delete）→ 发 RefreshRoutesEvent → CachingRouteLocator 清缓存重载 → 新路由生效

中间那步发事件一旦漏掉，仓库里的数据是新的，网关匹配用的还是旧的。这就是很多人盯着日志想不通的原因：接口返回成功了，请求照样 404。

### 2.5 新版配置前缀搬了家

这条单独拎出来说，因为它不报错。

网关的属性绑定类 GatewayProperties，前缀是 `spring.cloud.gateway.server.webflux`。也就是说，路由必须写在这个前缀下面。你要是还按老习惯写在 `spring.cloud.gateway.routes` 下，Spring 不会报错——不认识的配置项默认被忽略——路由就是加载不出来，所有请求 404。从启动日志里看不到任何异常，只能靠把网关的日志级别调成 DEBUG，看有没有真的加载出 RouteDefinition。

同一个版本里，网关的 starter 名字也换了，叫 `spring-cloud-starter-gateway-server-webflux`。Actuator 的端点路径倒没变，还是 `/actuator/gateway/**`。

## 三、实战：两个服务，一套动态路由

先说清楚要搭什么：

- **order-service（8081）**：普通业务服务，提供一个查询订单的接口，顺便把收到的 traceId 打出来。
- **gateway-service（8080）**：网关，把 `/api/order/**` 转发给 order-service，并对外提供加路由、删路由两个接口。

项目结构：

```
gateway-demo
├── gateway-service
│   ├── pom.xml
│   └── src/main
│       ├── java/com/example/gateway
│       │   ├── GatewayApplication.java
│       │   ├── controller/DynamicRouteController.java
│       │   ├── controller/RouteRequest.java
│       │   └── filter/TraceIdGlobalFilter.java
│       └── resources/application.yml
└── order-service
    ├── pom.xml
    └── src/main
        ├── java/com/example/order
        │   ├── OrderApplication.java
        │   └── controller/OrderController.java
        └── resources/application.yml
```

### 3.1 被调用的后端服务

先写 order-service 的 pom.xml。这是个纯 MVC 服务，一个 starter 就够：

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
    <name>order-service</name>

    <properties>
        <java.version>21</java.version>
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

启动类：

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

订单接口。这里特意把 X-Trace-Id 请求头接出来打日志，后面验证网关透传有没有生效就靠它：

```java
package com.example.order.controller;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;

import java.time.LocalDateTime;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;

@RestController
public class OrderController {

    private static final Logger log = LoggerFactory.getLogger(OrderController.class);

    private final AtomicLong counter = new AtomicLong();

    @GetMapping("/order/{id}")
    public Map<String, Object> getOrder(@PathVariable("id") String id,
                                        @RequestHeader(value = "X-Trace-Id", required = false) String traceId) {
        log.info("收到订单查询请求, orderId={}, traceId={}", id, traceId);

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("orderId", id);
        result.put("traceId", traceId);
        result.put("instance", "order-service-8081");
        result.put("count", counter.incrementAndGet());
        result.put("time", LocalDateTime.now().toString());
        return result;
    }
}
```

配置文件：

```yaml
server:
  port: 8081

spring:
  application:
    name: order-service
```

### 3.2 网关的依赖

网关的 pom.xml 有两处要留意：starter 的名字，以及要引入 Spring Cloud 的 BOM。版本号我全写死在依赖上，方便你对照排查。

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
    <artifactId>gateway-service</artifactId>
    <version>1.0.0</version>
    <name>gateway-service</name>

    <properties>
        <java.version>21</java.version>
        <spring-cloud.version>2025.1.3</spring-cloud.version>
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
            <groupId>org.springframework.cloud</groupId>
            <artifactId>spring-cloud-starter-gateway-server-webflux</artifactId>
            <version>5.0.3</version>
        </dependency>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-actuator</artifactId>
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

启动类：

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

### 3.3 网关的配置：路由放在新前缀下面

注意 routes 的层级。这是全文最需要照抄的地方：

```yaml
server:
  port: 8080

spring:
  application:
    name: gateway-service
  cloud:
    gateway:
      server:
        webflux:
          routes:
            - id: order-route
              uri: http://localhost:8081
              predicates:
                - Path=/api/order/**
              filters:
                - StripPrefix=1

management:
  endpoints:
    web:
      exposure:
        include: gateway,health,info
  endpoint:
    health:
      show-details: always
```

exposure.include 那行是给 Actuator 用的。网关的 Actuator 端点默认不暴露，不写这一行，`/actuator/gateway/routes` 会直接返回 404。

### 3.4 一个全局过滤器：给每个请求发一张"身份证"

GlobalFilter 的特点是不用绑定到某条路由，所有经过网关的请求都会走。这里做两件事：请求头里没有 X-Trace-Id 就生成一个，有就沿用；再把这个值塞进响应头，方便调用方排查。

```java
package com.example.gateway.filter;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.cloud.gateway.filter.GatewayFilterChain;
import org.springframework.cloud.gateway.filter.GlobalFilter;
import org.springframework.core.Ordered;
import org.springframework.http.server.reactive.ServerHttpRequest;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ServerWebExchange;
import reactor.core.publisher.Mono;

import java.util.UUID;

@Component
public class TraceIdGlobalFilter implements GlobalFilter, Ordered {

    private static final Logger log = LoggerFactory.getLogger(TraceIdGlobalFilter.class);

    private static final String TRACE_HEADER = "X-Trace-Id";

    @Override
    public Mono<Void> filter(ServerWebExchange exchange, GatewayFilterChain chain) {
        String traceId = exchange.getRequest().getHeaders().getFirst(TRACE_HEADER);
        if (traceId == null || traceId.isBlank()) {
            traceId = UUID.randomUUID().toString().replace("-", "");
        }

        log.info("网关收到请求, path={}, traceId={}",
                exchange.getRequest().getURI().getPath(), traceId);

        ServerHttpRequest request = exchange.getRequest().mutate()
                .header(TRACE_HEADER, traceId)
                .build();

        exchange.getResponse().getHeaders().set(TRACE_HEADER, traceId);

        return chain.filter(exchange.mutate().request(request).build());
    }

    @Override
    public int getOrder() {
        return Ordered.HIGHEST_PRECEDENCE + 100;
    }
}
```

方法里全是拼装和转发，没有一行会阻塞线程——这一点很关键，后面踩坑章节会讲为什么。

### 3.5 动态加删路由的接口

先定义一个请求体，三个字段就够：

```java
package com.example.gateway.controller;

public record RouteRequest(String id, String uri, String pathPrefix) {
}
```

再写控制器。加和删都只做两件事：写仓库、发事件。

```java
package com.example.gateway.controller;

import org.springframework.cloud.gateway.event.RefreshRoutesEvent;
import org.springframework.cloud.gateway.filter.FilterDefinition;
import org.springframework.cloud.gateway.handler.predicate.PredicateDefinition;
import org.springframework.cloud.gateway.route.RouteDefinition;
import org.springframework.cloud.gateway.route.RouteDefinitionWriter;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import reactor.core.publisher.Mono;

import java.net.URI;
import java.util.List;

@RestController
@RequestMapping("/admin/routes")
public class DynamicRouteController {

    private final RouteDefinitionWriter routeDefinitionWriter;

    private final ApplicationEventPublisher eventPublisher;

    public DynamicRouteController(RouteDefinitionWriter routeDefinitionWriter,
                                  ApplicationEventPublisher eventPublisher) {
        this.routeDefinitionWriter = routeDefinitionWriter;
        this.eventPublisher = eventPublisher;
    }

    @PostMapping
    public Mono<String> addRoute(@RequestBody RouteRequest request) {
        RouteDefinition definition = new RouteDefinition();
        definition.setId(request.id());
        definition.setUri(URI.create(request.uri()));
        definition.setOrder(0);
        definition.setPredicates(List.of(new PredicateDefinition("Path=" + request.pathPrefix())));
        definition.setFilters(List.of(new FilterDefinition("StripPrefix=1")));

        return routeDefinitionWriter.save(Mono.just(definition))
                .doOnSuccess(unused -> eventPublisher.publishEvent(new RefreshRoutesEvent(this)))
                .thenReturn("路由 " + request.id() + " 已添加并生效");
    }

    @DeleteMapping("/{id}")
    public Mono<String> deleteRoute(@PathVariable("id") String id) {
        return routeDefinitionWriter.delete(Mono.just(id))
                .doOnSuccess(unused -> eventPublisher.publishEvent(new RefreshRoutesEvent(this)))
                .thenReturn("路由 " + id + " 已删除并生效");
    }
}
```

三个地方值得单独讲：

- RouteDefinitionWriter 是框架启动时就注册好的 Bean，直接构造器注入，不用自己 new。
- PredicateDefinition 和 FilterDefinition 都支持"名字=参数"的字符串写法，多个参数用逗号隔开，跟 yml 里的写法一一对应。
- 事件必须发。doOnSuccess 里发事件是等仓库写完才发，顺序不会错。

### 3.6 跑起来验证

两个服务都启动（order-service 先起，它监听 8081）。然后依次敲这几条：

```bash
# 1. 静态路由，走 yml 里配的 order-route
curl -i http://localhost:8080/api/order/1001

# 2. 看网关当前有哪些路由
curl http://localhost:8080/actuator/gateway/routes

# 3. 动态加一条路由：/api/dyn/order/** 砍掉两段路径后转给 order-service
curl -X POST http://localhost:8080/admin/routes \
  -H 'Content-Type: application/json' \
  -d '{"id":"order-dynamic","uri":"http://localhost:8081","pathPrefix":"/api/dyn/order/**"}'

# 4. 不改配置、不重启，直接访问新路由
curl -i http://localhost:8080/api/dyn/order/2001

# 5. 删掉它，再请求一次应该是 404
curl -X DELETE http://localhost:8080/admin/routes/order-dynamic
curl -i http://localhost:8080/api/dyn/order/2002
```

第 4 步能拿到 200，说明路由是热生效的；返回体里的 traceId 有值，说明全局过滤器也生效了。第 5 步删完再请求变 404，说明删除同样是热的。

不想在项目里写接口、只想临时排障的话，Actuator 端点也能做同样的事：

```bash
curl -X POST http://localhost:8080/actuator/gateway/routes/order-actuator \
  -H 'Content-Type: application/json' \
  -d '{
        "id": "order-actuator",
        "uri": "http://localhost:8081",
        "predicates": [{"name": "Path", "args": {"_genkey_0": "/api/act/order/**"}}],
        "filters": [{"name": "StripPrefix", "args": {"_genkey_0": "2"}}],
        "order": 0
      }'

curl -X POST http://localhost:8080/actuator/gateway/refresh
```

JSON 里的 args 用的是位置键名 `_genkey_0`、`_genkey_1`，这是端点约定的写法，跟 yml 里按顺序写参数是一个意思。保存完再调一次 refresh，是为了确保缓存重载——这一步别省。

## 四、踩坑经验和最佳实践

**坑 1：路由写在 yml 里完全不生效，启动也不报错。**
新版网关的配置前缀变成了 `spring.cloud.gateway.server.webflux`。你要是还写在 `spring.cloud.gateway.routes` 下面，Spring 只会默默忽略这个不认识的配置项，路由一条都加载不出来，所有请求 404。排查办法很土但有效：把 org.springframework.cloud.gateway 的日志级别调成 DEBUG，看启动时到底加载了几条 RouteDefinition。日志里是 0 条，就往前缀上找。

**坑 2：写进了仓库，忘了发事件。**
我见过同事自己写了个接口去调 routeDefinitionWriter.save，测了半天说"没反应"。原因就是漏了 RefreshRoutesEvent。我的做法是把 save 和发事件写进同一个方法里，不给任何人漏掉的机会。

**坑 3：Actuator 的网关端点在公网裸奔。**
management 的端点写成 include 全开，再叠上 `/actuator/gateway/**` 可写，等于把路由的增删改权限交给了所有人。有人就能把流量代理到自己的服务器上，用户数据顺手就被捞走。生产环境要么不暴露这个端点，要么走独立端口并挂上鉴权。自己写的 /admin/routes 接口同理，上线前必须加鉴权和 IP 白名单。

**坑 4：动态路由只活在内存里。**
InMemoryRouteDefinitionRepository 名字就说明了问题：进程一重启，动态加的路由全丢。多实例更麻烦——你给 A 实例加了路由，B 实例不知道，用户请求被负载均衡打到 B 就是 404。要解决就得上共享存储：框架自带 RedisRouteDefinitionRepository，把路由落到 Redis 里，多个网关实例共读一份。选它还是选配置中心统一下发，看你们现有的设施，别为了一个动态路由专门引一套新中间件。

**坑 5：在网关过滤器里写阻塞代码。**
见过最惨的一次，同事在 GlobalFilter 里用同步 JDBC 查数据库做权限校验，压测到 QPS 50 就开始大面积超时。网关的请求处理跑在 Netty 的事件循环线程上，阻塞一次，排在这个线程后面的请求全部停住。过滤器里只能写异步逻辑，要查数据就用 R2DBC，或者把数据预加载到本地缓存里。这一条我认为是网关开发里最要命的坑。

**坑 6：兜底路由和具体路由抢顺序。**
匹配是从上往下找第一个命中的断言，order 越小越先匹配。如果你配了一条 Path=/** 的兜底路由，order 又是 0，动态加进来的具体路由也是 0，谁先谁后就不确定了，表现出来就是"偶尔 404"。给兜底路由一个很大的 order（比如 1000），具体路由保持 0，能省掉很多玄学问题。

**最佳实践**：路由 id 用 `服务名-环境-序号` 的格式，别用中文和时间戳；新的 uri 做白名单校验，只允许转发到你们自己的服务，防止被当成跳板；路由变更打审计日志，谁改的、改成什么、什么时候改的，出问题能倒查。

## 五、动态路由的几种实现方案怎么选

| 方案 | 生效方式 | 多实例一致性 | 适合的场景 |
|---|---|---|---|
| yml 静态路由 | 重启进程 | 天然一致 | 路由半年不动一次 |
| Actuator 网关端点 | 立即 | 需自己同步各实例 | 临时排障、线上验证 |
| 自写 admin 接口 + 内存仓库 | 立即 | 需自己同步各实例 | 团队小、网关实例少 |
| 落 Redis/DB 的 RouteDefinitionRepository | 立即 | 天然共享 | 网关多实例 |
| 配置中心统一下发 | 秒级 | 天然一致 | 已有配置中心的团队 |

我的取舍很直接：网关只有一两个实例，自写接口加内存仓库就够了，成本最低；实例一多，共享存储是硬要求，否则你永远在跟"某台机器上是旧的"较劲；团队本来就在用配置中心管配置，那直接把 routes 交给它，别自己再造一套路由管理接口。

## 六、总结

路由能不能热更新，就记两句话：定义通过 RouteDefinitionRepository 写进去，写完必须发 RefreshRoutesEvent。其余所有细节，都是围绕这两步展开的。

再补三条容易翻车的：配置文件里 routes 的位置换了新前缀，写错不报错只会 404；动态路由默认存内存，重启和多实例都会让你怀疑人生；过滤器里不能有阻塞代码，WebFlux 的线程比你想的娇贵得多。

动态路由也不是银弹。它把"路由"从配置文件里的死数据，变成了一个需要在运行期维护的状态——要有鉴权、要有审计、要考虑持久化。如果你们的路由一年改不了一次，那就老老实实写 yml，别给自己找活干。

文 / 会编程的吕洞宾

## 参考资料

- [Spring Cloud Gateway Reference Documentation](https://docs.spring.io/spring-cloud-gateway/reference/)
- [Spring Boot Actuator Endpoints](https://docs.spring.io/spring-boot/reference/actuator/endpoints.html)
- [spring-cloud-gateway-server-webflux on Maven Central](https://repo1.maven.org/maven2/org/springframework/cloud/spring-cloud-gateway-server-webflux/)
- [spring-cloud-dependencies on Maven Central](https://repo1.maven.org/maven2/org/springframework/cloud/spring-cloud-dependencies/)
- [spring-boot-starter-parent on Maven Central](https://repo1.maven.org/maven2/org/springframework/boot/spring-boot-starter-parent/)
