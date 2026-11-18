---
title: "RabbitMQ 延迟队列实战：订单超时自动关闭"
date: 2026-10-14T09:00:00+08:00
category: "中间件"
tags: ["rabbitmq"]
---

> 电商订单下单后 30 分钟不付款，就得自动关闭。用定时任务扫全表，实时性差、还压数据库；用 Redis 的键过期通知，丢事件是常事。稳一点的做法，是让 RabbitMQ 帮你「定时」：消息先压进一个带 TTL 的队列里躺着，时间一到自动变成死信，被转发到真正干活的队列，消费者这时才动手关单。全程没有一个定时任务。这篇把 TTL 加死信队列的方案讲透，代码完整可跑，还会点出最容易踩的那个坑：队列级 TTL 的队头阻塞。

## 一、延迟队列是什么，订单超时为什么非它不可

结论先行：延迟队列就是让消息先在队列里「等一会儿」，到点再交给消费者的机制；RabbitMQ 本身不提供这个类型，得靠 TTL 加死信队列拼出来。

先说人话。普通队列的脾气是「插队即走」：生产者一投，消费者马上就能拿到。延迟队列不一样，它要求消息先老老实实待够指定时长，然后才轮得到消费者处理。

最典型的场景就是订单超时关闭。用户下单，订单状态是「待支付」。如果 30 分钟内没付款，系统要把它改成「已关闭」，并把占用的库存放回去。这个「30 分钟」就是延迟队列的用武之地：下单成功的那一刻，往延迟队列塞一条消息，30 分钟后它自己会冒出来，消费者收到就动手关单。

同类需求还有一批：优惠券到期提醒、未评价自动好评、失败任务 5 分钟后重试、会员到期降级。它们的共同点是——都只关心「到点做一件事」，不关心中间这段时间谁盯着。

那不用延迟队列行不行？行，但各有各的难受：

- **定时任务扫数据库**：每分钟跑一次 `select * from order_info where status = 'WAIT_PAY' and create_time < now() - interval 30 minute`。简单，但库压力大，时间精度也就到分钟级，数据量一上来扫描直接拖慢主库。
- **Redis 键过期监听**：给订单键设 30 分钟过期，监听 `__keyevent@0__:expired`。坑在于这个通知是「事后尽力而为」，Redis 不保证一定送到；主从切换、集群分片下还容易漏。拿它做资金相关的关单，我不敢。
- **RocketMQ 延时消息**：原生支持，一个 API 搞定，但 4.x 只认固定的十几个延时档位，想要「29 分 23 秒」这种精度做不到。
- **RabbitMQ TTL 加死信队列**：本文方案。时延精度到秒，可靠性靠消息持久化加手动 ack 兜底，代价是要自己声明队列和路由。

把这四种摆成一张表，方便按场景挑：

| 方案 | 时延精度 | 可靠性 | 运维复杂度 | 适合场景 |
| --- | --- | --- | --- | --- |
| 定时任务扫库 | 分钟级 | 高 | 低 | 数据量小、精度要求宽松 |
| Redis 键过期监听 | 秒级 | 低 | 中 | 丢一条无所谓的提醒类任务 |
| RocketMQ 延时消息 | 档位固定 | 高 | 低 | 已用 RocketMQ、档位够用 |
| RabbitMQ TTL 加死信 | 秒级 | 高 | 中 | 订单关单这类不能丢、精度要够的 |

订单超时关闭既不能丢，又希望尽量准，所以我选最后一种。下面拆开看它怎么转起来的。

## 二、底层原理：TTL 和死信队列怎么咬合

结论先行：TTL 决定消息在队列里能活多久，死信机制决定消息「死」了之后去哪；两者一对接，就是一个不需要定时器的延迟器。

先解释 TTL。TTL 是 Time To Live 的缩写，直译「存活时间」，说白了就是给消息贴一个保质期标签，过期即作废。RabbitMQ 支持两种贴法：

- **队列级**：建队列时给参数 `x-message-ttl`，单位毫秒，这个队列里所有消息都按这个时间过期。
- **消息级**：发送时给单条消息设 `expiration`，每条消息可以不一样。

再解释死信。死信（Dead Letter）不是某种特殊消息，而是「正常队列里待不下去、被踢出来的消息」的统称。RabbitMQ 规定，一条消息满足下面三个条件之一，就算死信：

