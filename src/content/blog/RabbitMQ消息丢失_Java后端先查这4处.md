---
title: "RabbitMQ 消息丢失，Java 后端先查这 4 处"
date: 2026-10-27T09:00:00+08:00
category: "中间件"
tags: ["rabbitmq"]
---

> 下单接口返回 200，用户等了十分钟，仓库那边没收到任何出库单。翻应用日志，一行异常都没有；看 RabbitMQ 管理台，队列空空如也。消息就像发进了一个黑洞。RabbitMQ 消息丢失最坑的地方在于——它默认不报错。发到不存在的交换机、消费者提前确认、队列没持久化，全程静默。这篇把消息从生产者到消费者的四个环节拆开，每处给能直接跑的代码，把"丢了不知道"变成"丢了立刻知道"。

## 一、这个问题到底是什么

RabbitMQ 消息丢失不是单点故障，是链路上四个环节里任意一个没兜住。

一条消息的完整旅程是这样的：生产者把消息发给交换机（Exchange），交换机按路由键（Routing Key）投到队列（Queue），队列把消息推给消费者，消费者处理完再确认。这四步里，每一步都有自己的"静默失败"方式。

**第一个盲区：消息发到了不存在的交换机，或者路由键谁都匹配不上。** AMQP 协议规定，交换机找不到匹配的队列时，默认直接把消息丢掉，然后给生产者回一个"我收到了"的信号。你以为发出去了，broker 也确实收到了，只是没人接。要让 broker 把"投递失败"告诉你，必须打开 `mandatory` 开关，这样它会通过 `basic.return` 把消息原样退回来。

**第二个盲区：生产者根本不知道 broker 有没有收到。** RabbitMQ 的发布确认（Publisher Confirm）默认是关的。关着的时候，`rabbitTemplate.convertAndSend()` 只要不抛网络异常就返回，消息是在 TCP 缓冲区里还是在磁盘上，你完全不知道。

**第三个盲区：队列和消息没持久化。** 交换机、队列、消息是三个独立的持久化开关。队列声明成非持久化，broker 重启后队列连同里面的消息一起消失；队列持久化了但消息的 `delivery_mode` 是 1（非持久化），重启后队列还在、消息没了。

**第四个盲区：消费者提前确认，或者异常被吞。** 自动确认（autoAck）模式下，broker 把消息推给消费者的瞬间就认为"送达完成"，于是从队列删掉。消费者进程这时候崩了，消息就永久消失。更常见的是手动确认但代码里 `catch (Exception e) { log.error(...) }` 把异常吃了，ack 没发出去也没 nack，消息卡在 unacked 状态，直到连接断开才重回队列——如果队列配置了不重回，就直接进死信或者被丢弃。

这四个盲区叠在一起，就出现了开头那一幕：接口 200、日志干净、消息没了。

判断自己有没有中招，看三个指标：管理台的 `Unroutable` 计数、`Publish` 与 `Publish confirm` 的差值、消费者 `Unacked` 是否长期不归零。前两个描述生产者侧，第三个描述消费者侧。

## 二、底层原理到底怎么回事

### 发布确认：broker 给生产者的回执

RabbitMQ 的确认机制分两个方向。生产者到 broker 的叫 Publisher Confirm，消费者到 broker 的叫 Consumer Acknowledgement。名字像，作用完全不同。

Publisher Confirm 是异步的。你发一条消息，broker 处理完（落到交换机）之后回一个 `basic.ack`，失败则回 `basic.nack`。为了把回执和消息对上号，客户端会给每条消息带一个 `CorrelationData` 对象，broker 的 ack 回来时，客户端把结果塞进这个对象。

这里有个容易误解的点：**confirm 只代表 broker 收下了，不代表消息进了队列**。消息可能到了交换机就被丢弃（没有匹配队列）。要覆盖这一段，得靠 `mandatory` + `basic.return`。两套机制合起来才是一条完整的生产者侧链路。

