---
title: "Kafka消费积压百万条，Java后端先查这三处"
date: 2026-10-20T09:00:00+08:00
category: "中间件"
tags: ["kafka"]
---

> 凌晨两点，告警群炸了：订单状态同步的消费积压冲到 120 万条，还在涨。值班同事第一反应是加消费者机器，从两台加到六台，lag 一点没降。为什么？这个 Topic 只有 3 个分区，多出来的消费者全程在组里待着，一条消息也分不到。Kafka 消费积压不是「加机器」能解决的问题，先看清楚卡在哪：分区够不够、单条处理慢不慢、消费者是不是一直在 rebalance。这三处查完，方向基本就定了。

## 一、Kafka 消费积压到底是什么

结论：消费积压的本质只有一句话——生产消息的速度，长期大于消费消息的速度。

Kafka 里的 lag，等于某个分区最新消息的位置减去消费组已经提交的位置。通俗点说，传送带尽头堆了多少件还没取走的包裹。lag 是算出来的差值，不是 Kafka 单独存的一个数字。

很多人盯着 lag 曲线慌，其实要先看三个数：

| 指标 | 在哪看 | 说明什么 |
| --- | --- | --- |
| 生产速率 | Broker 的 MessagesInPerSec | 每秒进来多少条 |
| 消费速率 | 消费组 lag 的变化斜率 | 每秒出去多少条 |
| 分区数 | Topic 详情 | 并行消费的天花板 |

消费速率的理论上限，可以用一个很粗的公式估：

```
最大消费速率 ≈ 分区数 × 每个消费者的处理线程数 ÷ 单条平均处理耗时
```

举个例子。Topic 有 3 个分区，每个消费者一个线程，单条消息要调一次第三方物流接口，平均 200 毫秒。那单线程每秒最多 5 条，3 个分区加起来 15 条/秒。生产端每秒进来 300 条，积压不涨才怪。

这时候加消费者，第 4 台机器启动后会发现组里没有多余分区可分，它只能空转。Kafka 的规则很硬：一个分区同一时刻只能被消费组里的一个消费者消费。消费者数量超过分区数，多出来的就是备胎。

还有一种「假积压」：消费者其实处理得动，但每隔几分钟就 rebalance 一次，每次重平衡期间整个组停摆，提交的 offset 来回跳。看曲线像积压，看日志全是 `Attempt to heartbeat failed` 或者 `member was removed`。这类问题加机器只会更糟，因为参与重平衡的成员变多了。

判断方法不复杂：

- lag 持续上涨，消费速率稳定但很低 → 单条处理太慢，或者分区太少
- lag 锯齿状，周期性回退 → rebalance，先查 `max.poll.interval.ms`
- 只有个别分区 lag 高 → 分区倾斜，检查消息 key
- 消费速率突然归零 → 消费者卡死、线程池打满，或者被踢出组

先把问题归到某一类，再谈优化。上来就调参数，等于蒙着眼睛修车。

## 二、Kafka 的消费模型，决定了你能怎么提速

结论：Kafka 的并行度由分区数决定，消费进度由 poll 循环推进，任何一次处理超时都会触发 rebalance，把吞吐打回原点。

### 分区是并行单位，不是队列

一个 Topic 拆成多个分区，每个分区是一段只能追加的日志文件。消息进来时按 key 的哈希落到某个分区，同一个 key 永远进同一个分区，所以分区内有序，跨分区不保证顺序。

消费组分配分区的方式，决定了三件事：

- 消费者数 ≤ 分区数时，每个消费者分到若干分区
- 消费者数 > 分区数时，多出来的消费者分不到分区
- 任何成员加入、离开、心跳超时，都会触发一次重新分配

所以「加机器」只在分区数足够时有效。3 个分区就是 3 个并行槽位，第 4 个消费者只能看着。

### poll 循环：拉一批、处理、再拉

消费者不是被动接收推送，而是主动问 Broker 要消息。核心循环长这样：

1. `poll()` 拉一批消息，最多 `max.poll.records` 条，默认 500
2. 业务代码处理这一批
3. 处理完再 `poll()`，同时提交 offset

