---
title: "Kafka 重平衡风暴实战：消费卡顿排查与调优"
date: 2026-10-05T09:00:00+08:00
category: "中间件"
tags: ["kafka"]
---

> 半夜被报警叫醒：订单消费延迟从 3 秒涨到 8 分钟，lag 一路飙到几十万，日志里刷屏的 "Rebalancing" 告诉你，消费组又在重平衡了。更气人的是，运维加了 4 台消费者，lag 反而涨得更快。这篇文章把 Kafka 重平衡从头讲清楚：它为什么发生、怎么定位、Spring Boot 里怎么改代码和配置，以及 Kafka 4.x 的新协议到底能帮多少忙。看完你能自己复现、自己排查、自己调优。

**摘要**：Kafka 消费组频繁重平衡会让消费停滞、消息重复、lag 飙升。本文用大白话讲清重平衡背后的心跳与超时机制，给出 Spring Boot + Spring Kafka 的完整可运行示例，对比经典协议与 KIP-848 新协议的区别，并整理出一份能直接落地的调优清单。

## 一、Kafka 重平衡到底是什么，为什么它一来消费就停

Kafka 重平衡（Rebalance）是消费组内所有消费者重新瓜分分区的过程，本质是一次"集体停工"。

先把几个词用大白话说清楚，后面才好展开。

- **主题（Topic）**：一类消息的集合，比如 order-topic 装的是订单事件。
- **分区（Partition）**：主题被切成好几段，每段是一个有序队列，也是 Kafka 并行读写的最小单位。
- **消费组（Consumer Group）**：一组消费者共同消费同一个主题。同一个组里，一个分区只会被一个消费者消费；不同组之间互不影响。
- **重平衡**：分区归属的重新分配。组内成员数变了、订阅的主题变了，Kafka 就要重新分一次。

关键在于"集体停工"这四个字。经典重平衡是"急切的"（eager）：一旦触发，所有消费者先把手里的分区全部交还，谁也别消费，等组协调器（Group Coordinator）重新算好方案，大家再重新领。这段空窗期，消费是停的。

线上症状通常长这样：

- lag（积压量）曲线突然竖起来一根针，消费几乎归零。
- 日志反复刷 "Revoking previously assigned partitions"、"re-joining group"、"Successfully joined group"。
- 消息重复消费。分区原来在 A 手里，处理到一半重平衡交给了 B，B 从 A 上次提交的 offset 开始读，中间那段就重复了。
- 消费者实例反复上下线时，一场重平衡刚结束，下一场又来，形成"重平衡风暴"。

说一个我碰过的真实场景。某电商的订单履约服务，6 个消费者消费 24 个分区。大促时把并发从 6 调到 12，指望吞吐翻倍，结果 lag 不降反升。原因是新实例启动慢，超过了几十秒的会话超时，被协调器判死踢出组，触发重平衡；老实例刚稳定，新成员又被踢，来回震荡了一整晚。扩容把系统搞得更慢，就是这么来的。

所以重平衡要分两层看：偶发一次是正常的，风暴式连续触发才是病，得治。

## 二、底层原理：心跳、超时和两种重平衡协议

要治重平衡，先得弄明白 Kafka 靠什么判断一个消费者"还活着"。

经典协议下，每个消费者有两条并行的线。一条是心跳线程，每隔 heartbeat.interval.ms 给协调器报个到，表示"我还在"；另一条是业务线程，真正拉消息、处理消息、提交 offset。协调器只看"最近有没有收到心跳"，来决定这个成员是否还属于这个组。

这里有两个超时特别容易搞混，务必分清：

- **session.timeout.ms（会话超时）**：协调器多久没收到心跳，就认为这个消费者死了。默认 45 秒。
- **max.poll.interval.ms（两次 poll 的最大间隔）**：两次 poll() 之间允许隔多久。默认 5 分钟。如果你 poll() 拿到一批消息后，业务处理了 6 分钟还没回来，消费者会被主动踢出组。

差别在哪？心跳超时是"进程卡死了或网络断了"，poll 超时是"线程活着，但业务太慢没来得及拉下一批"。**线上大量重平衡不是进程挂了，而是业务处理太慢**。这也是为什么"扩容反而更卡"——新实例一起抢分区，彼此的 poll 节奏被打乱。

触发重平衡的条件，记住这四条就够用：

1. 消费者加入组（新实例上线）。
2. 消费者离开组（正常关闭、崩溃、心跳超时、poll 超时）。
3. 订阅的主题分区数发生变化。
4. 订阅关系变化（比如加了新主题）。

