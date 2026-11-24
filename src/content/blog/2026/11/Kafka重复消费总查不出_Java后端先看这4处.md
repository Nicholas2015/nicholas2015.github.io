---
title: Kafka重复消费总查不出_Java后端先看这4处
date: 2026-11-23 14:00:34
tags: ["Java", "Kafka", "Spring Boot"]
categories: java
---

# Kafka重复消费总查不出_Java后端先看这4处

> 一个做支付的兄弟上周发来日志：同一条订单消息，消费端 14:02:11 处理了一次，14:02:26 又处理了一次。他给幂等表加了唯一索引，重复数据还是照写。翻遍了业务代码，没异常、没超时、没报错。最后在日志角落里找到两行 WARN——分区被收回了。这不是业务问题，是 rebalance。

## 一、重复消费的现场长什么样

重复消费很少是「生产者发了两条」，绝大多数是「同一条消息被投递了两遍」。

先记住一句话：Kafka 的消费进度不是处理完就自动记下来的，而是消费者主动「报数」。处理到哪、报数报到哪，这两件事之间有个时间差，重复就藏在这个缝里。

### offset 就是交作业

把消费者组想成一个小组，每个成员从 partition 领一段消息，处理完在自己的作业本上记一笔「我做到第几条了」。这个记录叫 offset。

问题在于，作业本是记在 Kafka 服务端的，而「做完了」这件事发生在消费者本地。两边不在一个事务里。消费者做完题、还没报数的那一瞬间如果出了岔子，服务端只知道「他上次报的是第 10 条」，下一次就还从第 11 条发。

于是同一道题被做了第二遍。

### rebalance 是「重新分座位」

消费者组不是固定编制。有人加入、有人离开、有人被认为掉线，Kafka 就把所有 partition 收回去，重新分一遍座位，这个过程叫 rebalance。

座位一重分，原来那个人手里的进度就得作废——他没报的数不算数。哪怕他本地已经处理完，只要 offset 没提交上去，新拿到这个 partition 的消费者就会从上次提交的位置接着读。

重复消费的根，几乎都在这。

### 三种典型症状，对照着看

- 日志里同一条消息处理两次，间隔十几秒到几分钟，中间夹着 `Rebalance` 或 `partitions revoked`
- 每次发版重启、扩容之后就出现一批重复，跑一阵自己好了
- 重复没有规律，但总在「某个接口变慢」「数据库抖一下」「Full GC」之后冒出来

如果你的重复是「每秒都重复同一条」，那是死循环或者 ack 位置写错了，跟 rebalance 不是一回事。这篇文章讲前面三种。

## 二、底层原理到底怎么回事

rebalance 的触发条件只有几个，摸清了就能对症下药。

### 一个消费者其实跑了两个线程

消费者内部其实跑着两条独立的线：

- 业务线程：你调 `poll()` 拉一批消息，然后处理，处理完再 `poll()`
- 心跳线程：后台默默给协调器发心跳，证明「我还活着」

这两条线用的是两个不同的超时。很多人只盯着心跳，忽略了业务线程也会被踢。

### 两个超时，管的是两件事

| 参数 | 默认值 | 管什么 | 超了会怎样 |
|---|---|---|---|
| `session.timeout.ms` | 45000 | 心跳线程多久没心跳算掉线 | 协调器直接把你移出组，立刻 rebalance |
| `max.poll.interval.ms` | 300000 | 两次 `poll()` 之间最长隔多久 | 认为你卡死了，主动发起离开组，rebalance |
| `heartbeat.interval.ms` | 3000 | 心跳发送间隔 | 一般设成 session 的 1/3 左右 |

关键在于：心跳线程正常，业务线程卡住，照样会被踢。

心跳线程不知道你在干什么，它只负责发心跳。协调器那边看的是「这个成员最近一次 poll 是什么时候」。你在一批消息里 sleep 了 6 分钟，心跳一直在发，看起来活得好好的，但 `max.poll.interval.ms` 已经超了，协调器会让你滚出组。

这就是为什么「服务没挂、GC 正常、网络正常」，却还是 rebalance。

### 分区被收回的瞬间，offset 停在哪

手动提交的流程是：处理消息 → 处理成功 → 提交 offset。

如果处理到一半 partition 被收回，Spring 的容器会调用你注册的 `ConsumerRebalanceListener`，然后是提交逻辑。此时消费者已经被移出组，提交必然失败，抛的就是这句：