### 持久化：三个开关缺一不可

消息要扛住 broker 重启，需要同时满足：

| 对象 | 持久化方式 | 缺失后果 |
| --- | --- | --- |
| 交换机 | `durable=true` | 重启后交换机消失，生产者发消息报 404 |
| 队列 | `durable=true` | 重启后队列和消息全部消失 |
| 消息 | `delivery_mode=2` | 队列还在，消息没了 |

顺带一提，`durable` 的队列只保证元数据落盘，消息体是否落盘取决于消息本身的 `delivery_mode`。很多人只做了前两个，测试环境一重启就"偶发丢消息"。

### 消费确认：什么时候算"处理完"

自动确认模式下，broker 推送消息后立即删除。手动确认模式下，消息进入 unacked 列表，等消费者显式发 `basic.ack` 才删除；发 `basic.nack(requeue=true)` 会重新入队，`requeue=false` 则走死信或丢弃。

中间那个 unacked 列表的大小由 `prefetch` 控制。prefetch 太大，一个消费者一次抓几百条消息慢慢处理，其它消费者闲着，而且进程一挂就是几百条重回队列；prefetch 太小，网络往返次数变多，吞吐上不去。

### 死信：给失败消息一条退路

消息满足三个条件之一会变成死信：被 `nack`/`reject` 且 `requeue=false`、TTL 过期、队列超过长度上限。死信会被投递到队列声明时指定的死信交换机（DLX），再路由到死信队列。

死信队列的价值不在"存起来"，而在于它把"失败"变成可观测、可重放的数据。没有死信队列，处理失败的消息只能反复重回队列，把消费者打死，或者直接消失。

### 至少一次，意味着一定会重复

确认机制 + 重投，保证的是"至少一次投递"（at-least-once），不是"恰好一次"。消费者处理完业务、还没来得及 ack 就重启，消息会重新投递，业务被执行两次。

所以幂等不是可选项。生产上的做法通常是用业务唯一键做去重，比如订单号 + Redis 的 `SET NX`，或者数据库唯一索引。这一点下面代码里会体现。

## 三、实战：手把手写代码

目标：一个下单接口，发消息给库存服务，四个盲区全部堵上，并且失败时调用方能拿到明确的 false。

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
    <artifactId>rabbit-reliable-demo</artifactId>
    <version>1.0.0</version>
    <name>rabbit-reliable-demo</name>

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
            <artifactId>spring-boot-starter-amqp</artifactId>
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

`spring-boot-starter-amqp` 带进来的是 Spring AMQP 和 RabbitMQ Java 客户端，不用另外声明。

### 2. application.yml

```yaml
spring:
  application:
    name: rabbit-reliable-demo
  rabbitmq:
    host: 127.0.0.1
    port: 5672
    username: guest
    password: guest
    virtual-host: /
    # 打开发布确认，correlated 才能把 ack 关联到具体消息
    publisher-confirm-type: correlated
    # 打开 mandatory，路由不到队列的消息会被退回
    publisher-returns: true
    listener:
      simple:
        # 手动确认：业务处理完才 ack
        acknowledge-mode: manual
        # 每个消费者最多积压 20 条未确认消息
        prefetch: 20
        concurrency: 2
        max-concurrency: 4
        # 重试耗尽后不再重回队列，交给死信
        default-requeue-rejected: false
```

`publisher-confirm-type` 有三个值：`none` 关闭，`simple` 只回 ack 不携带关联数据，`correlated` 才会把结果写进 `CorrelationData`。想等确认结果，只能选 `correlated`。

### 3. 声明交换机、队列和死信