那 Kafka 4.x 里的新协议（KIP-848）改了什么？它把"全体起立重新排座"换成了"增量调整"。只有一个成员进来或离开时，只动受影响的那几个分区，其余分区原地不动，其他消费者照常消费，不再全组停工。

新协议还有几个结构性变化：

- 分区分配由**协调器（服务端）**来做，客户端不再自己算分配方案。
- 成员掉线不会引发全组停工，协调器按需把分区补位。
- 客户端通过 group.protocol=consumer 开启（不写就是经典协议）。
- 配套超时参数换了一套名字，下面代码里会写清楚。

打个比方：经典重平衡像全班换座位，一个人转学全班都得重新排；新协议像只给转学生安排一个空位，其他人屁股都不用抬。

## 三、实战：Spring Boot 里写一个能观察重平衡的消费者

下面这套代码是一个完整的"下单—消费"示例，跑起来后你能直观看到重平衡日志。项目用 Java 21（代码里用了 record），运行环境需要 Kafka 4.x。

先起一个本地 Kafka。Kafka 4.x 已经不需要 ZooKeeper，官方镜像一条命令就行：

```bash
docker run -d --name kafka -p 9092:9092 apache/kafka:latest
```

项目依赖，pom.xml 完整如下：

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
    <artifactId>kafka-rebalance-demo</artifactId>
    <version>1.0.0</version>
    <name>kafka-rebalance-demo</name>

    <properties>
        <java.version>21</java.version>
    </properties>

    <dependencies>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter</artifactId>
            <version>4.1.1</version>
        </dependency>
        <dependency>
            <groupId>org.springframework.kafka</groupId>
            <artifactId>spring-kafka</artifactId>
            <version>4.1.1</version>
        </dependency>
        <dependency>
            <groupId>org.apache.kafka</groupId>
            <artifactId>kafka-clients</artifactId>
            <version>4.3.1</version>
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

application.yml 完整配置，注意里面分了两组：一组是通用参数，一组是重平衡相关参数。这里直接开启新协议：

```yaml
spring:
  kafka:
    bootstrap-servers: localhost:9092
    producer:
      key-serializer: org.apache.kafka.common.serialization.StringSerializer
      value-serializer: org.springframework.kafka.support.serializer.JsonSerializer
      acks: all
      properties:
        enable.idempotence: true
    consumer:
      group-id: order-fulfillment
      auto-offset-reset: earliest
      key-deserializer: org.apache.kafka.common.serialization.StringDeserializer
      value-deserializer: org.springframework.kafka.support.serializer.JsonDeserializer
      enable-auto-commit: false
      max-poll-records: 200
      properties:
        spring.json.trusted.packages: "com.example.kafkarebalance.model"
        spring.json.value.default.type: "com.example.kafkarebalance.model.OrderEvent"
        # 开启新一代重平衡协议（KIP-848），去掉这行就回到经典协议
        group.protocol: consumer
        group.consumer.session.timeout.ms: 45000
        group.consumer.heartbeat.interval.ms: 3000
        group.consumer.max.poll.interval.ms: 300000
    listener:
      ack-mode: manual_immediate
      concurrency: 3
```

第一段就是启动类，别的不用多写：

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

消息体用一个 record，简单干净：

```java
package com.example.kafkarebalance.model;

public record OrderEvent(String orderId, String userId, long amount, long createTime) {
}
```

启动时自动建主题，6 个分区，方便你观察多消费者怎么分：

```java
package com.example.kafkarebalance.config;

import org.apache.kafka.clients.admin.NewTopic;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.kafka.config.TopicBuilder;

@Configuration
public class KafkaTopicConfig {

    @Bean
    public NewTopic orderTopic() {
        return TopicBuilder.name("order-topic")
                .partitions(6)
                .replicas(1)
                .build();
    }
}
```

生产者负责发消息，开启了幂等（enable.idempotence=true），保证单个生产者重试时不产生重复：

```java
package com.example.kafkarebalance.producer;

import com.example.kafkarebalance.model.OrderEvent;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.stereotype.Service;

@Service
public class OrderProducer {

    private static final Logger log = LoggerFactory.getLogger(OrderProducer.class);
    private static final String TOPIC = "order-topic";

    private final KafkaTemplate<String, OrderEvent> kafkaTemplate;

    public OrderProducer(KafkaTemplate<String, OrderEvent> kafkaTemplate) {
        this.kafkaTemplate = kafkaTemplate;
    }

    public void send(OrderEvent event) {
        kafkaTemplate.send(TOPIC, event.orderId(), event)
                .whenComplete((result, ex) -> {
                    if (ex != null) {
                        log.error("发送失败 orderId={}", event.orderId(), ex);
                        return;
                    }
                    log.info("发送成功 orderId={} partition={} offset={}",
                            event.orderId(),
                            result.getRecordMetadata().partition(),
                            result.getRecordMetadata().offset());
                });
    }
}
```