```text
org.apache.kafka.clients.consumer.CommitFailedException:
Offset commit cannot be completed since the consumer is not part of an active group
```

提交失败，offset 原地不动。重新分配之后，新消费者（很可能还是你自己，重新入组）从旧 offset 开始读，前面那段就重放了。

### eager 和 cooperative 的区别

老协议是 eager：rebalance 时所有人先把手里的 partition 全交出来，全部停下，等协调器重新分完再开工。整个组在几秒内是停摆的。

KIP-429 引入的 cooperative 协议是增量的：只收回真正需要挪动的那部分 partition，其他人继续消费。它把「全组停顿」变成「局部停顿」，重复窗口也小很多。

配置方式就一行：

```properties
partition.assignment.strategy=org.apache.kafka.clients.consumer.CooperativeStickyAssignor
```

注意：组里所有消费者必须同时支持，混着用会一直协商失败。

### 为什么发版、扩容必然触发

新实例启动加入组 → rebalance。老实例关闭 → rebalance。K8s 滚动发布一个个换 → 一连串 rebalance。

这些是正常的，无法避免。能做的是让每次 rebalance 窗口尽量短，并且用幂等兜住那几条重放的消息。

## 三、实战：手把手复现一次重复消费

这一节从零搭一个能跑的项目，先人为制造一次 rebalance 导致的重复，再把参数改对，看重复消失。

### 3.1 项目结构

```text
kafka-rebalance-demo
├── pom.xml
└── src/main
    ├── java/com/example/kafkarebalance
    │   ├── KafkaRebalanceDemoApplication.java
    │   ├── config
    │   │   ├── KafkaTopicConfig.java
    │   │   ├── KafkaProducerConfig.java
    │   │   └── KafkaConsumerConfig.java
    │   ├── event
    │   │   └── OrderEvent.java
    │   ├── listener
    │   │   └── RebalanceLogListener.java
    │   ├── consumer
    │   │   └── OrderEventConsumer.java
    │   ├── producer
    │   │   └── OrderEventProducer.java
    │   ├── store
    │   │   └── IdempotentStore.java
    │   └── web
    │       └── OrderController.java
    └── resources
        └── application.yml
```

本地没有 Kafka 的，按官方 quickstart 起一个单节点就行，一条 `docker run` 的事，命令在文末参考资料里。已经有集群的直接改 `bootstrap-servers`。

### 3.2 pom.xml

```xml
<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
    <modelVersion>4.0.0</modelVersion>

    <parent>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-parent</artifactId>
        <version>4.2.0</version>
        <relativePath/>
    </parent>

    <groupId>com.example</groupId>
    <artifactId>kafka-rebalance-demo</artifactId>
    <version>1.0.0</version>
    <name>kafka-rebalance-demo</name>

    <properties>
        <java.version>21</java.version>
    </properties>

    <dependencies>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-web</artifactId>
            <version>4.2.0</version>
        </dependency>
        <dependency>
            <groupId>org.springframework.kafka</groupId>
            <artifactId>spring-kafka</artifactId>
            <version>4.2.0</version>
        </dependency>
        <dependency>
            <groupId>org.apache.kafka</groupId>
            <artifactId>kafka-clients</artifactId>
            <version>4.4.0</version>
        </dependency>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-test</artifactId>
            <version>4.2.0</version>
            <scope>test</scope>
        </dependency>
    </dependencies>

    <build>
        <plugins>
            <plugin>
                <groupId>org.springframework.boot</groupId>
                <artifactId>spring-boot-maven-plugin</artifactId>
                <version>4.2.0</version>
            </plugin>
        </plugins>
    </build>
</project>
```

### 3.3 application.yml

第一次跑，故意把 `max-poll-interval-ms` 设成 10 秒，让「处理 12 秒」的单条消息必然超时。

```yaml
server:
  port: 8080

spring:
  application:
    name: kafka-rebalance-demo
  kafka:
    bootstrap-servers: localhost:9092

app:
  consumer:
    simulate-slow: true
    idempotent: false
    max-poll-interval-ms: 10000
    session-timeout-ms: 10000
    max-poll-records: 10
```

### 3.4 启动类

```java
package com.example.kafkarebalance;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class KafkaRebalanceDemoApplication {

    public static void main(String[] args) {
        SpringApplication.run(KafkaRebalanceDemoApplication.class, args);
    }
}
```