这里有个容易被忽略的约束：两次 `poll()` 的间隔不能超过 `max.poll.interval.ms`，默认 5 分钟。超过了，Broker 认为这个消费者死了，把它踢出组，触发 rebalance。

一旦 rebalance，这个消费者手里的分区会被收回，重新分给别人。新拿到分区的消费者从上一次提交的 offset 开始消费，中间没提交的部分会重复处理。如果处理逻辑本身要 6 分钟，那它永远撑不到下一次 poll，就会陷入「处理一半 → 被踢 → 重平衡 → 再处理一半」的死循环。lag 不但不降，还会因为重复消费涨得更快。

### 批量处理是把双刃剑

`max.poll.records` 调大，一次拿更多消息，摊薄了每次 poll 和提交的网络开销，吞吐会涨。但它同时把单批处理时间拉长，逼近 `max.poll.interval.ms` 的红线。

我一般这么配：先按「单批处理时间不超过 max.poll.interval.ms 的三分之一」倒推批量大小。比如一批最多处理 90 秒，那就别让一批跑过 100 秒。

批量和确认机制也要配套。批量监听器下一次收到的是一个 `List<ConsumerRecord>`，手动 ack 时整批一起提交。中途第 37 条失败，整批都会重试，前面 36 条白干。要么业务做成幂等，要么把失败消息挑出来进死信队列，别让一条坏消息堵住整个分区。

### 消费线程和分区的关系

`concurrency=3` 的意思是启动 3 个消费线程，每个线程内部一个 KafkaConsumer 实例。3 个线程对应 3 个分区刚好，多了浪费。

有人会想：那我一个分区开 10 个线程并行处理行不行？行，但顺序没了，而且 offset 提交会变得很难管。真要提高单分区吞吐，正确做法是把「拉消息」和「处理消息」拆开：拉取线程只管 poll，处理丢给业务线程池，用信号量控制积压量。代价是复杂度上一个台阶，还得自己处理位移提交和优雅停机。多数业务系统没到这一步，先把分区和批量用对就够了。

一句话总结这一节：Kafka 给的并行能力是「分区级」的，消费端所有优化都绕不开这个前提。

## 三、实战：一套能跑的批量消费和积压监控

结论：把逐条处理改成批量处理，配上有限重试和死信队列，再用 AdminClient 把 lag 打成日志，是成本最低的一套组合拳。

下面这个 demo 可以直接跑。需要本地有一个 Kafka，默认连 `localhost:9092`。

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
        <version>4.1.1</version>
        <relativePath/>
    </parent>

    <groupId>com.example</groupId>
    <artifactId>kafka-lag-demo</artifactId>
    <version>1.0.0</version>
    <name>kafka-lag-demo</name>

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
            <groupId>org.springframework.kafka</groupId>
            <artifactId>spring-kafka</artifactId>
            <version>4.1.1</version>
        </dependency>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-actuator</artifactId>
            <version>4.1.1</version>
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

### 2. application.yml

```yaml
server:
  port: 8080

spring:
  application:
    name: kafka-lag-demo
  kafka:
    bootstrap-servers: localhost:9092
    producer:
      key-serializer: org.apache.kafka.common.serialization.StringSerializer
      value-serializer: org.apache.kafka.common.serialization.StringSerializer
      acks: all
      properties:
        enable.idempotence: true
    consumer:
      group-id: order-sync-group
      auto-offset-reset: earliest
      key-deserializer: org.apache.kafka.common.serialization.StringDeserializer
      value-deserializer: org.apache.kafka.common.serialization.StringDeserializer

management:
  endpoints:
    web:
      exposure:
        include: health,info,metrics
```

生产者交给 Spring Boot 自动配置，消费者工厂在 Java 里手工建，因为要开批量、手动 ack 和死信队列，配置项比 yml 多。

### 3. 启动类

```java
package com.example.kafkalag;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.scheduling.annotation.EnableScheduling;

@SpringBootApplication
@EnableScheduling
public class KafkaLagDemoApplication {

    public static void main(String[] args) {
        SpringApplication.run(KafkaLagDemoApplication.class, args);
    }
}
```

`@EnableScheduling` 是给后面的积压监控用的，每 30 秒查一次 lag。

