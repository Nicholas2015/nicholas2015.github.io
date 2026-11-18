---
title: "Spring Boot 监控实战：慢接口 3 分钟定位"
date: 2026-10-24T09:00:00+08:00
category: "Spring"
tags: ["spring-boot"]
---

线上最常见的场面：用户反馈下单卡了十几秒，你打开日志，一行异常都没有；看 CPU，30%；看内存，正常。最后只能重启，问题暂时消失，下周准时再来一次。这不是运气差，是手里只有一根探针——日志。日志能告诉你"发生了什么"，但告诉不了你"慢了多少、慢在哪个环节、有多少人受影响"。这篇文章用一个能直接跑起来的下单服务做例子，把 Micrometer 接进 Spring Boot，让"接口慢"这件事从玄学变成一张可以点开看的图。

## 一、这个问题到底是什么

接口慢却查不出来，本质是缺少带维度的耗时数据，不是日志打得不够多。

先分清三种信号，它们解决的不是同一个问题：

| 信号 | 回答的问题 | 典型载体 | 代价 |
| --- | --- | --- | --- |
| 日志（Logs） | 这一刻发生了什么 | 应用日志文件 | 磁盘、检索成本高 |
| 指标（Metrics） | 整体趋势怎样、慢到什么程度 | Prometheus 时序库 | 存储小、可聚合 |
| 链路（Traces） | 一次请求经过了哪些服务 | Jaeger/SkyWalking | 采样、开销大 |

只打日志的团队，排查慢请求时通常在做这件事：`grep` 出最近十分钟的请求日志，肉眼扫，找哪条耗时字段特别大。十条请求还行，一万条就没法看了。更麻烦的是，日志里只有单条记录，你没法回答"95% 的用户是不是都在等"。

指标解决的就是聚合问题。它把每次请求的耗时塞进一个预定义的桶里，或者记成一个分布，随时能算平均值、P95、P99，还能按接口、状态码、实例这些维度切开看。

这里有个容易被忽略的点：**平均耗时是会骗人的**。一个接口平均 50ms，听起来很健康，但如果 1% 的请求要 3 秒，那 1% 正好是每天下单最多的那批老用户。平均值把长尾抹平了，P99 才会把它揪出来。

所以真正的需求是三条：

- 每个接口的耗时分布，而不只是平均值
- 按接口、按状态码、按实例拆开看的能力
- 业务内部各步骤的耗时，能定位到"慢在扣库存还是慢在写库"

这三条，Spring Boot Actuator 加 Micrometer 全都能给，而且不用引入任何 APM。

## 二、底层原理到底怎么回事

Micrometer 是 Java 监控领域的门面（facade），你的业务代码只跟它打交道，底层存到哪里由它转交。

如果你用过 SLF4J，这套路就很熟：代码里写 `log.info`，具体输出到 Logback 还是 Log4j2，改个依赖就行。Micrometer 里的 `MeterRegistry` 就是那个 `Logger`，你只管上报，`PrometheusMeterRegistry`、`OtlpMeterRegistry` 负责翻译成各自后端的格式。换监控系统不动业务代码，这是它最大的价值。

Micrometer 只有几种基础计量器，够用一辈子：

| 计量器 | 用途 | 例子 |
| --- | --- | --- |
| Counter | 只增不减的计数 | 下单失败次数 |
| Timer | 记录一段代码的耗时和次数 | 下单接口耗时 |
| Gauge | 瞬时值，采集时现取 | 队列里待处理订单数 |
| DistributionSummary | 记录非时间类的数值分布 | 订单金额分布 |

**Tag 是维度的关键，也是事故的来源。** 一个时间序列由"指标名 + 一组 tag"唯一确定。`http_server_requests_seconds{method="POST",uri="/api/orders",status="200"}` 和 `status="500"` 是两条不同的序列。维度让数据能切片，但每多一个 tag 值，就多一份存储。这点后面踩坑一节会展开，先记住：tag 的取值必须是有限、可控的枚举。

那 `http.server.requests` 这种指标是谁打的？不是你。Spring Boot 的 Web 层在请求进来时创建了一个 Observation（观测点），请求结束时把耗时、状态码、异常记进注册表。所以只要引入 actuator，接口耗时自动就有了，一行代码不用写。这就是为什么说"先装监控再优化"，成本极低。

数据怎么到 Prometheus 那边？是拉模型。应用暴露一个 HTTP 端点 `/actuator/prometheus`，输出纯文本格式的所有指标；Prometheus 每隔 15 秒来抓一次，存进自己的时序库。所以应用不需要知道 Prometheus 在哪，也不需要推送——网络单向，配置简单，这是 Prometheus 相比推送模型的一大优势。