### 3.5 消息体

用 record，字段全是基本类型，省得为序列化日期再折腾一遍 Jackson 模块。

```java
package com.example.kafkarebalance.event;

public record OrderEvent(
        String eventId,
        Long orderId,
        Long userId,
        long amountCents,
        long createdAt
) {
}
```

`eventId` 是这条消息的唯一标识，后面做幂等就靠它。别用订单号，同一个订单可能有支付、退款、关单好几条消息。

### 3.6 建 topic

三个分区，一个副本。单机环境副本只能设 1，否则 topic 创建不出来。

```java
package com.example.kafkarebalance.config;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.kafka.config.TopicBuilder;
import org.apache.kafka.clients.admin.NewTopic;

@Configuration
public class KafkaTopicConfig {

    @Bean
    public NewTopic orderEventsTopic() {
        return TopicBuilder.name("order-events")
                .partitions(3)
                .replicas(1)
                .build();
    }
}
```


### 3.7 生产端配置

自己声明 `ProducerFactory`，不依赖自动配置的泛型推断，类型是明确的 `String` 键、`OrderEvent` 值。

```java
package com.example.kafkarebalance.config;

import com.example.kafkarebalance.event.OrderEvent;
import org.apache.kafka.clients.producer.ProducerConfig;
import org.apache.kafka.common.serialization.StringSerializer;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.kafka.core.DefaultKafkaProducerFactory;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.kafka.core.ProducerFactory;
import org.springframework.kafka.support.serializer.JsonSerializer;

import java.util.HashMap;
import java.util.Map;

@Configuration
public class KafkaProducerConfig {

    @Value("${spring.kafka.bootstrap-servers}")
    private String bootstrapServers;

    @Bean
    public ProducerFactory<String, OrderEvent> orderProducerFactory() {
        Map<String, Object> props = new HashMap<>();
        props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, bootstrapServers);
        props.put(ProducerConfig.KEY_SERIALIZER_CLASS_CONFIG, StringSerializer.class);
        props.put(ProducerConfig.VALUE_SERIALIZER_CLASS_CONFIG, JsonSerializer.class);
        props.put(ProducerConfig.ACKS_CONFIG, "all");
        props.put(ProducerConfig.ENABLE_IDEMPOTENCE_CONFIG, true);
        props.put(ProducerConfig.RETRIES_CONFIG, Integer.MAX_VALUE);
        return new DefaultKafkaProducerFactory<>(props);
    }

    @Bean
    public KafkaTemplate<String, OrderEvent> orderKafkaTemplate(
            ProducerFactory<String, OrderEvent> orderProducerFactory) {
        return new KafkaTemplate<>(orderProducerFactory);
    }
}
```

`acks=all` 加 `enable.idempotence=true` 是生产端的底线：保证消息不因为重试在 broker 上重复落盘。注意这只管「生产端重复」，管不了消费端重放。

### 3.8 消费端配置

所有关键参数都在这里显式写死，不靠默认值——默认值 5 分钟的 `max.poll.interval.ms` 会把这个 demo 的坑藏起来。

