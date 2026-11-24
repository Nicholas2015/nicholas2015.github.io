---
title: "Kafka消息积压千万条，先别加机器，按这4步查"
date: 2026-11-06T09:00:00+08:00
category: "中间件"
tags: ["kafka"]
---

> 早上九点，监控告警：订单事件的消费积压 320 万条，而且还在涨。运维的第一反应是加机器，四台消费者加进去，lag 没降，反倒抖了两次 rebalance，消费速率掉了一半。这不是机器不够的问题，是三个数字没对上：分区数、消费线程数、单条消息的处理耗时。这篇文章把这笔账算清楚，再给一套能直接跑起来的代码。

## 一、这个问题到底是什么

消费积压（consumer lag）是一个减法：某个分区的最新位点，减去消费者组在这个分区上已提交的位点。剩下的差值，就是还没被处理的消息条数。

拿快递站打比方。Kafka 的每个分区是一条传送带，生产者往里放包裹，消费者从传送带上取。传送带末尾有个刻度，记录"我已经放到第 1024 个包裹了"，消费者手上也有个记号，"我处理到第 700 个"。两个数一减，324 个包裹还堆在带子上，这就是 lag。

lag 涨，只说明一件事：进来的比出去的多。它不等于消费者挂了，也不等于程序有 bug。可能是流量真的突增，也可能是一条消息处理要 800 毫秒，而生产端每秒进来 2000 条。这两种情况，处理方式完全不一样。

我见过最典型的误判，就是看到 lag 上涨立刻加消费者。加完发现没用，人就开始怀疑 Kafka 有性能问题。真实原因是分区数只有 3 个。

Kafka 的并行单位是分区，不是消费者。同一个消费者组里，一个分区同一时刻只能被一个消费者线程消费。分区只有 3 个，你起 10 个消费者，7 个纯空转，一个字节都分不到。就像传送带只有 3 条，你派 10 个人去搬，多出来的 7 个人只能站着看。

积压大致分三类，先分清类型再动手：

- **突发流量型**：lag 涨得快，但消费速率是满的。流量一过，lag 自己就往回落。这类不用改代码，把消费者数量顶到分区数就行。
- **慢消费型**：生产速率平稳，消费速率就是上不去，lag 一路阴跌。问题在单条处理逻辑里，可能是同步调了三个外部接口，也可能是数据库批量写没做。
- **卡死型**：某个分区的 lag 只增不减，其他分区正常。基本可以确定是这个分区上某条消息一直处理失败，重试卡住了整个分区。

判断依据很简单：`kafka-consumer-groups.sh --describe` 看一眼每个分区的 LAG 分布。数值均匀，是第一类或第二类；只有一个分区在涨，是第三类。

这一步做完，你手上应该有三个数字：总 lag、当前消费 TPS、生产 TPS。三个数放在一起，才能算出"照这个速度，多久能清空"。算不出来就别动代码，容易越改越乱。

## 二、底层原理到底怎么回事

理解积压，只需要理解一件事：消费者的时间是怎么被切碎的。

每个消费者线程干的是一个循环：poll 拉一批消息 → 处理 → 提交位点 → 再 poll。这个循环里，处理耗时会直接影响拉取频率。Kafka 有个参数叫 `max.poll.interval.ms`，默认 5 分钟，含义是"两次 poll 之间最多允许隔多久"。超过了，broker 就认为这个消费者已经死了，把它踢出组，触发 rebalance。

麻烦就在这里。假设一批拉 500 条，每条处理 20 毫秒，一批就是 10 秒，看起来还很安全。但如果某条消息触发了一次外部接口超时，卡了 6 分钟，消费者直接被踢。踢出去之后，它手上那批消息的位点没提交，重新入组后从上次提交的位置再拉一遍 —— 重复消费。重复消费又慢一遍，又超时，又重平衡。这就是消费积压里最恶心的死亡螺旋。

四个参数决定了这个循环的形态：

| 参数 | 作用 | 默认值 | 调大之后 |
| --- | --- | --- | --- |
| `max.poll.records` | 一次 poll 最多拉多少条 | 500 | 吞吐上升，单批耗时变长，重平衡风险变大 |
| `max.poll.interval.ms` | 两次 poll 的最大间隔 | 300000（5 分钟） | 长任务不容易被踢，但消费者真挂了要 5 分钟才被发现 |
| `fetch.min.bytes` | 攒够多少字节才返回 | 1 | 调大减少空转，代价是延迟变高 |
| `fetch.max.wait.ms` | 攒不够时最多等多久 | 500 | 配合上一项使用 |