```java
package com.example.rabbitdemo.config;

import org.springframework.amqp.core.Binding;
import org.springframework.amqp.core.BindingBuilder;
import org.springframework.amqp.core.DirectExchange;
import org.springframework.amqp.core.ExchangeBuilder;
import org.springframework.amqp.core.Queue;
import org.springframework.amqp.core.QueueBuilder;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class RabbitConfig {

    public static final String ORDER_EXCHANGE = "order.exchange";
    public static final String ORDER_QUEUE = "order.create.queue";
    public static final String ORDER_ROUTING_KEY = "order.create";

    public static final String DLX_EXCHANGE = "order.dlx.exchange";
    public static final String DLQ_QUEUE = "order.create.dlq";
    public static final String DLQ_ROUTING_KEY = "order.create.dlq";

    @Bean
    public DirectExchange orderExchange() {
        return ExchangeBuilder.directExchange(ORDER_EXCHANGE).durable(true).build();
    }

    @Bean
    public Queue orderQueue() {
        return QueueBuilder.durable(ORDER_QUEUE)
                .deadLetterExchange(DLX_EXCHANGE)
                .deadLetterRoutingKey(DLQ_ROUTING_KEY)
                .build();
    }

    @Bean
    public Binding orderBinding(Queue orderQueue, DirectExchange orderExchange) {
        return BindingBuilder.bind(orderQueue).to(orderExchange).with(ORDER_ROUTING_KEY);
    }

    @Bean
    public DirectExchange dlxExchange() {
        return ExchangeBuilder.directExchange(DLX_EXCHANGE).durable(true).build();
    }

    @Bean
    public Queue dlqQueue() {
        return QueueBuilder.durable(DLQ_QUEUE).build();
    }

    @Bean
    public Binding dlqBinding(Queue dlqQueue, DirectExchange dlxExchange) {
        return BindingBuilder.bind(dlqQueue).to(dlxExchange).with(DLQ_ROUTING_KEY);
    }
}
```

两个交换机、两个队列都是 `durable(true)`。`QueueBuilder.durable()` 建出来的队列，配合生产消息时设置持久化投递模式，重启才不会丢。

有个坑：如果 broker 上已经存在同名队列，且参数和这里不一致（比如之前没配死信交换机），启动会直接报 `PRECONDITION_FAILED - inequivalent arg`。改队列参数得先删旧队列，或者换个新队列名。

### 4. 给 RabbitTemplate 装上报错出口

```java
package com.example.rabbitdemo.config;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.amqp.core.ReturnedMessage;
import org.springframework.amqp.rabbit.connection.CorrelationData;
import org.springframework.amqp.rabbit.core.RabbitTemplate;
import org.springframework.stereotype.Component;

@Component
public class RabbitReliabilityConfig {

    private static final Logger log = LoggerFactory.getLogger(RabbitReliabilityConfig.class);

    public RabbitReliabilityConfig(RabbitTemplate rabbitTemplate) {
        rabbitTemplate.setMandatory(true);

        rabbitTemplate.setConfirmCallback((correlationData, ack, cause) -> {
            String id = correlationData == null ? "unknown" : correlationData.getId();
            if (ack) {
                log.debug("broker 已接收消息, id={}", id);
            } else {
                log.error("broker 拒收消息, id={}, 原因={}", id, cause);
            }
        });

        rabbitTemplate.setReturnsCallback((ReturnedMessage returned) -> log.error(
                "消息无法路由进队列, exchange={}, routingKey={}, replyCode={}, replyText={}, body={}",
                returned.getExchange(),
                returned.getRoutingKey(),
                returned.getReplyCode(),
                returned.getReplyText(),
                new String(returned.getMessage().getBody())));
    }
}
```

这个类在启动时改的是 Spring Boot 自动配置好的那个 `RabbitTemplate` 单例，所以全局生效。`setMandatory(true)` 和 `publisher-returns: true` 效果重叠，代码里再设一次是为了不依赖配置文件的来源。

回调只是"兜底日志"，真正要判断单条消息成没成功，得看下面生产者里的写法。

### 5. 生产者：等确认、看退回