```java
package com.example.kafkarebalance.config;

import com.example.kafkarebalance.event.OrderEvent;
import com.example.kafkarebalance.listener.RebalanceLogListener;
import org.apache.kafka.clients.consumer.ConsumerConfig;
import org.apache.kafka.clients.consumer.CooperativeStickyAssignor;
import org.apache.kafka.common.serialization.StringDeserializer;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.kafka.config.ConcurrentKafkaListenerContainerFactory;
import org.springframework.kafka.core.ConsumerFactory;
import org.springframework.kafka.core.DefaultKafkaConsumerFactory;
import org.springframework.kafka.listener.ContainerProperties;
import org.springframework.kafka.listener.DefaultErrorHandler;
import org.springframework.kafka.support.serializer.JsonDeserializer;
import org.springframework.util.backoff.FixedBackOff;

import java.util.HashMap;
import java.util.Map;

@Configuration
public class KafkaConsumerConfig {

    @Value("${spring.kafka.bootstrap-servers}")
    private String bootstrapServers;

    @Value("${app.consumer.max-poll-interval-ms}")
    private long maxPollIntervalMs;

    @Value("${app.consumer.session-timeout-ms}")
    private int sessionTimeoutMs;

    @Value("${app.consumer.max-poll-records}")
    private int maxPollRecords;

    @Bean
    public ConsumerFactory<String, OrderEvent> orderConsumerFactory() {
        Map<String, Object> props = new HashMap<>();
        props.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, bootstrapServers);
        props.put(ConsumerConfig.GROUP_ID_CONFIG, "order-consumer-group");
        props.put(ConsumerConfig.KEY_DESERIALIZER_CLASS_CONFIG, StringDeserializer.class);
        props.put(ConsumerConfig.VALUE_DESERIALIZER_CLASS_CONFIG, JsonDeserializer.class);
        props.put(ConsumerConfig.AUTO_OFFSET_RESET_CONFIG, "earliest");
        props.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, false);
        props.put(ConsumerConfig.MAX_POLL_RECORDS_CONFIG, maxPollRecords);
        props.put(ConsumerConfig.MAX_POLL_INTERVAL_MS_CONFIG, maxPollIntervalMs);
        props.put(ConsumerConfig.SESSION_TIMEOUT_MS_CONFIG, sessionTimeoutMs);
        props.put(ConsumerConfig.HEARTBEAT_INTERVAL_MS_CONFIG, 3000);
        props.put(ConsumerConfig.PARTITION_ASSIGNMENT_STRATEGY_CONFIG,
                CooperativeStickyAssignor.class.getName());
        props.put(JsonDeserializer.TRUSTED_PACKAGES, "com.example.kafkarebalance.event");
        return new DefaultKafkaConsumerFactory<>(props);
    }

    @Bean
    public ConcurrentKafkaListenerContainerFactory<String, OrderEvent> kafkaListenerContainerFactory(
            ConsumerFactory<String, OrderEvent> orderConsumerFactory,
            RebalanceLogListener rebalanceLogListener) {

        ConcurrentKafkaListenerContainerFactory<String, OrderEvent> factory =
                new ConcurrentKafkaListenerContainerFactory<>();
        factory.setConsumerFactory(orderConsumerFactory);
        factory.setConcurrency(1);
        factory.getContainerProperties().setAckMode(ContainerProperties.AckMode.MANUAL_IMMEDIATE);
        factory.getContainerProperties().setConsumerRebalanceListener(rebalanceLogListener);
        factory.setCommonErrorHandler(new DefaultErrorHandler(new FixedBackOff(1000L, 2L)));
        return factory;
    }
}
```

`MANUAL_IMMEDIATE` 的意思是：只有你调 `ack.acknowledge()` 的那一刻才提交，而且立刻提交，不攒批。攒批在 rebalance 时最危险——攒着没提交的那几条，全部重放。

### 3.9 把分区的进出打出来

没有这一层日志，你永远看不到「收回」这个动作，只能看到重复。

```java
package com.example.kafkarebalance.listener;

import org.apache.kafka.clients.consumer.ConsumerRebalanceListener;
import org.apache.kafka.common.TopicPartition;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.time.LocalTime;
import java.util.Collection;

@Component
public class RebalanceLogListener implements ConsumerRebalanceListener {

    private static final Logger log = LoggerFactory.getLogger(RebalanceLogListener.class);

    @Override
    public void onPartitionsRevoked(Collection<TopicPartition> partitions) {
        log.warn("分区被收回 partitions={} time={}", partitions, LocalTime.now());
    }

    @Override
    public void onPartitionsAssigned(Collection<TopicPartition> partitions) {
        log.info("分区被分配 partitions={} time={}", partitions, LocalTime.now());
    }
}
```

### 3.10 消费者

核心在三处：处理失败不提交、提交失败要看得见、幂等开关可以关掉（复现阶段需要它关着）。