### 4. 消息体

```java
package com.example.kafkalag.domain;

public record OrderEvent(String orderId, String status) {

    public String toMessage() {
        return orderId + "|" + status;
    }

    public static OrderEvent parse(String value) {
        if (value == null) {
            return null;
        }
        int index = value.indexOf('|');
        if (index <= 0 || index == value.length() - 1) {
            return null;
        }
        return new OrderEvent(value.substring(0, index), value.substring(index + 1));
    }
}
```

消息格式故意用 `orderId|status`，不用 JSON。生产环境换成 JSON 或 Avro 都行，这里是为了让例子不依赖序列化框架，复制就能跑。

### 5. 消费者配置：批量 + 手动 ack + 死信队列

```java
package com.example.kafkalag.config;

import org.apache.kafka.clients.consumer.ConsumerConfig;
import org.apache.kafka.common.serialization.StringDeserializer;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.kafka.config.ConcurrentKafkaListenerContainerFactory;
import org.springframework.kafka.config.TopicBuilder;
import org.springframework.kafka.core.ConsumerFactory;
import org.springframework.kafka.core.DefaultKafkaConsumerFactory;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.kafka.listener.ContainerProperties;
import org.springframework.kafka.listener.DeadLetterPublishingRecoverer;
import org.springframework.kafka.listener.DefaultErrorHandler;
import org.springframework.util.backoff.FixedBackOff;
import org.apache.kafka.clients.admin.NewTopic;

import java.util.HashMap;
import java.util.Map;

@Configuration
public class KafkaConsumerConfig {

    @Value("${spring.kafka.bootstrap-servers}")
    private String bootstrapServers;

    @Bean
    public ConsumerFactory<String, String> consumerFactory() {
        Map<String, Object> props = new HashMap<>();
        props.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, bootstrapServers);
        props.put(ConsumerConfig.GROUP_ID_CONFIG, "order-sync-group");
        props.put(ConsumerConfig.KEY_DESERIALIZER_CLASS_CONFIG, StringDeserializer.class);
        props.put(ConsumerConfig.VALUE_DESERIALIZER_CLASS_CONFIG, StringDeserializer.class);
        props.put(ConsumerConfig.AUTO_OFFSET_RESET_CONFIG, "earliest");
        props.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, false);
        props.put(ConsumerConfig.MAX_POLL_RECORDS_CONFIG, 200);
        props.put(ConsumerConfig.MAX_POLL_INTERVAL_MS_CONFIG, 300_000);
        props.put(ConsumerConfig.FETCH_MAX_WAIT_MS_CONFIG, 500);
        return new DefaultKafkaConsumerFactory<>(props);
    }

    @Bean
    public ConcurrentKafkaListenerContainerFactory<String, String> kafkaListenerContainerFactory(
            ConsumerFactory<String, String> consumerFactory,
            KafkaTemplate<String, String> kafkaTemplate) {
        ConcurrentKafkaListenerContainerFactory<String, String> factory =
                new ConcurrentKafkaListenerContainerFactory<>();
        factory.setConsumerFactory(consumerFactory);
        factory.setBatchListener(true);
        factory.setConcurrency(3);
        factory.getContainerProperties().setAckMode(ContainerProperties.AckMode.MANUAL_IMMEDIATE);
        factory.getContainerProperties().setPollTimeout(3000);

        DeadLetterPublishingRecoverer recoverer = new DeadLetterPublishingRecoverer(kafkaTemplate);
        DefaultErrorHandler errorHandler = new DefaultErrorHandler(recoverer, new FixedBackOff(1000L, 3L));
        errorHandler.addNotRetryableExceptions(IllegalArgumentException.class);
        factory.setCommonErrorHandler(errorHandler);

        return factory;
    }

    @Bean
    public NewTopic orderEventsTopic() {
        return TopicBuilder.name("order-events")
                .partitions(3)
                .replicas(1)
                .build();
    }
}
```

几个关键点：