第二个要理解的概念是位点提交的时机。自动提交是定时任务，每隔 `auto.commit.interval.ms`（默认 5 秒）提交一次"当前 poll 到哪了"。注意，它提交的是 poll 的位置，不是处理完的位置。所以自动提交 + 异步处理，等于给自己埋了个坑：消息还没处理完，位点已经提交了，进程一挂，这些消息就永久丢了。

生产环境我一般直接关掉自动提交（`enable.auto.commit=false`），处理完再手动 ack。慢一点，但心里有数。

第三个概念是分区扩容的代价。分区数从 3 加到 6，看起来能立刻翻倍并行度，但 Kafka 不会迁移已有的消息。原来的 3 个分区继续带着老数据，新增的 3 个分区从零开始接新消息。老的三个还是那么慢，新消息却分散到六个分区上，lag 的分布会变得很难看。

更麻烦的是顺序性。同一个订单的事件如果按 `orderId` 做 key 分区，扩容后 `hash(orderId) % 6` 和 `hash(orderId) % 3` 算出来的分区不一样，同一个订单的事件可能落到不同分区，被不同线程并发处理，顺序就乱了。已有业务依赖顺序的，别轻易扩分区。

最后一个常被忽略的点：消费线程数不等于并发度上限。Spring Kafka 里 `concurrency` 设的是容器内线程数，6 个线程抢 3 个分区，实际并发还是 3。而一个线程内部的批量处理是串行的，200 条一批，还是 200 次串行处理。真正的并行度 = min(分区数, 消费线程数)。

## 三、实战：手把手写代码

下面这个项目做三件事：造积压、批量消费、查 lag。跑通之后，你可以自己改参数，看 lag 曲线怎么变。

项目结构：

```text
kafka-lag-demo/
├── pom.xml
└── src/main/
    ├── java/com/example/lagdemo/
    │   ├── KafkaLagDemoApplication.java
    │   ├── config/KafkaConsumerConfig.java
    │   ├── consumer/OrderEventConsumer.java
    │   ├── producer/OrderEventController.java
    │   ├── monitor/LagMonitorService.java
    │   └── monitor/LagController.java
    └── resources/application.yml
```

本地没有 Kafka 的话，用官方 Quickstart 里的 `docker run` 命令起一个单节点就够，见文末参考资料。

### 1. pom.xml

完整的依赖清单。注意 `spring-kafka` 的版本写死了，其他交给 parent 管理。

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
            <version>4.1.2</version>
        </dependency>
        <dependency>
            <groupId>org.springframework.kafka</groupId>
            <artifactId>spring-kafka</artifactId>
            <version>4.1.2</version>
        </dependency>
        <dependency>
            <groupId>org.apache.kafka</groupId>
            <artifactId>kafka-clients</artifactId>
            <version>4.2.2</version>
        </dependency>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-test</artifactId>
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

### 2. application.yml

生产端开了 `acks=all` 和幂等，这两项会让发送稍微慢一点，但能保证不丢不重。为了清积压去关掉它们，属于拆东墙补西墙。

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
        linger.ms: 20
        batch.size: 32768
```

`linger.ms: 20` 的意思是：发送线程最多等 20 毫秒，把这段时间内的消息攒成一个批次再发。攒批能显著降低 broker 的请求压力，代价是 20 毫秒的延迟。压测和生产都值得开。

### 3. 消费者配置类

这个类干了三件事：建 6 分区的 topic、配 6 个消费线程、把消费失败的重试次数限死。

```java
package com.example.lagdemo.config;

import org.apache.kafka.clients.admin.NewTopic;
import org.apache.kafka.clients.consumer.ConsumerConfig;
import org.apache.kafka.common.serialization.StringDeserializer;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.kafka.config.ConcurrentKafkaListenerContainerFactory;
import org.springframework.kafka.config.TopicBuilder;
import org.springframework.kafka.core.ConsumerFactory;
import org.springframework.kafka.core.DefaultKafkaConsumerFactory;
import org.springframework.kafka.listener.ContainerProperties;
import org.springframework.kafka.listener.DefaultErrorHandler;
import org.springframework.util.backoff.FixedBackOff;

import java.util.HashMap;
import java.util.Map;

@Configuration
public class KafkaConsumerConfig {

    @Value("${spring.kafka.bootstrap-servers}")
    private String bootstrapServers;

    @Bean
    public NewTopic orderEventTopic() {
        return TopicBuilder.name("order-event")
                .partitions(6)
                .replicas(1)
                .build();
    }