```java
package com.example.kafkarebalance.consumer;

import com.example.kafkarebalance.event.OrderEvent;
import com.example.kafkarebalance.store.IdempotentStore;
import org.apache.kafka.clients.consumer.CommitFailedException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.kafka.support.Acknowledgment;
import org.springframework.kafka.support.KafkaHeaders;
import org.springframework.messaging.handler.annotation.Header;
import org.springframework.stereotype.Component;

@Component
public class OrderEventConsumer {

    private static final Logger log = LoggerFactory.getLogger(OrderEventConsumer.class);

    private final IdempotentStore store;
    private final boolean simulateSlow;
    private final boolean idempotentEnabled;

    public OrderEventConsumer(IdempotentStore store,
                              @Value("${app.consumer.simulate-slow}") boolean simulateSlow,
                              @Value("${app.consumer.idempotent}") boolean idempotentEnabled) {
        this.store = store;
        this.simulateSlow = simulateSlow;
        this.idempotentEnabled = idempotentEnabled;
    }

    @KafkaListener(id = "order-consumer", topics = "order-events",
            groupId = "order-consumer-group")
    public void onMessage(OrderEvent event,
                          @Header(KafkaHeaders.RECEIVED_PARTITION) int partition,
                          @Header(KafkaHeaders.OFFSET) long offset,
                          Acknowledgment ack) {

        int times = store.incrementAndGet(event.eventId());
        log.info("收到消息 eventId={} orderId={} partition={} offset={} 第{}次处理",
                event.eventId(), event.orderId(), partition, offset, times);

        if (idempotentEnabled && store.isProcessed(event.eventId())) {
            log.warn("重复消息已拦截 eventId={}", event.eventId());
            ack.acknowledge();
            return;
        }

        long start = System.currentTimeMillis();
        try {
            if (simulateSlow) {
                Thread.sleep(12_000L);
            }
            log.info("业务处理完成 eventId={} 耗时={}ms",
                    event.eventId(), System.currentTimeMillis() - start);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("消费线程被中断，不提交 offset", e);
        }

        store.markProcessed(event.eventId());

        try {
            ack.acknowledge();
        } catch (CommitFailedException e) {
            log.error("offset 提交失败，本批消息会被重放 eventId={}", event.eventId(), e);
        }
    }
}
```

注意处理失败时是抛异常、不 `acknowledge()`。抛出去之后 `DefaultErrorHandler` 会重试两次，还不行才交给容器处理，offset 依然不提交。

### 3.11 幂等存储

demo 用内存，生产换 Redis 或数据库唯一索引。逻辑一模一样：先查后写，写成功才算处理完。

```java
package com.example.kafkarebalance.store;

import org.springframework.stereotype.Component;

import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

@Component
public class IdempotentStore {

    private final Map<String, Integer> processCount = new ConcurrentHashMap<>();
    private final Set<String> processed = ConcurrentHashMap.newKeySet();

    public int incrementAndGet(String eventId) {
        return processCount.merge(eventId, 1, Integer::sum);
    }

    public boolean isProcessed(String eventId) {
        return processed.contains(eventId);
    }

    public void markProcessed(String eventId) {
        processed.add(eventId);
    }

    public Map<String, Integer> snapshot() {
        return Map.copyOf(processCount);
    }
}
```

### 3.12 生产端发送入口

配一个接口，批量灌消息，省得手写脚本。

```java
package com.example.kafkarebalance.producer;

import com.example.kafkarebalance.event.OrderEvent;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.stereotype.Component;

@Component
public class OrderEventProducer {

    private static final Logger log = LoggerFactory.getLogger(OrderEventProducer.class);

    private final KafkaTemplate<String, OrderEvent> kafkaTemplate;

    public OrderEventProducer(KafkaTemplate<String, OrderEvent> orderKafkaTemplate) {
        this.kafkaTemplate = orderKafkaTemplate;
    }

    public void send(OrderEvent event) {
        kafkaTemplate.send("order-events", String.valueOf(event.orderId()), event)
                .whenComplete((result, ex) -> {
                    if (ex != null) {
                        log.error("发送失败 eventId={}", event.eventId(), ex);
                        return;
                    }
                    log.info("发送成功 eventId={} partition={} offset={}",
                            event.eventId(),
                            result.getRecordMetadata().partition(),
                            result.getRecordMetadata().offset());
                });
    }
}
```

用 `orderId` 当 key，同一个订单的消息会进同一个分区，顺序有保证。

### 3.13 接口

一个灌消息，一个查重复。

```java
package com.example.kafkarebalance.web;

import com.example.kafkarebalance.event.OrderEvent;
import com.example.kafkarebalance.producer.OrderEventProducer;
import com.example.kafkarebalance.store.IdempotentStore;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;
import java.util.UUID;
import java.util.stream.Collectors;

@RestController
@RequestMapping("/orders")
public class OrderController {

    private final OrderEventProducer producer;
    private final IdempotentStore store;

    public OrderController(OrderEventProducer producer, IdempotentStore store) {
        this.producer = producer;
        this.store = store;
    }

    @PostMapping("/burst")
    public Map<String, Object> burst(@RequestParam(defaultValue = "30") int count) {
        for (int i = 0; i < count; i++) {
            OrderEvent event = new OrderEvent(
                    UUID.randomUUID().toString(),
                    1000L + i,
                    2000L + i,
                    1999L + i,
                    System.currentTimeMillis());
            producer.send(event);
        }
        return Map.of("sent", count);
    }

    @GetMapping("/duplicates")
    public Map<String, Integer> duplicates() {
        return store.snapshot().entrySet().stream()
                .filter(entry -> entry.getValue() > 1)
                .collect(Collectors.toMap(Map.Entry::getKey, Map.Entry::getValue));
    }
}
```