```java
package com.example.rabbitdemo.producer;

import com.example.rabbitdemo.config.RabbitConfig;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.amqp.core.Message;
import org.springframework.amqp.core.MessageBuilder;
import org.springframework.amqp.core.MessageDeliveryMode;
import org.springframework.amqp.core.MessageProperties;
import org.springframework.amqp.rabbit.connection.CorrelationData;
import org.springframework.amqp.rabbit.core.RabbitTemplate;
import org.springframework.stereotype.Service;
import tools.jackson.databind.json.JsonMapper;

import java.nio.charset.StandardCharsets;
import java.util.UUID;
import java.util.concurrent.TimeUnit;

@Service
public class OrderProducer {

    private static final Logger log = LoggerFactory.getLogger(OrderProducer.class);

    private final RabbitTemplate rabbitTemplate;
    private final JsonMapper jsonMapper = JsonMapper.builder().build();

    public OrderProducer(RabbitTemplate rabbitTemplate) {
        this.rabbitTemplate = rabbitTemplate;
    }

    public boolean sendOrderCreated(OrderCreatedEvent event) {
        String messageId = UUID.randomUUID().toString();

        Message message;
        try {
            message = MessageBuilder
                    .withBody(jsonMapper.writeValueAsString(event).getBytes(StandardCharsets.UTF_8))
                    .setContentType(MessageProperties.CONTENT_TYPE_JSON)
                    .setContentEncoding(StandardCharsets.UTF_8.name())
                    .setMessageId(messageId)
                    .setDeliveryMode(MessageDeliveryMode.PERSISTENT)
                    .build();
        } catch (Exception e) {
            log.error("消息体序列化失败, orderId={}", event.orderId(), e);
            return false;
        }

        CorrelationData correlationData = new CorrelationData(messageId);
        rabbitTemplate.send(RabbitConfig.ORDER_EXCHANGE, RabbitConfig.ORDER_ROUTING_KEY, message, correlationData);

        try {
            CorrelationData.Confirm confirm = correlationData.getFuture().get(3, TimeUnit.SECONDS);
            if (!confirm.isAck()) {
                log.error("broker 未确认消息, id={}, orderId={}", messageId, event.orderId());
                return false;
            }
            if (correlationData.getReturned() != null) {
                log.error("消息到了交换机但没进队列, id={}, exchange={}, routingKey={}",
                        messageId,
                        correlationData.getReturned().getExchange(),
                        correlationData.getReturned().getRoutingKey());
                return false;
            }
            return true;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            log.error("等待确认被中断, id={}", messageId, e);
            return false;
        } catch (Exception e) {
            log.error("等待确认超时或失败, id={}", messageId, e);
            return false;
        }
    }
}
```

三个关键点：

- `setDeliveryMode(MessageDeliveryMode.PERSISTENT)` 让消息落盘，对应上面的第三个开关。
- `send()` 带 `CorrelationData`，`getFuture().get(3, TimeUnit.SECONDS)` 同步等 broker 回执。批量高吞吐场景别这么写，改成异步回调 + 本地消息表重试；这里是"要么成功要么明确失败"的接口场景，同步等更直观。
- `getReturned()` 非空说明消息被退回了。注意 return 和 confirm 的到达顺序并没有严格保证，极端情况下要留一个对账兜底，不能只靠这个判断。

配套的事件对象和接口：

```java
package com.example.rabbitdemo.producer;

public record OrderCreatedEvent(String orderId, String skuId, int quantity) {
}
```

```java
package com.example.rabbitdemo.web;

import com.example.rabbitdemo.producer.OrderCreatedEvent;
import com.example.rabbitdemo.producer.OrderProducer;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

@RestController
public class OrderController {

    private final OrderProducer orderProducer;

    public OrderController(OrderProducer orderProducer) {
        this.orderProducer = orderProducer;
    }

    @PostMapping("/orders")
    public ResponseEntity<Map<String, Object>> create(@RequestBody OrderCreatedEvent event) {
        boolean sent = orderProducer.sendOrderCreated(event);
        if (!sent) {
            return ResponseEntity.status(503).body(Map.of(
                    "orderId", event.orderId(),
                    "message", "下单消息投递失败，请重试"));
        }
        return ResponseEntity.ok(Map.of(
                "orderId", event.orderId(),
                "message", "已受理"));
    }
}
```