1. 消费者明确拒绝（`basic.reject` 或 `basic.nack`）并且要求不重新入队（`requeue=false`）；
2. 消息在队列里活过了 TTL；
3. 队列达到长度上限（`x-max-length`），新消息把旧消息挤出队。

死信从哪来、到哪去，靠建队列时的两个参数指定：

- `x-dead-letter-exchange`：死信转发到哪个交换机；
- `x-dead-letter-routing-key`：转发时用什么路由键（不写就沿用原路由键）。

把这两块拼起来，延迟功能就出来了。延迟队列自己不设消费者，专门用来「养」消息；消息一过期，TTL 判定成立，立刻按死信规则被转发到业务交换机，再落到真正干活的队列，消费者在那儿等着。

完整流转是这样的：

1. 用户下单成功，生产者把消息发到业务交换机 `order.exchange`，路由键 `order.delay.30m`；
2. 消息落到延迟队列 `order.delay.30m.queue`，这个队列的 `x-message-ttl` 是 1800000 毫秒，也就是 30 分钟；
3. 消息在队列里躺够 30 分钟。延迟队列故意不挂消费者，没人会提前把它取走；
4. 到期后 RabbitMQ 判定它是死信，按 `x-dead-letter-exchange=order.exchange`、`x-dead-letter-routing-key=order.timeout` 转发；
5. 消息落到超时队列 `order.timeout.queue`；
6. 消费者监听这个队列，收到消息就去执行关单。

有个细节值得说清楚：延迟队列不挂消费者，消息会不会一直烂在里面？不会。队列级 TTL 的过期判定不需要消费者参与，消息一旦排到队头且已过期，就会被判成死信转发出去。这也是能拿它做延迟队列的前提。

然后就是那个最坑的地方——队头阻塞。

RabbitMQ 检查消息是否过期，只看队头，而且队列是严格先进先出。假设你把不同 TTL 的消息塞进同一个队列：先投一条 30 分钟过期的，紧接着投一条 1 分钟过期的。那条 1 分钟的消息虽然到了点，但它排在 30 分钟那条后面，队头没动，它就永远轮不到被判定过期。结果是它实际等了 30 分钟才被转发出去。

这个坑阴险的地方在于：测试时如果消息 TTL 都一样，根本发现不了；一旦业务里混进了不同档位，延迟就集体失真。

解法有两条：

- **一个档位一个队列**：把 5 分钟、30 分钟、2 小时拆成三个队列，每个队列的 `x-message-ttl` 固定，消息各回各家，互不阻塞。本文代码走这条。
- **上官方延时插件**：安装 `rabbitmq_delayed_message_exchange`，定义一个 `x-delayed-message` 类型的交换机，发消息时给每条指定延迟毫秒数，精度和灵活性更好。代价是插件要单独装、还得团队接受多维护一个组件。

原理讲完，下面动手写代码。

## 三、实战：手把手写一个订单超时关闭

项目用 Spring Boot 加 Spring AMQP，数据库用内存版 H2，复制下来直接能跑。本机需要有个 RabbitMQ，默认端口 5672。

### 3.1 项目结构和 pom.xml

先看整体结构：

```text
delay-order-demo
├── pom.xml
└── src
    ├── main
    │   ├── java/com/example/delayorder
    │   │   ├── DelayOrderApplication.java
    │   │   ├── config
    │   │   │   ├── OrderDelayProperties.java
    │   │   │   └── RabbitDelayConfig.java
    │   │   ├── consumer/OrderTimeoutConsumer.java
    │   │   ├── controller/OrderController.java
    │   │   └── service/OrderService.java
    │   └── resources
    │       ├── application.yml
    │       └── schema.sql
```

pom.xml 里所有依赖版本都写全，照着抄就能编译：

```xml
<?xml version="1.0» encoding="UTF-8»?>
<project xmlns="http://maven.apache.org/POM/4.0.0»
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance»
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd»>
    <modelVersion>4.0.0</modelVersion>

    <parent>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-parent</artifactId>
        <version>4.1.1</version>
        <relativePath/>
    </parent>

    <groupId>com.example</groupId>
    <artifactId>delay-order-demo</artifactId>
    <version>1.0.0</version>
    <name>delay-order-demo</name>
    <description>RabbitMQ 延迟队列实现订单超时关闭</description>

    <properties>
        <java.version>21</java.version>
    </properties>

    <dependencies>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-web</artifactId>
            <version>4.1.1</version>
        </dependency>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-amqp</artifactId>
            <version>4.1.1</version>
        </dependency>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-jdbc</artifactId>
            <version>4.1.1</version>
        </dependency>
        <dependency>
            <groupId>com.h2database</groupId>
            <artifactId>h2</artifactId>
            <version>2.5.252</version>
            <scope>runtime</scope>
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

application.yml 把三个延迟档位做成配置，改时长不用动代码：

```yaml
server:
  port: 8080