### 3.14 跑起来看重复

先起 Kafka，再 `mvn spring-boot:run`，然后灌 10 条：

```bash
curl -X POST "http://localhost:8080/orders/burst?count=10"
```

因为 `max.poll.records=10`，一批刚好 10 条，每条 sleep 12 秒，整批要 120 秒；而 `max-poll-interval-ms=10000`，10 秒就被判死。

日志会是这样：

```text
[order-consumer] 收到消息 eventId=a3f1... partition=0 offset=0 第1次处理
WARN  RebalanceLogListener - 分区被收回 partitions=[order-events-0, order-events-1, order-events-2] time=14:02:11.402
WARN  [Consumer clientId=...] Member ... is leaving group due to consumer poll timeout has expired
INFO  RebalanceLogListener - 分区被分配 partitions=[order-events-0, order-events-1, order-events-2] time=14:02:11.980
ERROR OrderEventConsumer - offset 提交失败，本批消息会被重放 eventId=a3f1...
[order-consumer] 收到消息 eventId=a3f1... partition=0 offset=0 第2次处理
```

同一条消息，同一个 offset，处理了两次。

查一下：`curl http://localhost:8080/orders/duplicates`，返回里能看到每条消息的处理次数。

再补一刀：灌进去之后重启一次应用，效果一样。发版必重复，就是这个原因，不是巧合。


### 3.15 把参数改对，重复消失

只改配置，代码一行不动：

```yaml
server:
  port: 8080

spring:
  application:
    name: kafka-rebalance-demo
  kafka:
    bootstrap-servers: localhost:9092

app:
  consumer:
    simulate-slow: true
    idempotent: true
    max-poll-interval-ms: 120000
    session-timeout-ms: 45000
    max-poll-records: 5
```

算一笔账：每批 5 条，每条 12 秒，一批最多 60 秒，对比 120 秒的上限有一倍余量。GC 停个几秒也不会越线。

重启后再灌 10 条，日志里 `分区被收回` 不再出现，`/orders/duplicates` 返回空对象。

幂等开关这时也打开了。它的作用不是让复现消失，而是万一还发生 rebalance，重放的那几条被 `eventId` 挡住，业务只执行一次。

## 四、踩坑经验和最佳实践

这一节全是真实踩过的，按出现频率排。

### 坑一：只调 session.timeout.ms

调大 `session.timeout.ms` 治的是心跳，治不了业务卡顿。

消费者被踢有两个口子：心跳停了，或者 poll 超时了。如果你的消费逻辑里有慢 SQL、远程调用、大批量计算，问题在第二个口子。把 session 从 45 秒调到 5 分钟，poll 超时该触发还是触发。

判断方法很简单：日志里搜 `poll timeout` 和 `heartbeat`，看是哪句。

### 坑二：打开自动提交就以为万事大吉

`enable.auto.commit=true` 最坑的地方不是重复，是丢消息。

自动提交是跟着 `poll()` 走的，默认 5 秒一次。你 `poll()` 拿到 10 条，提交线程这时候可能已经把「我拿到第 10 条」报上去了，而你才处理到第 3 条。进程一挂，剩下 7 条永远不会再投——这在业务上叫丢单。

要可控就关自动提交，手动 ack。

### 坑三：ack 写在异步线程里

有人为了提速，`poll` 到消息就丢进线程池，主线程立刻返回。这时候 ack 跟着主线程走了，异步任务还没跑完，offset 已经提交。

结果：任务失败、服务重启，消息也不会重投。

要么处理完在同一个线程里 ack，要么异步任务自己持有 `Acknowledgment` 并在完成后回调。后者更麻烦，容易出并发提交的顺序问题。我的建议是批量处理慢活时用 `concurrency` 加消费者实例，而不是在单个消费者里开线程池。

### 坑四：用消息内容算幂等键