查询时用的是 `rate()` 和 `histogram_quantile()` 这类函数。这里有个关键区别：

- **客户端分位数**：应用自己算好 P95，暴露成 `xxx_seconds{quantile="0.95"}`。看着方便，但**不能跨实例合并**——三台机器各自的 P95 求平均，不是集群的 P95。
- **直方图（histogram）**：应用把耗时塞进一组桶（le="0.1"、le="0.3"……），暴露成 `xxx_seconds_bucket`。Prometheus 可以先把所有实例的桶加起来，再用 `histogram_quantile()` 算出真正的集群分位数。

生产环境要的是后者。所以配置里要开 `percentiles-histogram`，而不是只开 `percentiles`。

## 三、实战：手把手写代码

下面是一个完整可运行的下单服务，包含自动埋点、手动埋点、分步骤计时，以及 Prometheus 的抓取配置。

### 1. pom.xml

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
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-actuator</artifactId>
            <version>4.1.2</version>
        </dependency>
        <dependency>
            <groupId>io.micrometer</groupId>
            <artifactId>micrometer-registry-prometheus</artifactId>
            <version>1.17.2</version>
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

三个依赖的分工：`starter-web` 提供 Web 层，`starter-actuator` 提供 `/actuator/*` 端点和自动埋点，`micrometer-registry-prometheus` 负责把指标翻译成 Prometheus 的文本格式。少了最后一个，`/actuator/prometheus` 就是 404。

### 2. application.yml

```yaml
server:
  port: 8080

management:
  server:
    port: 9090
  endpoints:
    web:
      exposure:
        include: health,info,metrics,prometheus
  endpoint:
    health:
      show-details: always
  metrics:
    tags:
      application: order-service
    distribution:
      percentiles-histogram:
        http.server.requests: true
        order.create: true
        order.step: true
      slo:
        http.server.requests: 100ms,300ms,1s
```

逐条解释：

- `management.server.port: 9090` 让监控端点走另一个端口。这一步很重要，后面踩坑会讲为什么。
- `exposure.include` 只开需要的四个端点，别用 `*`。
- `percentiles-histogram` 打开后，Timer 才会输出 `_bucket` 序列，`histogram_quantile` 才有数据可用。
- `slo` 会额外生成"耗时是否小于 100ms/300ms/1s"的计数器，做 SLA 报表时直接除一下就有比例。
- `metrics.tags.application` 给所有指标打上应用名，多应用共用一个 Prometheus 时靠它区分。

### 3. 启动类

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

### 4. 请求和响应对象

```java
package com.example.order;

import java.math.BigDecimal;

public record CreateOrderRequest(String skuId, int quantity, BigDecimal amount) {
}
```

```java
package com.example.order;

import java.math.BigDecimal;

public record Order(String orderId, String skuId, int quantity, BigDecimal amount, String status) {
}
```

用 record 是因为这两个对象只承载数据，不需要 setter。Java 21 上直接用，别写一堆 getter/setter 污染代码。

### 5. 核心：OrderService

```java
package com.example.order;

import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;
import org.springframework.stereotype.Service;

import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.atomic.AtomicInteger;

@Service
public class OrderService {

    private final MeterRegistry registry;
    private final Timer createTimer;
    private final Counter createFailedCounter;
    private final Map<String, Timer> stepTimers = new ConcurrentHashMap<>();
    private final AtomicInteger pendingOrders = new AtomicInteger();

    public OrderService(MeterRegistry registry) {
        this.registry = registry;

        this.createTimer = Timer.builder("order.create")
                .description("下单整体耗时")
                .tag("biz", "order")
                .publishPercentiles(0.5, 0.95, 0.99)
                .publishPercentileHistogram()
                .register(registry);

        this.createFailedCounter = Counter.builder("order.create.failed")
                .description("下单失败次数")
                .tag("biz", "order")
                .register(registry);

        Gauge.builder("order.pending", pendingOrders, AtomicInteger::get)
                .description("当前处理中的订单数")
                .register(registry);
    }

    public Order create(CreateOrderRequest request) {
        Timer.Sample sample = Timer.sample(registry);
        pendingOrders.incrementAndGet();
        try {
            deductStock(request.skuId(), request.quantity());
            return saveOrder(request);
        } catch (RuntimeException e) {
            createFailedCounter.increment();
            throw e;
        } finally {
            pendingOrders.decrementAndGet();
            sample.stop(createTimer);
        }
    }

    private void deductStock(String skuId, int quantity) {
        step("deduct-stock", () -> sleep(ThreadLocalRandom.current().nextInt(20, 60)));
    }

    private Order saveOrder(CreateOrderRequest request) {
        Order[] holder = new Order[1];
        step("save-order", () -> {
            sleep(ThreadLocalRandom.current().nextInt(30, 90));
            holder[0] = new Order(
                    UUID.randomUUID().toString(),
                    request.skuId(),
                    request.quantity(),
                    request.amount(),
                    "CREATED");
        });
        return holder[0];
    }

    private void step(String name, Runnable action) {
        Timer timer = stepTimers.computeIfAbsent(name, key ->
                Timer.builder("order.step")
                        .description("下单各步骤耗时")
                        .tag("step", key)
                        .publishPercentileHistogram()
                        .register(registry));
        timer.record(action);
    }

    private void sleep(long millis) {
        try {
            Thread.sleep(millis);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
```