- `setBatchListener(true)`：监听方法收到的是一次 poll 的全部记录，不再是一条一条回调。
- `MANUAL_IMMEDIATE`：业务处理完调 `ack.acknowledge()`，位移立刻提交。不做手动提交，处理失败重启后消息就丢了。
- `FixedBackOff(1000L, 3L)`：失败后隔 1 秒重试，最多 3 次。4 次都失败，交给死信队列。
- `addNotRetryableExceptions`：参数不合法这种错重试一万次也没用，直接进死信，别占着分区。
- 死信主题默认叫 `order-events.DLT`，Kafka 会自动建。

`setConcurrency(3)` 和分区数对齐。如果后面扩到 6 个分区，这里改成 6，再起第二个实例，才叫水平扩容。

### 6. 生产者接口

```java
package com.example.kafkalag.web;

import com.example.kafkalag.domain.OrderEvent;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

@RestController
@RequestMapping("/orders")
public class OrderController {

    private static final String TOPIC = "order-events";

    private final KafkaTemplate<String, String> kafkaTemplate;

    public OrderController(KafkaTemplate<String, String> kafkaTemplate) {
        this.kafkaTemplate = kafkaTemplate;
    }

    @PostMapping("/{orderId}/status")
    public Map<String, Object> updateStatus(@PathVariable String orderId,
                                            @RequestParam String status) {
        kafkaTemplate.send(TOPIC, orderId, new OrderEvent(orderId, status).toMessage());
        return Map.of("orderId", orderId, "status", status, "result", "accepted");
    }

    @PostMapping("/mock")
    public Map<String, Object> mock(@RequestParam(defaultValue = "10000") int count) {
        for (int i = 0; i < count; i++) {
            String orderId = "ORD-" + (i % 5000);
            kafkaTemplate.send(TOPIC, orderId, new OrderEvent(orderId, "PAID").toMessage());
        }
        return Map.of("sent", count);
    }
}
```

`send` 是异步的，返回 `CompletableFuture`。这里故意不阻塞等结果，模拟真实下单接口「发出去就算成功」的写法。真要保证不丢，得在回调里处理失败，或者用事务消息，那是另一个话题。

key 用 `orderId`，保证同一笔订单的状态变更进同一个分区，顺序不会乱。

### 7. 批量消费者

```java
package com.example.kafkalag.consumer;

import com.example.kafkalag.domain.OrderEvent;
import com.example.kafkalag.repository.OrderStatusRepository;
import org.apache.kafka.clients.consumer.ConsumerRecord;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.kafka.support.Acknowledgment;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.List;

@Component
public class OrderSyncConsumer {

    private static final Logger log = LoggerFactory.getLogger(OrderSyncConsumer.class);

    private final OrderStatusRepository repository;

    public OrderSyncConsumer(OrderStatusRepository repository) {
        this.repository = repository;
    }

    @KafkaListener(topics = "order-events", groupId = "order-sync-group")
    public void onMessages(List<ConsumerRecord<String, String>> records, Acknowledgment ack) {
        if (records.isEmpty()) {
            ack.acknowledge();
            return;
        }

        long start = System.currentTimeMillis();
        List<OrderEvent> batch = new ArrayList<>(records.size());
        for (ConsumerRecord<String, String> record : records) {
            OrderEvent event = OrderEvent.parse(record.value());
            if (event != null) {
                batch.add(event);
            }
        }

        repository.saveAll(batch);
        ack.acknowledge();

        log.info("分区 {} 处理 {} 条，耗时 {} ms",
                records.get(0).partition(), batch.size(), System.currentTimeMillis() - start);
    }
}
```

整批处理完再 ack。顺序不能反：先 ack 后处理，进程这时候挂了，这批消息就永远丢了。

`OrderEvent.parse` 返回 null 的消息直接跳过，不进死信。要不要进死信看业务，脏数据本身可能值得单独留一份。

### 8. 落库（示例用内存，换成 JdbcTemplate 即可）

```java
package com.example.kafkalag.repository;

import com.example.kafkalag.domain.OrderEvent;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

@Repository
public class OrderStatusRepository {

    private static final Logger log = LoggerFactory.getLogger(OrderStatusRepository.class);

    private final Map<String, String> store = new ConcurrentHashMap<>();

    public void saveAll(List<OrderEvent> events) {
        if (events.isEmpty()) {
            return;
        }
        for (OrderEvent event : events) {
            store.put(event.orderId(), event.status());
        }
        try {
            Thread.sleep(20);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        log.info("批量落库 {} 条，当前共 {} 笔订单", events.size(), store.size());
    }
}
```