拿 `orderId + amount` 做幂等键，看起来合理，实际会撞车：同一个订单改价、退款、重复支付，金额一样、订单号一样，第二条真消息被当成重复丢了。

幂等键必须是生产端生成的、每条消息唯一的 ID（就是上面代码里的 `eventId`，用 UUID 或者雪花 ID）。别用业务字段拼。

### 坑五：以为加机器能解决

消费者数量超过 partition 数量，多出来的实例分不到分区，纯属干看着。3 个分区最多 3 个消费者并行，第 4 个只会触发更多 rebalance。

扩容前先看分区数，不够就先扩分区。注意扩分区会改变 key 到分区的映射，同一个订单的消息可能跑到别的分区，顺序性要重新评估。

### 一套能落地的检查顺序

1. 先看日志里有没有 `partitions revoked`，确认是不是 rebalance
2. 有的话，算「批量条数 × 单条最慢耗时」，跟 `max.poll.interval.ms` 比
3. 超了就调小 `max.poll.records`，或调大 interval，两个一起调更稳
4. 确认 ack 模式是 `MANUAL_IMMEDIATE`，ack 在处理成功之后
5. 幂等键换成生产端生成的 `eventId`，用 Redis `SETNX` 或数据库唯一索引兜底
6. 分区数 ≥ 消费者数，扩容前先扩分区

## 五、性能对比和技术选型

解决重复消费有四条路，优先级从高到低。

| 方案 | 解决什么 | 代价 | 适用场景 |
|---|---|---|---|
| 调 `max.poll.interval.ms` + 降 `max.poll.records` | 消除「处理慢导致的踢出」 | 吞吐略降，延迟略升 | 首选，改动最小 |
| 业务异步化（线程池/批处理） | 缩短单批处理时间 | 顺序性和 ack 复杂度上升 | 允许乱序的日志、通知类 |
| 幂等表（Redis/唯一索引） | 兜住所有重放 | 每条消息多一次读写 | 必须有，支付/订单类不可省 |
| 换 cooperative 协议 | 缩短 rebalance 停顿 | 全组版本要一致 | 消费者多、发布频繁 |

ack 模式的选择：

- `RECORD`：逐条提交，最安全，吞吐最低
- `BATCH`：一批处理完再提交，rebalance 时重放整批
- `MANUAL_IMMEDIATE`：自己控制提交时机，适合有明确业务边界的场景
- `MANUAL`：攒着等下次 poll 一起提交，省网络但风险高

我的默认组合：`MANUAL_IMMEDIATE` + `max.poll.records` 按「单批总耗时不超过 interval 一半」反推 + `eventId` 幂等。三样齐了，rebalance 就只是日志里一行 WARN，不再是数据问题。

吞吐和一致性的取舍，本质上是你愿意为「可能重复」付多少成本。支付、库存这种，多一次读写换绝对不重，划算。埋点、通知这种，重复一条无所谓，就别上幂等表拖慢链路。

## 六、总结

Kafka 的重复消费，八成不是 Kafka 发重了，是消费者被踢出组、offset 没提交、消息被重放。

记住三件事：

- 消费者内部有业务线程和心跳线程，两个超时各管一摊。心跳正常不代表 poll 正常
- rebalance 一旦发生，没提交的 offset 原地不动，那段消息必然重放，发版重启必踩
- 参数调优只能把概率降到很低，幂等才是最后一道门。而且幂等键必须是生产端生成的唯一 ID

排查顺序也别搞反了：先看有没有 `partitions revoked`，再去算「批量条数 × 单条耗时」和 `max.poll.interval.ms` 的关系。这个算式一对，问题基本就落地了。

真要说一句得罪人的话：大部分「Kafka 重复消费」的工单，最后都指向一段藏着远程调用或者 `Thread.sleep` 的消费逻辑，跟 Kafka 本身没多大关系。

## 参考资料

- [Apache Kafka Consumer Configs](https://kafka.apache.org/documentation/#consumerconfigs)
- [KIP-429: Kafka Consumer Incremental Rebalance Protocol](https://cwiki.apache.org/confluence/display/KAFKA/KIP-429%3A+Kafka+Consumer+Incremental+Rebalance+Protocol)
- [Spring for Apache Kafka Reference](https://docs.spring.io/spring-kafka/reference/)
- [Apache Kafka Quickstart](https://kafka.apache.org/quickstart)

文 / 会编程的吕洞宾