这段代码有四个设计点值得说：

**`Timer.Sample` + `finally`**：起点在进入方法时取，终点在 `finally` 里停。这样即使中间抛异常，这次耗时也会被记录。很多人只在成功路径打点，结果监控图上失败请求全都不见了，等于自己骗自己。

**业务 Counter 和业务 Timer 分开**：`order.create` 记耗时，`order.create.failed` 记失败。失败率就是一个除法，不用去日志里数。

**Gauge 传的是对象引用，不是值**：`Gauge.builder("order.pending", pendingOrders, AtomicInteger::get)` 注册的是一段"取值逻辑"，每次 Prometheus 抓取时它才去调 `get()`。如果你传一个 `pendingOrders.get()` 的数字进去，那个值永远停在注册那一刻，图就是一条直线。这是 Gauge 最常见的误用。

**按步骤计时用 `step()` 方法缓存 Timer**：`computeIfAbsent` 保证同一步骤只注册一次。每次请求都 `Timer.builder(...).register()` 虽然不会重复注册，但会产生额外的查找开销，缓存一下更干净。

### 6. Controller

```java
package com.example.order;

import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.math.BigDecimal;

@RestController
@RequestMapping("/api/orders")
public class OrderController {

    private final OrderService orderService;

    public OrderController(OrderService orderService) {
        this.orderService = orderService;
    }

    @PostMapping
    public ResponseEntity<Order> create(@RequestBody CreateOrderRequest request) {
        return ResponseEntity.status(HttpStatus.CREATED).body(orderService.create(request));
    }

    @GetMapping("/{id}")
    public ResponseEntity<Order> get(@PathVariable String id) {
        return ResponseEntity.ok(new Order(id, "SKU-1001", 1, new BigDecimal("99.00"), "CREATED"));
    }
}
```

Controller 里一行监控代码都没有，但 `http.server.requests` 已经自动记录了 method、uri、status、outcome。Spring Boot 的自动埋点就在这一层生效。

### 7. 跑起来看看

```bash
mvn spring-boot:run
```

另开一个终端压几下：

```bash
for i in $(seq 1 50); do
  curl -s -X POST http://localhost:8080/api/orders \
    -H 'Content-Type: application/json' \
    -d '{"skuId":"SKU-1001","quantity":1,"amount":99.00}' > /dev/null
done
```

然后直接看原始指标：

```bash
curl -s http://localhost:9090/actuator/prometheus | grep -E 'order_(create|step)'
```

你应该能看到 `order_create_seconds_bucket`、`order_step_seconds_bucket{step="deduct-stock",...}`、`order_create_failed_total` 这些序列。

### 8. Prometheus 抓取配置

```yaml
global:
  scrape_interval: 15s
  evaluation_interval: 15s

scrape_configs:
  - job_name: 'order-service'
    metrics_path: '/actuator/prometheus'
    static_configs:
      - targets: ['192.168.1.20:9090']
        labels:
          env: 'prod'
```

`targets` 换成你应用所在机器的 IP，端口是 `management.server.port`，不是业务端口。多实例就写多个 target，或者接服务发现。

### 9. 三条能直接用的查询

接口 P95：

```promql
histogram_quantile(0.95,
  sum by (le) (
    rate(http_server_requests_seconds_bucket{application="order-service", uri="/api/orders"}[5m])
  )
)
```

慢在哪个步骤：

```promql
histogram_quantile(0.95,
  sum by (le, step) (
    rate(order_step_seconds_bucket{application="order-service"}[5m])
  )
)
```

失败率：

```promql
sum(rate(order_create_failed_total{application="order-service"}[5m]))
/
sum(rate(http_server_requests_seconds_count{application="order-service", uri="/api/orders"}[5m]))
```

第一条查出 P95 是 800ms，第二条就能告诉你：扣库存 50ms，写库 80ms。那剩下的 670ms 不在业务代码里——去查数据库连接池等待、GC、或者下游 HTTP 调用。这就是"三分钟定位"的真实路径，不是猜。