生产环境把 `saveAll` 换成 `JdbcTemplate.batchUpdate`，一条 SQL 更新一批，或者用 MyBatis 的 `ExecutorType.BATCH`。思路一样：一次网络往返干完一批活。

那段 `Thread.sleep(20)` 是模拟一次批量写库的耗时。没有它，本地测出来的吞吐会好看得离谱。

### 9. 积压监控

```java
package com.example.kafkalag.monitor;

import org.apache.kafka.clients.admin.AdminClient;
import org.apache.kafka.clients.admin.AdminClientConfig;
import org.apache.kafka.clients.admin.ListOffsetsResult;
import org.apache.kafka.clients.admin.OffsetSpec;
import org.apache.kafka.clients.consumer.OffsetAndMetadata;
import org.apache.kafka.common.TopicPartition;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.util.HashMap;
import java.util.Map;
import java.util.Properties;
import java.util.concurrent.TimeUnit;

@Component
public class ConsumerLagMonitor {

    private static final Logger log = LoggerFactory.getLogger(ConsumerLagMonitor.class);
    private static final String GROUP_ID = "order-sync-group";

    @Value("${spring.kafka.bootstrap-servers}")
    private String bootstrapServers;

    @Scheduled(fixedDelay = 30_000, initialDelay = 10_000)
    public void reportLag() {
        Properties props = new Properties();
        props.put(AdminClientConfig.BOOTSTRAP_SERVERS_CONFIG, bootstrapServers);
        props.put(AdminClientConfig.REQUEST_TIMEOUT_MS_CONFIG, 5000);

        try (AdminClient admin = AdminClient.create(props)) {
            Map<TopicPartition, OffsetAndMetadata> committed = admin
                    .listConsumerGroupOffsets(GROUP_ID)
                    .partitionsToOffsetAndMetadata()
                    .get(5, TimeUnit.SECONDS);

            if (committed.isEmpty()) {
                log.warn("消费组 {} 还没有提交过位移", GROUP_ID);
                return;
            }

            Map<TopicPartition, OffsetSpec> query = new HashMap<>();
            committed.keySet().forEach(tp -> query.put(tp, OffsetSpec.latest()));

            Map<TopicPartition, ListOffsetsResult.ListOffsetsResultInfo> endOffsets = admin
                    .listOffsets(query)
                    .all()
                    .get(5, TimeUnit.SECONDS);

            long total = 0;
            for (Map.Entry<TopicPartition, OffsetAndMetadata> entry : committed.entrySet()) {
                TopicPartition tp = entry.getKey();
                long end = endOffsets.get(tp).offset();
                long current = entry.getValue() == null ? 0L : entry.getValue().offset();
                long lag = Math.max(0, end - current);
                total += lag;
                log.info("分区 {} 已提交 {} 最新 {} 积压 {}", tp.partition(), current, end, lag);
            }
            log.info("消费组 {} 总积压 {} 条", GROUP_ID, total);
        } catch (Exception e) {
            log.warn("查询消费积压失败：{}", e.getMessage());
        }
    }
}
```

每 30 秒打一次每个分区的 lag，直接进日志系统就能配告警。比只看总量有用得多，单分区飙升基本就是 key 倾斜或者某个消费者卡住了。

跑起来之后，调 `POST /orders/mock?count=20000` 灌一批，看日志里的处理耗时和总积压变化。再把 `MAX_POLL_RECORDS_CONFIG` 改成 1 对比，差距会很直观。

## 四、踩过的坑，和几条硬规矩

结论：Kafka 积压优化里，最常见的错误不是参数没调对，而是把「吞吐问题」当成了「容量问题」。

**坑一：消费者加到比分区还多。** 前面说过了，多出来的消费者分不到分区。扩消费者之前先看分区数，不够就先扩分区。扩分区要注意：按 key 哈希的消息会重新分布，顺序只保证分区内，历史消息不受影响，新消息可能落到新分区。顺序敏感的业务，扩分区要挑低峰期。