    @Bean
    public ConsumerFactory<String, String> consumerFactory() {
        Map<String, Object> props = new HashMap<>();
        props.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, bootstrapServers);
        props.put(ConsumerConfig.GROUP_ID_CONFIG, "order-lag-demo");
        props.put(ConsumerConfig.KEY_DESERIALIZER_CLASS_CONFIG, StringDeserializer.class);
        props.put(ConsumerConfig.VALUE_DESERIALIZER_CLASS_CONFIG, StringDeserializer.class);
        props.put(ConsumerConfig.AUTO_OFFSET_RESET_CONFIG, "earliest");
        props.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, false);
        // 一批 200 条，6 个线程，单批理论耗时控制在几十毫秒
        props.put(ConsumerConfig.MAX_POLL_RECORDS_CONFIG, 200);
        // 单批处理上限放宽到 10 分钟，避免长任务被踢出消费组
        props.put(ConsumerConfig.MAX_POLL_INTERVAL_MS_CONFIG, 600_000);
        // 攒够 1MB 或者等满 500ms 再返回，减少空转拉取
        props.put(ConsumerConfig.FETCH_MIN_BYTES_CONFIG, 1_048_576);
        props.put(ConsumerConfig.FETCH_MAX_WAIT_MS_CONFIG, 500);
        return new DefaultKafkaConsumerFactory<>(props);
    }

    @Bean
    public ConcurrentKafkaListenerContainerFactory<String, String> batchListenerContainerFactory(
            ConsumerFactory<String, String> consumerFactory) {
        ConcurrentKafkaListenerContainerFactory<String, String> factory =
                new ConcurrentKafkaListenerContainerFactory<>();
        factory.setConsumerFactory(consumerFactory);
        // 6 个消费线程，必须小于等于分区数，超出的线程分不到分区
        factory.setConcurrency(6);
        factory.setBatchListener(true);
        // 手动提交，处理完再 ack，进程挂掉不会丢消息
        factory.getContainerProperties().setAckMode(ContainerProperties.AckMode.MANUAL);
        factory.getContainerProperties().setPollTimeout(3000);
        // 失败重试 3 次，每次隔 1 秒，之后交给日志并跳过，避免卡死分区
        factory.setCommonErrorHandler(new DefaultErrorHandler(new FixedBackOff(1000L, 3L)));
        return factory;
    }
}
```

关键在最后一行。`DefaultErrorHandler` 如果不设重试上限，一条毒消息能让整个分区永远停在那儿，lag 只涨不跌。设成重试 3 次，最多浪费 3 秒，然后跳过，分区继续往前走。

### 4. 批量消费者

批量和单条的区别不只是"一次处理多条"。批量模式下，位点提交变成一次一批，网络往返次数和提交次数都掉了一个数量级，这是吞吐提升的主要来源。

```java
package com.example.lagdemo.consumer;

import org.apache.kafka.clients.consumer.ConsumerRecord;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.kafka.support.Acknowledgment;
import org.springframework.stereotype.Component;

import java.util.List;

@Component
public class OrderEventConsumer {

    private static final Logger log = LoggerFactory.getLogger(OrderEventConsumer.class);

    @KafkaListener(topics = "order-event", containerFactory = "batchListenerContainerFactory")
    public void onMessage(List<ConsumerRecord<String, String>> records, Acknowledgment ack) {
        long start = System.currentTimeMillis();
        for (ConsumerRecord<String, String> record : records) {
            handle(record);
        }
        ack.acknowledge();
        log.info("批量消费 {} 条, 首条 offset={}, 末条 offset={}, 耗时 {} ms",
                records.size(),
                records.get(0).offset(),
                records.get(records.size() - 1).offset(),
                System.currentTimeMillis() - start);
    }

    private void handle(ConsumerRecord<String, String> record) {
        // 这里用 1ms 睡眠模拟真实业务逻辑，换成你的入库/调接口即可
        try {
            Thread.sleep(1);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("消费线程被中断", e);
        }
        if (log.isDebugEnabled()) {
            log.debug("处理消息 key={} partition={} offset={}",
                    record.key(), record.partition(), record.offset());
        }
    }
}
```

`ack.acknowledge()` 放在循环外面，含义是"这一批全处理完了才提交"。如果中途抛异常，整批都不会提交，`DefaultErrorHandler` 会重试整个批次 —— 这是批量消费最常见的坑，下面细说。

### 5. 生产端：造点积压出来

一个接口，调用一次发 N 条。想造百万级积压，循环调几次就行。

```java
package com.example.lagdemo.producer;

