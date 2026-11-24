---
title: Spring Boot 启动慢，Java 后端先上 AOT 缓存
date: 2026-11-19T12:24:26+08:00
tags: ["java"]
categories: java
---

# Spring Boot 启动慢，Java 后端先上 AOT 缓存

> 发版时的滚动重启最能暴露问题：新容器起来，健康检查探针连着失败三次，K8s 直接把流量掐了；搞弹性扩容更难受，新实例注册进注册中心的头几秒，接口全是 502。运维第一反应是加内存加 CPU，加完发现该慢还是慢。启动慢的根子不在算力不够，在每次启动都要把几千个类重新读一遍、重新认识一遍。这篇讲一件事：用 JVM 自带的 AOT 缓存，把上一次启动的成果存下来，下次开机直接拿来用。

## 一、启动那几秒到底花在哪

先给结论：Spring Boot 启动慢，主要慢在两件固定工序上——JVM 把几千个类从文件里读出来重新登记一遍，Spring 把整个容器重新搭一遍。这两件事每次都从零开始，和你给多少内存基本无关。

一个稍微正经点的 Spring Boot 项目，启动时要加载的类在一万到三万个之间。JDK 自己的官方文档里给过一个真实数字：Spring PetClinic 这个示例应用，启动时加载并链接了大约 21000 个类。

21000 个类是什么概念？每个类都要经历这套流程：从 jar 里读出字节、解析成 JVM 内部结构、验证字节码合法性、分配内存、把符号引用解析成直接引用。一步都省不掉，而且这些活是串着干的，CPU 单核跑满，其他核在旁边看。

JVM 忙完，轮到 Spring：

- 扫描 classpath，找出所有带 `@Component`、`@Service`、`@Configuration` 的类
- 解析配置，处理 `@Conditional`，也就是那一堆"满足条件才生效"的自动配置判断
- 按依赖顺序实例化 Bean，注入依赖，跑 `@PostConstruct`
- 起内嵌的 Tomcat，绑端口

然后才是第三个阶段，很多人忽略了它：JIT 预热。方法刚跑起来是解释执行的，跑够次数才编译成本地机器码。所以"启动完成"和"能扛住流量"之间还差几秒。压测时经常看到 QPS 曲线是慢慢爬上去的，不是一步到位，就是这个原因。

三个阶段的耗时占比，不同项目差别很大。业务简单、依赖少的服务，类加载可能占一半；引了一堆中间件客户端的服务，Bean 初始化反而是大头。想知道自己项目的情况，别猜，用第三节说的 `/actuator/startup` 端点直接看。

有个常见误区得先掐掉：加内存没用。堆从 2G 加到 8G，类加载不会快一毫秒，因为瓶颈是"读取 + 解析"这串串行动作，跟堆大小没关系。换更强的 CPU 有用，但收益远不如把这一步直接跳过。

还有个更危险的"优化"：`spring.main.lazy-initialization=true`。它把 Bean 初始化推迟到第一次用到的时候，启动数字确实好看了，代价是第一个请求替你扛下了全部初始化开销，还顺手把配置错误藏到运行期。线上服务别用这招。

## 二、AOT 缓存到底缓存了什么

一句话概括：AOT 缓存就是把上一次启动时"读类、解析类、加载类、链接类"的成果存到磁盘，下次启动直接映射进来，跳过这些活。

打个比方。你家装修队每次进场，都得重新看一遍图纸、重新量一遍尺寸、重新确认材料齐不齐，然后才开工。AOT 缓存相当于上一次收工时留下了一份完整的施工记录：哪里是承重墙、哪个插座走哪路线、材料清单打印好放门口。下次进场照着记录干，前面那套准备动作全省了。

### 2.1 从 class 文件到能用的类，中间有五道工序

一个 `.class` 文件要被 JVM 用起来，得走完这五步：

| 阶段 | 干什么 | 能不能省 |
|---|---|---|
| 读取（read） | 从 jar 里把字节读出来 | 能，前提是有人替你读好 |
| 解析（parse） | 字节流转成 JVM 内部的类结构 | 能 |
| 加载（load） | 在方法区里建出这个类 | 能，但要保证状态一致 |
| 链接（link） | 验证字节码、解析符号引用 | 能，风险最高的一步 |
| 初始化（init） | 跑静态代码块 | 不能，跟业务逻辑有关 |

最早被解决的只有前两步，那就是 CDS（Class Data Sharing，类数据共享）。JDK 5 就有这个东西，思路很朴素：把解析好的类存成一个归档文件，启动时直接内存映射，省掉读文件和解析。