## 四、踩坑经验和最佳实践

**把订单号当 tag，一天烧掉 8G 内存。** 有个团队为了"精确追踪每一单"，给 Timer 加了 `tag("orderId", orderId)`。上线一天，Prometheus 里多了三十多万条时间序列，内存从 2G 涨到 10G，最后 OOM 重启。原因是每个 orderId 都会生成一组独立的 `_bucket` 序列，桶越多序列越多。指标系统不是日志系统，它天生不适合存唯一值。需要追单个订单，去日志或链路里找。

**tag 的取值要能枚举。** 接口路径、状态码、渠道、机房，这些是可以的；用户 ID、订单号、时间戳、UUID，一个都不能加。判断标准很简单：这个 tag 的所有可能取值，你能在一张纸上写完吗？

**客户端分位数不能跨实例。** 三台机器各自的 P99 是 200ms、210ms、190ms，你把它平均成 200ms，这个数字在数学上没有意义。要么用 `histogram_quantile` 聚合 `_bucket`，要么接受"每台机器单独看"。配置里同时开 `publishPercentiles` 和 `publishPercentileHistogram` 的好处是：单机排障看 quantile 快，集群报表看 bucket 准。

**Actuator 千万别和业务端口混在一起暴露。** `/actuator/env`、`/actuator/heapdump` 这些端点泄露出去，等于把配置和内存快照送人。做法就是配置里的 `management.server.port`，用独立端口，安全组只放行内网 Prometheus 的 IP。别图省事把它挂到公网 Nginx 上。

**在事务边界上想清楚计时范围。** 如果你在 `@Transactional` 方法内部打点，事务提交的时间不在计时范围内；用户感知的耗时却包含提交。下单这类写操作，计时点应该包住整个事务方法调用，而不是方法体里的某几行。这不是技术问题，是"你测的到底是不是用户等的那段时间"。

**别给每个方法都加 `@Timed`。** AOP 代理有开销，指标数量也会膨胀。核心链路（下单、支付、登录）手动打点就够了，其它接口靠自动的 `http.server.requests` 兜底。

## 五、性能对比和技术选型

单次 Timer 记录的开销在百纳秒级别，相比一次数据库查询的几毫秒，可以忽略。真正的成本在存储：每个 histogram 桶都是一条序列，桶越多，Prometheus 的倒排索引和内存压力越大。所以桶的边界要按业务定，别用默认的一大把。

三种方案摆在一起看：

| 方案 | 能回答的问题 | 开销 | 运维成本 |
| --- | --- | --- | --- |
| 日志埋点 + grep | 单条请求发生了什么 | 磁盘 IO 大 | 低，但没法聚合 |
| Micrometer + Prometheus | 趋势、分位数、失败率 | 极小 | 需要维护 Prometheus/Grafana |
| APM（SkyWalking、OTel） | 跨服务调用链、慢 SQL | 中等，通常需采样 | 高 |

我的建议是按顺序来：先把 Micrometer 和 Prometheus 铺上，这是性价比最高的一层，一天就能搞定；等到微服务多到"不知道慢在哪个服务"的时候，再上链路追踪。反过来先上 APM 的团队，往往因为采样率调太低，关键时刻掉链子。

Grafana 那边不用自己画，导入社区现成的 JVM 和 Spring Boot 面板，改一下数据源就能用。要自己写的话，一个面板放三个图就够：QPS、P95 耗时、错误率。别堆几十个图，没人看。

## 六、总结

排查慢接口，靠的不是经验丰富，是数据齐不齐。

- 自动埋点解决"每个接口多慢"，装个 actuator 就有
- 手动 Timer 解决"业务里哪一步慢"，几行代码的事
- histogram 解决"多实例怎么合并算分位数"，别用客户端分位数求平均
- 独立管理端口解决"监控端点别泄露"，这是安全底线

监控这东西，装的时候嫌麻烦，出事的时候嫌少。趁系统还健康的时候铺上，比凌晨三点对着日志猜要划算得多。

文 / 会编程的吕洞宾

## 参考资料

- [Spring Boot Reference - Metrics](https://docs.spring.io/spring-boot/reference/actuator/metrics.html)
- [Micrometer Reference Documentation](https://docs.micrometer.io/micrometer/reference/)
- [Micrometer Concepts - Meters, Tags, Registries](https://docs.micrometer.io/micrometer/reference/concepts.html)
- [Prometheus Querying Functions - histogram_quantile](https://prometheus.io/docs/prometheus/latest/querying/functions/#histogram_quantile)
- [Prometheus - Histograms and summaries](https://prometheus.io/docs/practices/histograms/)