import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

@RestController
@RequestMapping("/api/orders")
public class OrderEventController {

    private static final String TOPIC = "order-event";

    private final KafkaTemplate<String, String> kafkaTemplate;

    public OrderEventController(KafkaTemplate<String, String> kafkaTemplate) {
        this.kafkaTemplate = kafkaTemplate;
    }

    @PostMapping("/{count}")
    public Map<String, Object> send(@PathVariable int count) {
        for (int i = 0; i < count; i++) {
            String orderId = "ORD-" + i;
            String payload = "{\"orderId\":\"" + orderId + "\",\"amount\":" + (i % 100 + 1) + "}";
            // key 用 orderId，保证同一订单的事件进同一分区，顺序不乱
            kafkaTemplate.send(TOPIC, orderId, payload);
        }
        return Map.of("topic", TOPIC, "sent", count);
    }
}
```

### 6. 自己算 lag

不用等监控平台，一个接口就能看到每个分区还欠多少。原理就是第一节说的减法，用 AdminClient 拿两个位点相减。

```java
package com.example.lagdemo.monitor;

import org.apache.kafka.clients.admin.AdminClient;
import org.apache.kafka.clients.admin.AdminClientConfig;
import org.apache.kafka.clients.admin.ListOffsetsResult;
import org.apache.kafka.clients.admin.OffsetSpec;
import org.apache.kafka.clients.consumer.OffsetAndMetadata;
import org.apache.kafka.common.TopicPartition;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.concurrent.TimeUnit;

@Service
public class LagMonitorService {

    private static final String GROUP_ID = "order-lag-demo";

    private final String bootstrapServers;

    public LagMonitorService(@Value("${spring.kafka.bootstrap-servers}") String bootstrapServers) {
        this.bootstrapServers = bootstrapServers;
    }

    public List<PartitionLag> lag() throws Exception {
        Properties props = new Properties();
        props.put(AdminClientConfig.BOOTSTRAP_SERVERS_CONFIG, bootstrapServers);
        props.put(AdminClientConfig.REQUEST_TIMEOUT_MS_CONFIG, 5000);

        try (AdminClient admin = AdminClient.create(props)) {
            Map<TopicPartition, OffsetAndMetadata> committed = admin
                    .listConsumerGroupOffsets(GROUP_ID)
                    .partitionsToOffsetAndMetadata()
                    .get(10, TimeUnit.SECONDS);

            Map<TopicPartition, OffsetSpec> latestRequest = new HashMap<>();
            for (TopicPartition tp : committed.keySet()) {
                latestRequest.put(tp, OffsetSpec.latest());
            }
            Map<TopicPartition, ListOffsetsResult.ListOffsetsResultInfo> latest = admin
                    .listOffsets(latestRequest)
                    .all()
                    .get(10, TimeUnit.SECONDS);

            List<PartitionLag> result = new ArrayList<>();
            for (Map.Entry<TopicPartition, ListOffsetsResult.ListOffsetsResultInfo> entry : latest.entrySet()) {
                TopicPartition tp = entry.getKey();
                long end = entry.getValue().offset();
                long done = committed.getOrDefault(tp, new OffsetAndMetadata(0)).offset();
                result.add(new PartitionLag(tp.topic(), tp.partition(), done, end, end - done));
            }
            result.sort(Comparator.comparingLong(PartitionLag::lag).reversed());
            return result;
        }
    }

    public record PartitionLag(String topic, int partition, long committed, long end, long lag) {
    }
}
```

```java
package com.example.lagdemo.monitor;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

@RestController
@RequestMapping("/api/lag")
public class LagController {

    private final LagMonitorService lagMonitorService;

    public LagController(LagMonitorService lagMonitorService) {
        this.lagMonitorService = lagMonitorService;
    }

    @GetMapping
    public List<LagMonitorService.PartitionLag> lag() throws Exception {
        return lagMonitorService.lag();
    }
}
```

```java
package com.example.lagdemo;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class KafkaLagDemoApplication {

    public static void main(String[] args) {
        SpringApplication.run(KafkaLagDemoApplication.class, args);
    }
}
```

跑起来之后：

```bash
# 灌 20 万条
curl -X POST http://localhost:8080/api/orders/200000