CDS 有个明显的天花板——它只存"解析完的类"，加载和链接还得现场做。而链接这一步，尤其是符号引用解析，恰恰是启动耗时的大户。

### 2.2 把链接结果也存下来

JDK 24 的 JEP 483 把这事往前推了一大步：不光存解析结果，连"加载完成、链接完成"之后的状态一起存。启动时这些类直接就是可用状态，一步到位。

实现方式是个"训练运行"（training run）：正常把应用启一遍，JVM 在旁边把类加载的全过程录下来，存成一个归档文件。生产环境启动时加上这个文件，JVM 直接映射，省掉发现、加载、链接的全部工作。

JDK 25 又补了两块（JEP 514、JEP 515）：

- JEP 514 把原本两步的建缓存流程（先 record 再 create）合并成一条命令，少一次操作，少一个中间文件
- JEP 515 把"方法执行画像"也存进缓存。JIT 编译需要先知道哪些方法热、哪些分支常走，以前得在线上跑一阵才收集到，现在训练运行时就采好，启动后 JIT 能立刻编译热点方法，预热时间也一起缩短

### 2.3 训练运行干了什么，为什么必须解压

Spring Boot 官方推荐的训练命令长这样：

```bash
java -XX:AOTCacheOutput=app.aot -Dspring.context.exit=onRefresh -jar my-app.jar
```

`-Dspring.context.exit=onRefresh` 的意思是：容器刷新一结束就退出，不用真的对外提供服务。训练的目的是让 JVM 看见所有类被加载，不是让它跑业务。

有个硬条件容易被忽略：**必须用解压后的目录形式启动**。Spring Boot 打出来的 fat jar，里面的依赖 jar 是以嵌套形式塞进去的，JVM 没法直接把嵌套 jar 里的类映射到内存。必须先用 `-Djarmode=tools` 把 jar 解开成 `lib/` 目录 + 主 jar，缓存才有意义。这点后面实战里会写全。

### 2.4 缓存什么时候会失效

缓存不是永久有效的，它对环境一致性要求挺严：

| 变化 | 缓存还能用吗 |
|---|---|
| jar 包内容变了（改代码、升依赖） | 不能，必须重新训练 |
| JDK 版本变了（哪怕小版本） | 不能 |
| classpath 顺序变了 | 大概率不能 |
| 启动参数里 profile 不同 | 能用但命中率低，Bean 集合不一样 |
| 运行机器不同、路径不同 | 不建议，保持训练和运行同路径 |

失效了会怎样？JVM 不会崩，它会打印一条警告然后老老实实按老路子启动。所以你很可能"配了缓存但一点没快"，还以为缓存没用——其实是一直在失效。JEP 483 提供了一个排查开关 `-XX:AOTMode=on`，加上它以后，缓存不可用就直接报错退出，不给你糊弄过去的机会。

### 2.5 它和 GraalVM Native Image 不是一回事

很多人一听 AOT 就想到 native image，这两者差别很大：

| | AOT 缓存 | GraalVM Native Image |
|---|---|---|
| 本质 | JVM 仍然是 JVM，只是少干几步 | 编译成机器码的可执行文件，没有 JVM |
| 启动 | 快一截（官方示例约 42%） | 快得多，百毫秒级 |
| 代码改动 | 零改动 | 反射、动态代理、序列化都要注册 hint |
| 构建复杂度 | 加两条命令 | 换构建链，出问题排查很难 |
| 峰值性能 | 不降 | 长期运行通常不如 JIT |

一句话选型：**要"启动快一点"选 AOT 缓存，要"启动极快"才考虑 native image**。绝大多数业务后端属于前者。

## 三、实战：手把手写代码

下面这套代码可以直接复制运行。四个 Java 文件、一个 pom、一个配置文件，最后打包、训练、启动。

### 3.1 完整的 pom.xml

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
    <artifactId>aot-cache-demo</artifactId>
    <version>1.0.0</version>
    <name>aot-cache-demo</name>
    <description>AOT cache startup demo</description>

    <properties>
        <java.version>25</java.version>
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
            <artifactId>spring-boot-starter-actuator</artifactId>
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

`java.version` 写 25 不是随手写的。AOT 缓存这套参数从 Java 24 开始有，Java 25 才把命令简化成现在这样，用 21 编译出来跑不了这个功能。

### 3.2 完整的 application.yml