消费者是重点。这里用手动提交（enable-auto-commit=false），处理成功才 ack，同时用内存集合做幂等，防重平衡后的重复消费：

```java
package com.example.kafkarebalance.consumer;

import com.example.kafkarebalance.model.OrderEvent;
import org.apache.kafka.clients.consumer.ConsumerRecord;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.kafka.support.Acknowledgment;
import org.springframework.stereotype.Service;

import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

@Service
public class OrderConsumer {

    private static final Logger log = LoggerFactory.getLogger(OrderConsumer.class);

    // 用内存做幂等只适合演示；生产环境请换成 Redis 或唯一索引
    private final Set<String> processedOrderIds = ConcurrentHashMap.newKeySet();

    @KafkaListener(topics = "order-topic", groupId = "order-fulfillment")
    public void onMessage(ConsumerRecord<String, OrderEvent> record, Acknowledgment ack) {
        OrderEvent event = record.value();
        log.info("收到订单 orderId={} partition={} offset={}",
                event.orderId(), record.partition(), record.offset());

        if (!processedOrderIds.add(event.orderId())) {
            log.warn("重复消息，跳过 orderId={}", event.orderId());
            ack.acknowledge();
            return;
        }

        try {
            handleOrder(event);
            ack.acknowledge();
        } catch (Exception e) {
            log.error("处理失败，不提交 offset，等下次重投 orderId={}", event.orderId(), e);
        }
    }

    private void handleOrder(OrderEvent event) {
        // 模拟业务处理，这里替换成你真正的逻辑
        log.info("处理订单 userId={} amount={}", event.userId(), event.amount());
    }
}
```

想知道什么时候发生了重平衡，加一个监听器就够了。Spring Kafka 会自动把容器里唯一的 ConsumerAwareRebalanceListener 装配上去：

```java
package com.example.kafkarebalance.config;

import org.apache.kafka.clients.consumer.Consumer;
import org.apache.kafka.common.TopicPartition;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.kafka.listener.ConsumerAwareRebalanceListener;

import java.util.Collection;

@Configuration
public class KafkaRebalanceListenerConfig {

    private static final Logger log = LoggerFactory.getLogger(KafkaRebalanceListenerConfig.class);

    @Bean
    public ConsumerAwareRebalanceListener rebalanceListener() {
        return new ConsumerAwareRebalanceListener() {

            @Override
            public void onPartitionsRevokedBeforeCommit(Consumer<?, ?> consumer,
                                                        Collection<TopicPartition> partitions) {
                log.warn("重平衡开始，分区被回收: {}", partitions);
            }

            @Override
            public void onPartitionsAssigned(Consumer<?, ?> consumer,
                                             Collection<TopicPartition> partitions) {
                log.info("重平衡结束，分配到分区: {}", partitions);
            }
        };
    }
}
```

要跑起来看现象，加一个 CommandLineRunner 定时发消息即可：

```java
package com.example.kafkarebalance;

import com.example.kafkarebalance.model.OrderEvent;
import com.example.kafkarebalance.producer.OrderProducer;
import org.springframework.boot.CommandLineRunner;
import org.springframework.stereotype.Component;

import java.util.UUID;

@Component
public class DemoRunner implements CommandLineRunner {

    private final OrderProducer producer;

    public DemoRunner(OrderProducer producer) {
        this.producer = producer;
    }

    @Override
    public void run(String... args) {
        for (int i = 0; i < 1000; i++) {
            producer.send(new OrderEvent(
                    UUID.randomUUID().toString(),
                    "user-" + (i % 50),
                    100L + i,
                    System.currentTimeMillis()));
        }
    }
}
```

启动后你再开第二个进程（或把 concurrency 调到 6），日志里会看到分区回收和重新分配的过程。用命令行确认消费者组状态：

```bash
docker exec kafka kafka-consumer-groups.sh --bootstrap-server localhost:9092 \
  --describe --group order-fulfillment
```

## 四、踩坑经验和最佳实践

下面这几条都是真金白银换来的。