**坑二：把 `max.poll.records` 拉到 5000。** 一批 5000 条，每条调一次 200 毫秒的接口，一批要 16 分钟，而 `max.poll.interval.ms` 只有 5 分钟。结果就是无限 rebalance。这个坑我在一个物流项目里亲眼见过，监控上消费速率是 0，日志里全是重平衡。后来把批量降到 200，同时把逐条 HTTP 调用改成批量接口，才稳住。

**坑三：失败消息无限重试。** 默认错误处理器会一直重试，一条脏数据能把整个分区堵死。一定要配 `DefaultErrorHandler`，限定重试次数，最后进死信队列。死信也要有人看，不然只是把问题挪了个地方。

**坑四：批量监听器里逐条 ack。** 批量模式下 `Acknowledgment` 是整批的，调一次提交的是当前批次最后一条的位移。有人以为可以循环里逐条提交，实际上做不到。要精确控制，得用 `ConsumerSeekAware` 或者改成单条监听。

**坑五：只看总 lag，不看分区。** 3 个分区里 2 个 lag 是 0，1 个是 80 万，这说明消息 key 分布不均，或者那个分区的消费者卡住了。总 lag 会把这个信号平均掉。

几条我自己的规矩：

- 消费者实例数不超过分区数，`concurrency` 乘以实例数也别超过
- 单批处理时间控制在 `max.poll.interval.ms` 的三分之一以内
- 所有消费逻辑必须幂等，重复消费是常态不是异常
- 死信队列配监控，进死信要报警
- 上线前压测，压的是「带下游依赖的完整链路」，不是空跑

## 五、几种提速方案怎么选

结论：先扩分区解决并行度，再批量处理摊薄开销，最后才考虑异步化和业务降级。

| 方案 | 适用场景 | 代价 | 效果 |
| --- | --- | --- | --- |
| 增加分区 | 分区数明显不够，消费者有空转 | 需要评估顺序和 key 分布 | 线性提升并行度 |
| 提高并发线程 | 分区数够，但线程没开满 | 线程多了 GC 和上下文切换上升 | 接近分区数上限 |
| 批量消费 + 批量落库 | 单条处理里网络往返占比高 | 失败重试粒度变粗 | 吞吐提升最明显 |
| 异步处理 | 下游接口慢且可最终一致 | 复杂度上升，要自己管位移 | 拉取和处理解耦 |
| 业务降级 | 大促峰值，非核心链路 | 功能受损 | 保核心链路 |

我在 4 核 8G 的测试机上压过一组数，只说明趋势：单条处理 200 毫秒时，单线程大约 5 条/秒；改成 200 条一批、批量落库 20 毫秒后，单线程能到 2000 条/秒以上。提升主要来自把 200 次网络往返压成了 1 次。下游接口本身的耗时，批量解决不了，那得靠异步或者让下游提供批量接口。

选型的顺序别搞反：先看分区，再看批量，最后才动异步。异步是最后一张牌，打出去容易，收回来难。

## 六、总结

Kafka 消费积压，先算一笔账：生产速率多少，单条处理多久，分区几个。三个数一摆，瓶颈在哪基本就清楚了。

分区数决定并行上限，`max.poll.interval.ms` 决定单批处理的时间红线，批量处理决定网络开销能被摊多薄。这三个东西互相牵制，调一个必须看另外两个。

监控别只盯总 lag。按分区打点，配上消费速率，才能分清是「处理慢」还是「在重平衡」。真到了要加机器的那一步，先确认分区够不够，不然钱花了，lag 还在。

代码里那套批量消费加死信队列的配置，可以直接抄。落库换成 `batchUpdate`，监控接进 Prometheus，就是一套能上生产的最小闭环。

文 / 会编程的吕洞宾

## 参考资料

- [Apache Kafka Documentation - Consumer Configs](https://kafka.apache.org/documentation/#consumerconfigs)
- [Apache Kafka Documentation - Design](https://kafka.apache.org/documentation/#design)
- [Spring for Apache Kafka Reference](https://docs.spring.io/spring-kafka/reference/)