spring:
  application:
    name: delay-order-demo
  datasource:
    url: jdbc:h2:mem:orderdb;DB_CLOSE_DELAY=-1;MODE=MySQL
    driver-class-name: org.h2.Driver
    username: sa
    password: "»
  sql:
    init:
      mode: always
  rabbitmq:
    host: 127.0.0.1
    port: 5672
    username: guest
    password: guest
    virtual-host: /
    publisher-confirm-type: correlated
    publisher-returns: true
    template:
      mandatory: true
    listener:
      simple:
        acknowledge-mode: manual
        prefetch: 20
        concurrency: 2

order:
  delay:
    tiers:
      - name: order.delay.5m.queue
        routing-key: order.delay.5m
        ttl: 300000
      - name: order.delay.30m.queue
        routing-key: order.delay.30m
        ttl: 1800000
      - name: order.delay.2h.queue
        routing-key: order.delay.2h
        ttl: 7200000
```

本地想快点看到效果，把 `ttl: 1800000` 临时改成 `10000`（10 秒）即可，其余不用动。

schema.sql 建一张订单表，Spring Boot 启动时自动执行：

```sql
create table if not exists order_info
(
    id          bigint auto_increment primary key,
    order_no    varchar(64) not null,
    product_id  varchar(64) not null,
    amount      int         not null,
    status      varchar(16) not null,
    create_time timestamp   not null
);
```

### 3.2 声明交换机和队列（多档位）

这一段是核心。三个关键点记牢：延迟队列不挂消费者、每个延迟档位单独一个队列、死信的出口指向业务交换机加超时路由键。

先把配置项接进 Java：

```java
package com.example.delayorder.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

import java.util.ArrayList;
import java.util.List;