```yaml
server:
  port: 8080

spring:
  application:
    name: aot-cache-demo

management:
  endpoints:
    web:
      exposure:
        include: health,startup
  endpoint:
    startup:
      enabled: true
```

把 `startup` 端点暴露出来，是为了后面看启动耗时分布。它返回的是 Spring 容器刷新过程中每一步的时间线，比在代码里到处打日志精确。

### 3.3 完整的启动类

```java
package com.example.aotcache;

import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.context.metrics.buffering.BufferingApplicationStartup;

@SpringBootApplication
public class AotCacheDemoApplication {

    public static void main(String[] args) {
        new SpringApplicationBuilder(AotCacheDemoApplication.class)
                .applicationStartup(new BufferingApplicationStartup(2048))
                .run(args);
    }
}
```

这里没用常见的 `SpringApplication.run(...)`，换成 `SpringApplicationBuilder`，多了一行 `.applicationStartup(...)`。`BufferingApplicationStartup` 的作用是在内存里记录启动的每个步骤，容量 2048 表示最多存 2048 条记录，普通项目够用。不装这个，`/actuator/startup` 端点会返回空。

### 3.4 完整的业务代码

订单实体，Java 25 直接用 record：

```java
package com.example.aotcache.order;

import java.math.BigDecimal;

public record OrderDetail(long id, String productName, String status, BigDecimal amount) {
}
```

服务层，构造器里塞几条假数据，模拟"启动时要初始化点东西"的常见场景：

```java
package com.example.aotcache.order;

import org.springframework.stereotype.Service;

import java.math.BigDecimal;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

@Service
public class OrderService {

    private final Map<Long, OrderDetail> orders = new ConcurrentHashMap<>();

    public OrderService() {
        orders.put(1001L, new OrderDetail(1001L, "机械键盘", "PAID", new BigDecimal("599.00")));
        orders.put(1002L, new OrderDetail(1002L, "显示器", "SHIPPED", new BigDecimal("1899.00")));
        orders.put(1003L, new OrderDetail(1003L, "桌面音箱", "CREATED", new BigDecimal("429.00")));
    }

    public OrderDetail find(long id) {
        OrderDetail detail = orders.get(id);
        if (detail == null) {
            throw new IllegalArgumentException("订单不存在: " + id);
        }
        return detail;
    }
}
```

控制器：

```java
package com.example.aotcache.order;

import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

@RestController
@RequestMapping("/orders")
public class OrderController {

    private final OrderService orderService;

    public OrderController(OrderService orderService) {
        this.orderService = orderService;
    }

    @GetMapping("/{id}")
    public OrderDetail detail(@PathVariable long id) {
        return orderService.find(id);
    }

    @ExceptionHandler(IllegalArgumentException.class)
    @ResponseStatus(HttpStatus.NOT_FOUND)
    public Map<String, String> handleNotFound(IllegalArgumentException ex) {
        return Map.of("message", ex.getMessage());
    }
}
```

四个文件凑成一个能跑的最小服务：`GET /orders/1001` 返回订单，`GET /actuator/startup` 返回启动时间线。

### 3.5 打包、训练、启动

第一步，打包：

```bash
mvn clean package
```

产物是 `target/` 目录下的那个可执行 jar，文件名是 `aot-cache-demo` 加版本号，下面命令里按你的实际文件名替换。

第二步，解压成目录形式。这一步不能省，前面说过原因：

```bash
java -Djarmode=tools -jar target/aot-cache-demo-1.0.0.jar extract --destination build/app
```

执行完 `build/app/` 里有 `lib/` 目录和一个同名 jar。

第三步，训练运行，生成缓存：

```bash
cd build/app
java -XX:AOTCacheOutput=app.aot \
     -Dspring.context.exit=onRefresh \
     -jar aot-cache-demo-1.0.0.jar
```

跑完目录里多了个 `app.aot`，几十到一百多 MB。整个过程应用的启动日志会正常打印，走到"Started AotCacheDemoApplication"之后进程自己退出，这就是训练成功。

第四步，带上缓存启动：

```bash
java -XX:AOTCache=app.aot -jar aot-cache-demo-1.0.0.jar
```

不加 `-XX:AOTCache` 就是普通启动，加了就是走缓存启动。想看差多少，两条命令前面各挂一个 `time`，或者看日志里 `Started ... in X seconds` 那行，对比着看。

想确认缓存真的生效了，加个开关：

```bash
java -XX:AOTCache=app.aot -XX:AOTMode=on -jar aot-cache-demo-1.0.0.jar
```