### 6. 消费者：手动确认 + 幂等

```java
package com.example.rabbitdemo.consumer;

import com.example.rabbitdemo.config.RabbitConfig;
import com.rabbitmq.client.Channel;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.amqp.core.Message;
import org.springframework.amqp.rabbit.annotation.RabbitListener;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

@Component
public class OrderConsumer {

    private static final Logger log = LoggerFactory.getLogger(OrderConsumer.class);
    private static final int MAX_RETRY = 3;

    private final Set<String> processed = ConcurrentHashMap.newKeySet();

    @RabbitListener(queues = RabbitConfig.ORDER_QUEUE)
    public void onOrderCreated(Message message, Channel channel) throws IOException {
        long deliveryTag = message.getMessageProperties().getDeliveryTag();
        String messageId = message.getMessageProperties().getMessageId();
        String body = new String(message.getBody());

        try {
            if (!processed.add(messageId)) {
                log.info("重复消息，直接确认, id={}", messageId);
                channel.basicAck(deliveryTag, false);
                return;
            }

            int retry = retryCount(message);
            if (retry >= MAX_RETRY) {
                log.error("重试次数用尽，转死信, id={}, body={}", messageId, body);
                channel.basicNack(deliveryTag, false, false);
                return;
            }

            doBusiness(body);
            channel.basicAck(deliveryTag, false);
            log.info("处理成功, id={}", messageId);
        } catch (Exception e) {
            log.error("处理失败，消息重回队列, id={}, body={}", messageId, body, e);
            processed.remove(messageId);
            channel.basicNack(deliveryTag, false, true);
        }
    }

    private int retryCount(Message message) {
        Object header = message.getMessageProperties().getHeaders().get("x-retry-count");
        return header == null ? 0 : Integer.parseInt(header.toString());
    }

    private void doBusiness(String body) {
        log.info("扣减库存: {}", body);
    }
}
```

几点说明：

- `basicAck(deliveryTag, false)` 的第二个参数是 `multiple`，false 表示只确认这一条。
- 失败时 `basicNack(deliveryTag, false, true)` 重回队列。这里有个隐患——重投的消息头里没有 `x-retry-count`，`retryCount` 永远是 0，会无限重投。生产上要么手动给重投消息加 header，要么用 Spring AMQP 的 `RetryInterceptor` 配合 `default-requeue-rejected: false`，让重试在消费端内部完成，耗尽后直接进死信。示例里保留这个写法是为了把"重试次数要自己维护"这件事摆出来。
- 幂等用 `ConcurrentHashMap` 只是演示，进程重启就失效。真实项目换成 Redis `SET key NX EX 86400` 或者数据库唯一索引，去重键用 `messageId` 或业务唯一号。

启动类：

```java
package com.example.rabbitdemo;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class RabbitReliableDemoApplication {

    public static void main(String[] args) {
        SpringApplication.run(RabbitReliableDemoApplication.class, args);
    }
}
```

跑起来后 `curl -X POST localhost:8080/orders -H 'Content-Type: application/json' -d '{"orderId":"A1001","skuId":"SKU-9","quantity":2}'`，正常返回 200；把路由键改成不存在的值，接口会返回 503，控制台同时能看到 `消息无法路由进队列` 的 error 日志。这就是"丢了立刻知道"。

## 四、踩坑经验和最佳实践

**交换机存在但路由键写错，比交换机不存在更常见。** 交换机不存在，发送会直接报 404 channel 异常，很容易发现。路由键匹配不上是静默的，尤其用了 topic 交换机、通配符多写了一层 `#`，消息就被悄悄丢了。上线前把 `Unroutable` 指标接进监控。