@ConfigurationProperties(prefix = "order.delay»)
public class OrderDelayProperties {

    private List<Tier> tiers = new ArrayList<>();

    public List<Tier> getTiers() {
        return tiers;
    }

    public void setTiers(List<Tier> tiers) {
        this.tiers = tiers;
    }

    public static class Tier {
        private String name;
        private String routingKey;
        private int ttl;

        public String getName() {
            return name;
        }

        public void setName(String name) {
            this.name = name;
        }

        public String getRoutingKey() {
            return routingKey;
        }

        public void setRoutingKey(String routingKey) {
            this.routingKey = routingKey;
        }

        public int getTtl() {
            return ttl;
        }

        public void setTtl(int ttl) {
            this.ttl = ttl;
        }
    }
}
```

然后是队列声明。每拆一个 `Tier`，就建一个独立延迟队列，`.ttl()` 设队列级保质期，`.deadLetterExchange()` 和 `.deadLetterRoutingKey()` 规定消息过期后去哪：

```java
package com.example.delayorder.config;

import org.springframework.amqp.core.Binding;
import org.springframework.amqp.core.BindingBuilder;
import org.springframework.amqp.core.Declarable;
import org.springframework.amqp.core.Declarables;
import org.springframework.amqp.core.DirectExchange;
import org.springframework.amqp.core.ExchangeBuilder;
import org.springframework.amqp.core.Queue;
import org.springframework.amqp.core.QueueBuilder;
import org.springframework.amqp.support.converter.Jackson2JsonMessageConverter;
import org.springframework.amqp.support.converter.MessageConverter;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import java.util.ArrayList;
import java.util.List;

@Configuration
@EnableConfigurationProperties(OrderDelayProperties.class)
public class RabbitDelayConfig {

    /** 业务交换机：延迟消息和到点后的超时消息共用它做路由 */
    public static final String ORDER_EXCHANGE = "order.exchange»;

    /** 真正干活的队列：消息在这里被消费 */
    public static final String ORDER_TIMEOUT_QUEUE = "order.timeout.queue»;

    /** 死信转发的路由键 */
    public static final String ORDER_TIMEOUT_ROUTING_KEY = "order.timeout»;

    private final OrderDelayProperties properties;

    public RabbitDelayConfig(OrderDelayProperties properties) {
        this.properties = properties;
    }

    @Bean
    public DirectExchange orderExchange() {
        return ExchangeBuilder.directExchange(ORDER_EXCHANGE)
                .durable(true)
                .build();
    }

    @Bean
    public Queue orderTimeoutQueue() {
        return QueueBuilder.durable(ORDER_TIMEOUT_QUEUE).build();
    }

    @Bean
    public Binding orderTimeoutBinding() {
        return BindingBuilder.bind(orderTimeoutQueue())
                .to(orderExchange())
                .with(ORDER_TIMEOUT_ROUTING_KEY);
    }

    /**
     * 每个延迟档位声明一个独立队列。
     * 队列级 TTL 固定，消息过期后按死信参数转回业务交换机，再路由到超时队列。
     */
    @Bean
    public Declarables orderDelayQueues() {
        List<Declarable> declarables = new ArrayList<>();
        for (OrderDelayProperties.Tier tier : properties.getTiers()) {
            Queue delayQueue = QueueBuilder.durable(tier.getName())
                    .ttl(tier.getTtl())
                    .deadLetterExchange(ORDER_EXCHANGE)
                    .deadLetterRoutingKey(ORDER_TIMEOUT_ROUTING_KEY)
                    .build();
            declarables.add(delayQueue);
            declarables.add(BindingBuilder.bind(delayQueue)
                    .to(orderExchange())
                    .with(tier.getRoutingKey()));
        }
        return new Declarables(declarables);
    }

    @Bean
    public MessageConverter jsonMessageConverter() {
        return new Jackson2JsonMessageConverter();
    }
}
```

最后那个 `MessageConverter` 别漏。默认转换器走 Java 序列化，跨语言、跨版本都别扭；换成 Jackson 后消息体是 JSON，抓包、排查、跟其他语言对接都省心。

### 3.3 下单服务：存库加投递延迟消息

`createOrder` 干两件事：把订单写进库，再往 `order.exchange` 发一条 30 分钟延迟消息。注意顺序——先落库拿到主键，再发消息；反过来发完消息落库失败，30 分钟后会去关一个不存在的订单。

```java
package com.example.delayorder.service;

import com.example.delayorder.config.RabbitDelayConfig;
import org.springframework.amqp.rabbit.core.RabbitTemplate;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.support.GeneratedKeyHolder;
import org.springframework.jdbc.support.KeyHolder;
import org.springframework.stereotype.Service;

import java.sql.PreparedStatement;
import java.sql.Statement;
import java.sql.Timestamp;
import java.time.LocalDateTime;
import java.util.HashMap;
import java.util.Map;

@Service
public class OrderService {

    private final JdbcTemplate jdbcTemplate;
    private final RabbitTemplate rabbitTemplate;

    public OrderService(JdbcTemplate jdbcTemplate, RabbitTemplate rabbitTemplate) {
        this.jdbcTemplate = jdbcTemplate;
        this.rabbitTemplate = rabbitTemplate;
    }

    /**
     * 创建订单，同时投递一条 30 分钟后到期的延迟消息。
     */
    public Long createOrder(String productId, int amount) {
        String orderNo = "OD» + System.currentTimeMillis();
        KeyHolder keyHolder = new GeneratedKeyHolder();

        jdbcTemplate.update(connection -> {
            PreparedStatement ps = connection.prepareStatement(
                    "insert into order_info(order_no, product_id, amount, status, create_time) values (?, ?, ?, ?, ?)»,
                    Statement.RETURN_GENERATED_KEYS);
            ps.setString(1, orderNo);
            ps.setString(2, productId);
            ps.setInt(3, amount);
            ps.setString(4, "WAIT_PAY»);
            ps.setTimestamp(5, Timestamp.valueOf(LocalDateTime.now()));
            return ps;
        }, keyHolder);

        Long orderId = keyHolder.getKey().longValue();

        Map<String, Object> payload = new HashMap<>();
        payload.put("orderId», orderId);
        payload.put("orderNo», orderNo);

        rabbitTemplate.convertAndSend(
                RabbitDelayConfig.ORDER_EXCHANGE,
                "order.delay.30m»,
                payload);

        return orderId;
    }

    /**
     * 幂等关单：只有状态还是 WAIT_PAY 时才更新。
     * 返回 true 表示这次真的关掉了，false 表示订单已支付或已关闭。
     */
    public boolean closeIfUnpaid(Long orderId) {
        int rows = jdbcTemplate.update(
                "update order_info set status = 'CLOSED' where id = ? and status = 'WAIT_PAY'»,
                orderId);
        return rows > 0;
    }
}
```

### 3.4 消费者：到点关单

消费者监听超时队列，收到消息就调 `closeIfUnpaid`，处理完手动 ack。用 `prefetch` 限制预取条数，避免一次拉一堆消息堵在内存里。

```java
package com.example.delayorder.consumer;

import com.example.delayorder.config.RabbitDelayConfig;
import com.example.delayorder.service.OrderService;
import com.rabbitmq.client.Channel;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.amqp.rabbit.annotation.RabbitListener;
import org.springframework.amqp.support.AmqpHeaders;
import org.springframework.messaging.handler.annotation.Header;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.util.Map;

@Component
public class OrderTimeoutConsumer {

    private static final Logger log = LoggerFactory.getLogger(OrderTimeoutConsumer.class);

    private final OrderService orderService;

    public OrderTimeoutConsumer(OrderService orderService) {
        this.orderService = orderService;
    }

    @RabbitListener(queues = RabbitDelayConfig.ORDER_TIMEOUT_QUEUE)
    public void onTimeoutMessage(Map<String, Object> payload,
                                 Channel channel,
                                 @Header(AmqpHeaders.DELIVERY_TAG) long deliveryTag) throws IOException {
        Long orderId = ((Number) payload.get("orderId»)).longValue();
        try {
            boolean closed = orderService.closeIfUnpaid(orderId);
            if (closed) {
                log.info("订单 {} 超时未支付，已自动关闭», orderId);
            } else {
                log.info("订单 {} 已支付或已关闭，本次跳过», orderId);
            }
            channel.basicAck(deliveryTag, false);
        } catch (Exception e) {
            log.error("处理订单 {} 超时消息失败», orderId, e);
            // 不重回原队列，交给人工或死信处理，避免无限重投
            channel.basicNack(deliveryTag, false, false);
        }
    }
}
```

### 3.5 启动类和测试接口

```java
package com.example.delayorder;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class DelayOrderApplication {

    public static void main(String[] args) {
        SpringApplication.run(DelayOrderApplication.class, args);
    }
}
```

```java
package com.example.delayorder.controller;

import com.example.delayorder.service.OrderService;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.LinkedHashMap;
import java.util.Map;

@RestController
@RequestMapping("/orders»)
public class OrderController {

    private final OrderService orderService;

    public OrderController(OrderService orderService) {
        this.orderService = orderService;
    }

    @PostMapping
    public Map<String, Object> create(@RequestParam String productId,
                                      @RequestParam(defaultValue = "1») int amount) {
        Long orderId = orderService.createOrder(productId, amount);
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("orderId», orderId);
        result.put("status», "WAIT_PAY»);
        result.put("tip», "30 分钟内未支付将自动关闭»);
        return result;
    }
}
```

跑起来验证一下：先起 RabbitMQ，再启动应用，然后敲一条 curl 下单：

```bash
curl -X POST "http://localhost:8080/orders?productId=P1001&amount=2»
```

返回 `orderId` 后等延迟时长（本地改成 10 秒的话就是 10 秒），日志里会打出「订单 xx 超时未支付，已自动关闭」，订单状态从 `WAIT_PAY` 变成 `CLOSED`。整个链路就通了。

## 四、踩坑经验和最佳实践

下面这些坑，大部分我都真金白银撞过。

**1. 队头阻塞，差点让一次大促的关单集体延后。** 早前图省事，把 15 分钟和 30 分钟两档订单塞进同一个延迟队列，测试时消息 TTL 都一样，风平浪静。上线后发现 15 分钟那档的关单要等 30 分钟才执行，库存释放晚了，客服被投诉。根因就是前面讲的队头阻塞。改成每档一个队列后恢复正常。**结论：一个 TTL 一个队列，别贪省事。**

**2. 延迟队列千万别挂消费者。** 有人顺手给所有队列配了监听，结果消息刚进延迟队列就被消费者取走，延迟直接归零。延迟队列是「仓库」，不是「车间」，不挂监听。

**3. 发送端要开 confirm 和 return。** yml 里那三行（`publisher-confirm-type`、`publisher-returns`、`template.mandatory`）就是干这个的。不开的话，消息路由不到任何队列时，broker 会默默丢弃，你这边一片安静，等发现时订单早就没关。再配合 `RabbitTemplate` 的 `ConfirmCallback` 和 `ReturnsCallback` 记日志、落补偿表，才算闭环。

**4. 关单必须幂等。** 用户可能在第 29 分 59 秒付款，延迟消息几乎同时到达。如果关单是「先查状态再更新」，中间有窗口会造成重复处理。用条件更新 `where id = ? and status = 'WAIT_PAY'`，靠数据库的行锁保证只有一个动作生效，影响行数为 0 就直接跳过。

**5. nack 别用 requeue=true。** 处理失败时 `basicNack(tag, false, true)` 会让消息立刻重回队头，瞬间又投给你，形成打转，CPU 白烧、日志刷屏。要么 `requeue=false` 让它进死信或留在队列，要么自己维护重试次数字段，超过阈值就丢弃并告警。

**6. durable 要一致。** 交换机、队列都得 `durable(true)`，消息也要持久化（Spring AMQP 默认就是）。任何一环不持久化，broker 一重启，堆积的延迟消息全没了，所有待关闭订单原地失联。

**7. 盯住延迟队列的堆积量。** 延迟队列里的消息数约等于「未来一个延迟窗口内的订单量」。给队列设个 `x-max-length` 上限兜底（溢出消息会按规则变成死信，也就是前面说的第三个死信条件），至少别让它悄无声息地把 broker 内存吃爆。

## 五、性能对比和技术选型

结论先行：中小规模、要求秒级精度、消息不能丢的场景，RabbitMQ 的 TTL 加死信队列是性价比最高的选择；要任意精度且不介意装插件，选延时插件；量级特别大、已有 RocketMQ 基建的，用 RocketMQ 延时消息更省事。

几种方案的本质差别在这几处：

| 维度 | TTL 加死信（多队列） | 延时插件 | RocketMQ 延时消息 |
| --- | --- | --- | --- |
| 延迟精度 | 档位固定，秒级 | 每条消息任意毫秒 | 4.x 固定档位，5.x 支持自定义 |
| 可靠性 | 高（持久化加手动 ack） | 高 | 高 |
| 运维成本 | 低，原生能力 | 中，需装并维护插件 | 低，但要有 RocketMQ |
| 队列/资源占用 | 档位越多队列越多 | 一个交换机搞定 | 由 broker 统一管理 |
| 适合规模 | 百万级每天以内 | 千万级以内 | 海量 |

TTL 方案有个天然权衡：延迟队列不消费，消息要在 broker 里实打实待够整个延迟窗口。30 分钟的窗口、每分钟一千单，峰值堆积就是三万条消息常驻。这个量对 RabbitMQ 来说不算大，但延迟窗口拉到几天、量级上千万，就得掂量磁盘和内存了。档位数量也是成本，五个档位就是五个队列，别设计成几十个。

我的选型口径很直白：档位不超过十个、日订单量百万级以内、要求不丢——直接上 TTL 加死信，别引入新组件。超过这个量级，或者业务天天想改延迟时长、要精确到秒级任意值，那就老老实实评估延时插件或 RocketMQ，别硬扛。

## 六、总结

RabbitMQ 没有现成的延迟队列，但 TTL 加死信队列这套组合拳能把它拼出来：延迟队列用队列级 TTL 定保质期、不挂消费者；消息过期后按死信参数转回业务交换机，落到真正干活的队列；消费者在那里执行关单。

整套代码的骨架就四块：声明队列（一档一队列，死信出口指向业务交换机）、下单发消息（先落库再发）、消费关单（条件更新保幂等）、手动 ack 兜可靠性。照着文里的完整代码搭一遍，半小时能跑通。

最该记住的一句话：**队列级 TTL 只认队头，不同延迟档位必须分队列。** 这条记住，你就绕开了这个方案里最大的那个坑。

至于要不要上延时插件、要不要换 RocketMQ，先看你的档位数量和消息量级，别为了「技术先进」给自己加运维担子。能用一个组件解决的事，别用两个。

## 参考资料

- [RabbitMQ: Time-To-Live and Expiration](https://www.rabbitmq.com/docs/ttl)
- [RabbitMQ: Dead Letter Exchanges](https://www.rabbitmq.com/docs/dlx)
- [rabbitmq-delayed-message-exchange](https://github.com/rabbitmq/rabbitmq-delayed-message-exchange)
- [Spring AMQP Reference Documentation](https://docs.spring.io/spring-amqp/reference/)

文 / 会编程的吕洞宾