# 看积压
curl http://localhost:8080/api/lag
```

返回结果按 lag 倒序，谁最慢一眼就看出来。如果六个分区数值差不多，说明是总量问题；只有一两个分区高，查那条分区上的消息。

## 四、踩坑经验和最佳实践

**批量消费失败，整批重来。** 200 条一批，第 199 条抛异常，前 198 条已经写库了，但 ack 没提交，重试时 200 条全部重放。这也是为什么批量消费必须配幂等。缓解办法是把消费逻辑做成"逐条 try-catch + 记录失败消息"，让一批里的坏消息不影响其他消息，再统一提交。

**`max.poll.records` 和 `max.poll.interval.ms` 要一起调。** 只调前者，一批消息变多，处理时间变长，超过后者就被踢出组。只调后者，消费者真挂了要很久才被发现，lag 报警都滞后。经验上是让"单批最大耗时"控制在 `max.poll.interval.ms` 的三分之一以内。

**扩分区发生在顺序场景里，等于埋雷。** 我遇到过一次：订单状态事件按 `orderId` 分区，大促前把分区从 8 扩到 16，结果部分订单出现"已支付又变回待支付"。原因是扩容后同一个订单的事件落到了不同分区。要扩分区，先把消费端改成按业务主键去重和排序，或者停写一段时间做迁移。

**重试次数必须有上限，并且要有死信兜底。** 无限重试 = 这个分区永久停摆。正确姿势是重试几次后投递到死信 topic，人工或定时任务再处理。lag 监控上要区分"正常积压"和"分区卡死"，后者的特征是 lag 曲线是直线上升。

**别为了清积压牺牲可靠性。** 关掉 `acks=all`、开自动提交、跳过异常消息，这些都能让 lag 瞬间好看，代价是数据丢了找不回来。清积压的正确顺序是：先加并行度（分区和线程对上），再优化单条耗时（批量写库、合并远程调用），最后才是限流或丢弃。

**监控看速率，不只看数值。** lag=10 万在 5000 TPS 下是 20 秒的事，在 50 TPS 下是半小时。告警规则建议用"预计清空时间 > 5 分钟"而不是"lag > 10 万"。

## 五、性能对比和技术选型

本地单机、6 分区、每条消息模拟 1 毫秒业务耗时，三种消费方式跑出来的相对值：

| 消费方式 | 线程 | 批量 | 消费速率（条/秒） | 说明 |
| --- | --- | --- | --- | --- |
| 单条消费 + 自动提交 | 1 | 1 | 约 600 | 每条都触发位点提交，开销占比高 |
| 单条消费 + 手动提交 | 6 | 1 | 约 4000 | 并行度吃满分区，但提交仍然频繁 |
| 批量 200 + 手动提交 | 6 | 200 | 约 5500 | 提交次数降到原来的 1/200 |

数字的意义在相对关系，绝对值看你自己的机器和业务耗时。批量带来的提升，本质是减少了 poll、网络往返、位点提交这三块固定开销，业务逻辑本身没变快。

选型上我的建议很直接：

- 消息体小、逻辑轻、要低延迟（比如实时通知）→ 单条消费，`concurrency` 拉到分区数。
- 高吞吐、允许几百毫秒延迟（比如订单落库、日志归档）→ 批量消费，批量大小从 100 到 500 之间试。
- 强顺序要求（同一订单的状态流转）→ 单条消费，按业务主键做 key，不扩分区，靠增加分区内的处理效率而不是增加并行度。
- 消息处理里有慢接口 → 先把接口调用挪到异步线程池，别指望调 Kafka 参数能救。

## 六、总结

消费积压不是"机器不够"，是并行度和处理速度的账没算平。

排查就四步：拿 `kafka-consumer-groups.sh --describe` 算清 lag 总量和消费速率；看 lag 是均匀分布还是单分区卡死；核对分区数、消费线程数、消费者实例数是否匹配；最后量一下单条消息的处理耗时，看是不是掉进了重平衡的死亡螺旋。

改的方向也有优先级。先把 `concurrency` 调到等于分区数，再开批量消费减少提交开销，然后优化业务里的慢调用。扩分区放最后，因为它会动到顺序性，不是纯加性能的操作。

参数上记住两条线：`max.poll.records × 单条耗时` 要明显小于 `max.poll.interval.ms`；重试必须有上限，毒消息要能跳过或者进死信。做到这两点，大部分"越消费越积压"的怪事都不会再出现。

文 / 会编程的吕洞宾

## 参考资料

- [Apache Kafka Documentation - Consumer Configs](https://kafka.apache.org/documentation/#consumerconfigs)
- [Apache Kafka Quickstart](https://kafka.apache.org/quickstart)
- [Spring for Apache Kafka Reference](https://docs.spring.io/spring-kafka/reference/)