`-XX:AOTMode=on` 的意思很直接：缓存有问题就报错，别装作没事继续跑。上线前的验证脚本里加上它，比事后猜强。

### 3.6 用 startup 端点看时间花在哪

启动完成后执行：

```bash
curl -s http://localhost:8080/actuator/startup | python3 -m json.tool
```

返回的是树状时间线，顶层能看到 `spring.beans.instantiate`、`spring.context.refresh` 这些步骤，展开后是每个 Bean 的耗时。哪个依赖初始化拖了两秒，一眼就能抓出来。

这个端点比"启动日志打时间戳"好在两点：一是层级结构清楚，父子步骤的时间不会混；二是它就在内存里，不用改代码重发版。

### 3.7 完整的 Dockerfile

训练和运行必须在同一个 JDK 版本、同一个目录结构下，所以镜像里做训练最稳：

```dockerfile
# 构建阶段：打包 + 训练出 AOT 缓存
FROM eclipse-temurin:25-jdk AS trainer
WORKDIR /app
COPY target/aot-cache-demo-1.0.0.jar app.jar
RUN java -Djarmode=tools -jar app.jar extract --destination /app/extracted \
 && cd /app/extracted \
 && java -XX:AOTCacheOutput=/app/extracted/app.aot \
         -Dspring.context.exit=onRefresh \
         -jar aot-cache-demo-1.0.0.jar

# 运行阶段：JRE 就够
FROM eclipse-temurin:25-jre
WORKDIR /app
COPY --from=trainer /app/extracted /app
EXPOSE 8080
ENTRYPOINT ["java", "-XX:AOTCache=/app/app.aot", "-jar", "/app/aot-cache-demo-1.0.0.jar"]
```

两个阶段都用 `/app`，是为了让训练和运行时的类路径完全一致。路径一变，缓存里的记录对不上，JVM 会忽略缓存，白忙一场。

镜像基础 tag 按你们内网仓库改，唯一要求是 25 的 JRE，别用 21。

## 四、踩坑经验和最佳实践

### 坑一：拿 fat jar 直接加 `-XX:AOTCache`，一点没快

现象最迷惑人。命令没报错，应用起来了，启动时间跟以前一模一样。原因就是 fat jar 里的嵌套 jar 没法映射，JVM 直接放弃缓存。必须 `-Djarmode=tools extract` 之后从解压目录启动。

### 坑二：训练运行把生产数据写了

训练是"真跑一次启动"，不是模拟。所有 `@PostConstruct`、`ApplicationRunner`、`CommandLineRunner`、`@EventListener(ApplicationReadyEvent.class)` 都会真执行。我见过一个项目在启动时给 Redis 写预热数据，训练脚本在 CI 里跑，直接把测试环境的库存刷成了默认值。

训练环境要当成一个真实环境对待：连测试库，别连生产库；`ApplicationRunner` 里有对外调用的，用 profile 关掉。

### 坑三：训练时端口被占，进程起不来

`-Dspring.context.exit=onRefresh` 是容器刷新完才退出，而内嵌 Tomcat 恰恰在刷新阶段就绑端口了。训练机上 8080 被占，训练直接失败。加 `--server.port=0` 用随机端口，省得撞。

### 坑四：升级 JRE 忘了重训，缓存悄悄失效

缓存和 JVM 版本是绑死的。基础镜像哪怕只是打了个补丁、小版本号动了一位，缓存就得重做。CI 里最好写成流水线的固定步骤：打包 → 解压 → 训练 → 出镜像，一条链下来，不给人手动偷懒的机会。

### 坑五：一阶段命令把容器内存打爆

JDK 25 的 `-XX:AOTCacheOutput` 一条命令干完训练和建缓存，方便。但官方文档写清楚了：这个过程需要两份堆内存。你写 `-Xmx4g`，实际要 8G 才跑得完。容器内存限制设得紧，训练阶段就被 OOM Kill，报错还看不出来是内存不够。

内存紧张就用两步老办法：

```bash
java -XX:AOTMode=record -XX:AOTConfiguration=app.aotconf -jar aot-cache-demo-1.0.0.jar
java -XX:AOTMode=create -XX:AOTConfiguration=app.aotconf -XX:AOTCache=app.aot
```

### 坑六：镜像分层把 jar 和缓存拆开了