**手动 ack 代码里抛异常，别让 ack 漏掉。** 常见写法是 try 里做业务、catch 里 log，然后 ack 写在 try 最后一行。异常一抛，ack 和 nack 都执行不到，消息卡在 unacked，直到连接断开。正确姿势是 try/catch/finally 三段都明确处理，ack 和 nack 必居其一。

**`@RabbitListener` 方法签名里加了 `Channel` 参数，异常就不要往外抛给容器。** 容器默认会自己 ack/nack，和你手写的确认逻辑打架，最后变成"重复确认"或者 `PRECONDITION_FAILED - unknown delivery tag`。手动确认模式下，确认动作全部自己管。

**队列参数一旦声明就不能改。** 想加死信交换机、改 TTL，都得先删队列重建。灰度环境尤其容易踩：新代码启动了，老队列还在，直接启动失败。上线流程里留一步"确认队列参数变更"。

**prefetch 别拍脑袋设 1 也别设 1000。** 消费者处理耗时 50ms 上下，prefetch 20~50 是常见区间；处理耗时长且不均匀，就调小，减少单点故障时的重投量。

**死信队列也要有人看。** 死信堆到几十万条没人管，等于把问题从"丢消息"换成了"消息发霉"。给死信队列配一个消费者做告警，或者定时统计深度。

## 五、性能对比和技术选型

同步等确认和异步回调，代价差得挺明显。

| 方案 | 单机吞吐（参考量级） | 可靠性感知 | 适用场景 |
| --- | --- | --- | --- |
| 不开 confirm | 最高 | 无 | 日志、埋点等可丢消息 |
| confirm + 同步等待 | 明显下降，受 RTT 限制 | 强，调用方拿到 true/false | 下单、支付等强一致入口 |
| confirm + 异步回调 + 本地消息表 | 接近不开 confirm | 强，靠补偿兜底 | 高吞吐核心链路 |
| 事务消息（txSelect/txCommit） | 最低 | 强 | 基本不推荐，性能差且语义弱于 confirm |

选型上有几个判断：

- 消息可丢（比如操作日志），别开 confirm，省下的开销很可观。
- 消息不能丢且调用方需要立刻知道结果，用同步等确认，超时时间给 2~5 秒，超时后走本地重试。
- 高并发的核心链路，用"本地消息表 + 定时补偿"，confirm 只做日志和告警，不阻塞主流程。
- 需要严格顺序的场景，RabbitMQ 不是最优解，单队列单消费者能保证顺序但吞吐上不去，考虑 Kafka 按 key 分区。

## 六、总结

RabbitMQ 消息丢失的排查顺序就四步，按链路走一遍基本不会漏：

1. 交换机、队列、绑定关系是否都声明成 durable，队列参数是否和 broker 上一致。
2. `publisher-confirm-type` 是否为 `correlated`，生产者有没有真的处理 confirm 结果。
3. `publisher-returns` / `mandatory` 是否打开，`ReturnsCallback` 有没有落日志和告警。
4. 消费者是否手动确认，ack/nack 是否在所有分支都覆盖，失败是否有死信兜底。

一套配齐之后，消息仍然可能重复——这是至少一次投递的固有代价，不是 bug。幂等做在消费端，去重键用 messageId 或业务唯一号，别指望 MQ 帮你做到"恰好一次"。

真正要改的习惯是：不要用"接口没报错"来判断消息发出去了。让每一次投递都有回执，让每一次失败都有去处。

## 参考资料

- [Publisher Confirms and Consumer Acknowledgements](https://www.rabbitmq.com/docs/confirms)
- [Publishers](https://www.rabbitmq.com/docs/publishers)
- [Dead Lettering](https://www.rabbitmq.com/docs/dlx)
- [Spring AMQP Reference](https://docs.spring.io/spring-amqp/reference/)

文 / 会编程的吕洞宾