**坑一：业务处理太慢，撞上 poll 超时。** 最典型。消费者 poll 到 200 条后逐条调外部接口，一条 2 秒，200 条就是 400 秒，超过 max.poll.interval.ms（默认 300 秒）就被踢出组，然后无限循环。处方有两条：把 max-poll-records 调小，让每批处理时间可控；把耗时操作改成异步或批量接口。我通常两个一起做。

**坑二：扩容反而触发风暴。** 上面那个订单服务就是。频繁上下线会让重平衡一次接一次。**上线新实例要慢启动、分批加**，别一次性怼 10 台进去。

**坑三：静态成员（group.instance.id）的两面性。** 经典协议下给每个消费者配一个固定的 group.instance.id，重启时协调器会等它回来，不触发重平衡，适合滚动发布。但它也有代价：如果这个实例再也起不来，协调器要等到 session.timeout.ms 超时才会把分区分给别人，这期间消费是停的。别把 session.timeout.ms 设得太大。

**坑四：重复消费没兜住。** 分区换人、offset 回退都会导致重复。消费者必须自己做幂等，靠 Redis 的 setnx 或数据库唯一索引，别指望 Kafka 帮你。生产环境别用上面示例里的内存 Set。

**坑五：以为换了新协议就万事大吉。** KIP-848 解决的是"重平衡时全组停工"，不解决"业务太慢"和"重复消费"。业务侧的问题还得业务侧修。

把可以背下来的实践清单列一下：

- 消费者下线要优雅：注册 JVM shutdown hook，或让 Spring 容器正常关闭，别直接 kill -9。
- offset 提交用手动模式，处理成功再提交，把"至少一次"落到实处。
- max-poll-records 按单条耗时反推：单批处理时间留出 max.poll.interval.ms 的一半以上余量。
- 监控三件事：consumer group 的 lag、重平衡次数、poll 耗时。
- 分区数提前规划好，扩分区也会触发重平衡。

## 五、性能对比和技术选型

两种协议不是"新的取代旧的"，而是各有场景。下面这张表能帮你快速判断。

| 维度 | 经典协议（classic） | 新协议（KIP-848） |
| --- | --- | --- |
| 分配方式 | 客户端算，eager 全量回收 | 服务端算，增量调整 |
| 触发时的消费 | 全组暂停（STW） | 大部分分区照常消费 |
| 成员上下线影响 | 全组受影响 | 只影响变动的分区 |
| 开启方式 | 默认 | group.protocol=consumer |
| 超时参数 | session.timeout.ms / heartbeat.interval.ms | group.consumer.* 系列 |
| 对 Broker 的要求 | 任意 | Kafka 4.x |

选型建议很直接：**只要服务端是 Kafka 4.x，新协议没有理由不用**。它不改变你的业务代码，只是把重平衡的代价压到最低。经典协议保留的意义，主要是还有老版本 Broker 需要兼容。

另外，新协议下 partition.assignment.strategy 这类客户端分配器参数会被忽略，分配策略改由服务端的 group.consumer.assignors 控制，升级时记得清理掉旧配置，别留个"配了没生效"的坑。

## 六、总结

重平衡不是 Kafka 的 bug，它是消费组为了保持"一分区一消费者"这份契约而付出的协调成本。你要做的不是消灭它，而是别让它失控。

核心就三点：

- 心跳超时（session.timeout.ms）管"死没死"，poll 超时（max.poll.interval.ms）管"慢不慢"。线上重平衡十有八九是慢，不是死。
- 排查先看 lag 和消费者组 describe，再看日志里的 Revoked/Assigned 时间点，基本就能定位到是谁在频繁上下线。
- 能上 Kafka 4.x 就开 group.protocol=consumer，把全组停工变成局部调整；业务太慢、重复消费这类问题，还得在业务侧解决。

下次再遇到 lag 飙升，先别急着扩容。看一眼重平衡日志，很可能你缺的不是机器，是把业务处理时间压下去。

文 / 会编程的吕洞宾

## 参考资料

- [KIP-848: The Next Generation of the Consumer Rebalance Protocol](https://cwiki.apache.org/confluence/display/KAFKA/KIP-848%3A+The+Next+Generation+of+the+Consumer+Rebalance+Protocol)
- [Apache Kafka Documentation - Consumer Configs](https://kafka.apache.org/documentation/#consumerconfigs)
- [Apache Kafka Documentation - Upgrading](https://kafka.apache.org/documentation/#upgrade)
- [Spring for Apache Kafka Reference Documentation](https://docs.spring.io/spring-kafka/reference/)
- [Spring Boot 4.1 Release Notes](https://github.com/spring-projects/spring-boot/wiki/Spring-Boot-4.1-Release-Notes)