有的人为了利用构建缓存，把 `app.aot` 单独 COPY 一层。结果某次只更新了 jar 层，缓存还是旧的，JVM 检测到不一致直接忽略，启动速度回退到没优化。缓存和 jar 必须同一层，同生共死。

### 坑七：以为能省掉容器扫描

AOT 缓存省的是 JVM 层面的类加载，Spring 自己的 Bean 扫描、条件判断、实例化一步都没少。有人看到启动只快了 40% 就骂"没用"，其实是期望值错了——它解决的是 JVM 那部分，想再快得靠减少 Bean 数量、拆服务、或者上 native image。

### 实践清单

- 训练和运行永远同 JDK 版本、同目录、同 profile
- CI 流水线固定四步：package → extract → train → image
- 上线前用 `-XX:AOTMode=on` 跑一次，确认缓存真在用
- 用 `/actuator/startup` 先量一下，确认启动耗时的大头到底在哪，再决定要不要做这件事
- 缓存文件体积不小，镜像仓库的存储和拉取时间也要算进成本

## 五、性能对比和技术选型

先看官方给的数据。JEP 483 里对 Spring PetClinic 做了完整测试，这个应用启动要加载约 21000 个类：

| 场景 | 启动耗时 | 相对提升 |
|---|---|---|
| 无缓存 | 4.486 秒 | 基线 |
| 缓存只做读取和解析（等价 CDS） | 3.008 秒 | 33% |
| 缓存包含加载和链接 | 2.604 秒 | 42% |

缓存文件占 130 MB。同一个 JEP 里的小程序 HelloStream，从 0.031 秒降到 0.018 秒，也是 42%。

JEP 515 的方法画像带来的收益体现在预热上：一个测试程序从 90 毫秒降到 73 毫秒，提升 19%，画像数据只多占 250 KB，约 2.5%。程序越复杂、预热期越长，这部分收益越明显。

三种方案摆在一起：

| 方案 | 启动收益 | 构建代价 | 代码限制 | 适用场景 |
|---|---|---|---|---|
| 不改 | 基线 | 无 | 无 | 启动不是瓶颈 |
| CDS | 约 33% | 加一条命令 | 无 | 停留在 Java 21 |
| AOT 缓存 | 约 42% | 加两条命令 | 基本无 | Java 25+，容器滚动发布 |
| GraalVM Native Image | 百毫秒级 | 换构建链 | 反射/代理需 hint | 函数计算、缩容到零 |

我的建议很直接：**Java 25 以上、启动又是真痛点，先上 AOT 缓存**。零代码改动，构建加两步，收益稳定。别一上来就折腾 native image——那个东西在业务项目里踩的坑，够写三篇文章。

如果你的服务启动本身只要 1 秒多，做完这个优化变成 0.7 秒，而你的探针超时设的是 30 秒，那这事优先级可以往后排。优化要对准真实瓶颈。

## 六、总结

启动慢的本质是重复劳动：每次开机，JVM 都从零把上万个类重新读一遍、认识一遍，Spring 再从零把容器搭一遍。AOT 缓存干的事很朴素——把上一次的成果存下来，下次直接用。

具体到落地，四件事：

- 打包后必须 `-Djarmode=tools` 解压，从目录启动，fat jar 上缓存无效
- 训练命令加 `-Dspring.context.exit=onRefresh`，刷新完就退，不起服务
- 运行命令加 `-XX:AOTCache=app.aot`，配合 `-XX:AOTMode=on` 验证是否真的生效
- 缓存跟 jar、跟 JDK 版本绑死，改任何一样就重训

它不是银弹。Spring 的 Bean 扫描省不掉，业务代码的初始化省不掉，缓存文件还占一百多兆。但在"发版时探针老失败""扩容后头几秒全是错误"这种具体场景里，它是最省事的一招——不动一行业务代码。

真要动手，先花十分钟看 `/actuator/startup`，把耗时大头找出来。找错了地方，再好的优化也是白费。

文 / 会编程的吕洞宾

## 参考资料

- [AOT Cache :: Spring Boot](https://docs.spring.io/spring-boot/reference/packaging/aot-cache.html)
- [JEP 483: Ahead-of-Time Class Loading & Linking](https://openjdk.org/jeps/483)
- [JEP 514: Ahead-of-Time Command-Line Ergonomics](https://openjdk.org/jeps/514)
- [JEP 515: Ahead-of-Time Method Profiling](https://openjdk.org/jeps/515)
- [AOT Cache :: Spring Boot How-to Guides](https://docs.spring.io/spring-boot/how-to/aot-cache.html)
