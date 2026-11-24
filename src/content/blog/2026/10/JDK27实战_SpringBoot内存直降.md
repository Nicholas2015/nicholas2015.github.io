---
title: "JDK27 实战：Spring Boot 内存直降"
date: 2026-10-13T09:00:00+08:00
category: "java"
tags: ["spring-boot", "jdk"]
---

> 压测时服务在 `-Xmx2g` 下跑到八成堆就开始频繁 Full GC，业务代码一行没改，只是把运行环境从 JDK 21 换成 JDK 27，堆占用就掉了一截，GC 次数也跟着降了。这不是玄学。JDK 27 把紧凑对象头（Compact Object Headers）变成了默认布局，每个对象的头开销从 12 字节压到 8 字节。单看 4 个字节不起眼，可当服务里躺着几百万个小对象时，省下的就是几百 MB。这篇把原理、完整代码和踩坑一次讲清楚。

## 一、JDK 27 有哪些变化真正影响 Spring Boot 服务

结论先行：JDK 27 对后端服务最直接的收益全在 JVM 层，业务代码一行都不用改。

JDK 27 是今年 9 月发布的 Java 标准版，一次带进九个特性，从垃圾回收器默认值到 TLS 密钥交换都有，完整清单在官方项目页。但真正能让一个 Spring Boot 服务「什么都不改就变省」的，只有下面三件事：

- **紧凑对象头成为默认布局**：HotSpot 里每个对象的对象头换了更省空间的编码，从 96 位压到 64 位（[JEP 534](https://openjdk.org/jeps/534)）。
- **G1 成为所有环境的默认回收器**：以前在小内存机器上，JVM 不指定回收器时会自己挑 Serial GC，现在统一默认 G1（[JEP 523](https://openjdk.org/jeps/523)）。
- **JFR 默认脱敏**：飞行录音文件里记录的启动命令、环境变量、系统属性，里面的密码和令牌默认写成 `[REDACTED]`（[JEP 536](https://openjdk.org/jeps/536)）。

前两条直接跟内存和吞吐有关，第三条是安全。这三件事有个共同点：**它们都是 JVM 的行为，不依赖框架版本、不用改 pom、不用改代码**。你把运行环境换上去，收益自动到账。

有人会问，那 Spring Boot 那边要不要动？不用。Spring Boot 只是跑在 JVM 上的一堆类，JVM 换了对象布局和默认回收器，容器里的 Bean、你返回的 DTO、MyBatis 查出来的实体，全都跟着受益。

除了这三个，JDK 27 还有一批预览特性，比如结构化并发、惰性常量、原始类型参与模式匹配。它们很香，但都得加 `--enable-preview` 才能用，API 也还可能变。我不往主力服务上放预览特性，这篇只聊能立刻落地的那部分。

## 二、紧凑对象头为什么能省内存

结论先行：对象头是每个对象在堆里的「户口本」，紧凑对象头把它从 12 字节瘦到 8 字节，再叠加 8 字节内存对齐，小对象能省掉三分之一的空间。

先讲对象头到底是什么。Java 里每个对象在堆上除了自己的数据，还带一小块户口信息，记录四件事：**这个对象属于哪个类、被 GC 熬过几轮（分代年龄）、锁的状态、身份哈希码**。这块信息就是对象头（object header）。

在 64 位 HotSpot 上，历史布局是 **96 位，也就是 12 字节**：一个 64 位的标记字段（mark word）放年龄、锁状态和哈希码，再加一个 32 位的类指针，指向它的类元数据。

紧凑对象头干的事很直接：**把标记字段从 64 位压到 32 位**，和类指针拼起来正好 64 位，也就是 8 字节。哈希码、分代年龄、锁状态这些信息用更少的位数表达，JVM 再把类的元数据放到内存里一块受限的区域，让 32 位地址就够寻址。

省 4 字节能有多大用？关键在**内存对齐**。HotSpot 分配对象时按 8 字节对齐，不足的补齐。拿一个只有两个 int 字段的小对象举例：

- 老布局：12（头）+ 4 + 4 = 20 字节，对齐后是 **24 字节**。
- 紧凑头：8（头）+ 4 + 4 = 16 字节，正好整除，**16 字节**。

头只省了 4 字节，实际省下 8 字节，因为老布局里那 4 个字节本来就被对齐浪费掉了。对象越小、数量越多，这个比例越夸张。

官方数据也撑得住这个结论。[JEP 534](https://openjdk.org/jeps/534) 里列了几个实验：SPECjbb2015 基准少用 **22% 的堆空间**和 **8% 的 CPU 时间**；在 G1 和 Parallel 两种回收器下，**GC 次数都少了 15%**；一个高度并行的 JSON 解析基准**快 10%**。

放到 Spring Boot 服务上，受益的对象类型我能闭着眼报一串：接口返回的 DTO、查库映射出来的实体、缓存里塞的对象、`HashMap` 的每个节点、每条日志事件、集合里的包装类。这些对象的特点就是数量大、个头小，正好是紧凑对象头的主场。

还有个副作用是好事：对象变小了，同样大小的堆能装下更多对象。对内存有限的容器来说，GC 被推迟，服务能扛更高的并发才需要回收。

## 三、实战：把服务跑在 JDK 27 上并量出收益

结论先行：升级只需要换 JDK、把编译版本提到 27，再用一个测量类对比开关前后的堆占用，收益一目了然。

先建工程。完整的 `pom.xml` 如下，Spring Boot 用官方当前发布版，编译级别设为 27，依赖版本都写全：

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
    <artifactId>jdk27-demo</artifactId>
    <version>1.0.0</version>

    <properties>
        <java.version>27</java.version>
        <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
    </properties>

    <dependencies>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-web</artifactId>
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

`parent` 管住了绝大多数依赖的版本，但为了读者照抄能直接跑通，我把显式用到的依赖和插件版本都写了全。`java.version` 设 27，Maven 编译时就会按 27 的语言级别编译。

接着是启动类和配置文件，都是最普通的样子，没有任何为 JDK 27 写的特殊代码——这恰恰是重点：**升级不改业务代码**。

```java
package com.example.jdk27demo;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class Jdk27DemoApplication {

    public static void main(String[] args) {
        SpringApplication.run(Jdk27DemoApplication.class, args);
    }
}
```

```yaml
server:
  port: 8080

spring:
  application:
    name: jdk27-demo
```

再来一个诊断接口，它会把当前堆的使用情况和正在工作的垃圾回收器名字打出来。服务跑起来后，你随时能确认它到底用的哪个回收器、堆有多大：

```java
package com.example.jdk27demo.web;

import java.lang.management.GarbageCollectorMXBean;
import java.lang.management.ManagementFactory;
import java.lang.management.MemoryMXBean;
import java.lang.management.MemoryUsage;
import java.util.List;
import java.util.Map;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/diagnostics")
public class MemoryController {

    private final MemoryMXBean memoryMXBean = ManagementFactory.getMemoryMXBean();

    @GetMapping("/memory")
    public Map<String, Object> memory() {
        MemoryUsage heap = memoryMXBean.getHeapMemoryUsage();
        List<String> gcNames = ManagementFactory.getGarbageCollectorMXBeans()
                .stream()
                .map(GarbageCollectorMXBean::getName)
                .toList();
        return Map.of(
                "usedMb", heap.getUsed() / 1024 / 1024,
                "committedMb", heap.getCommitted() / 1024 / 1024,
                "maxMb", heap.getMax() / 1024 / 1024,
                "gc", gcNames);
    }
}
```

访问 `/diagnostics/memory` 会返回类似这样的 JSON，`gc` 字段就是 JVM 实际启用的回收器：

```text
{"usedMb":48,"committedMb":256,"maxMb":2048,"gc":["G1 Young Generation","G1 Old Generation"]}
```

如果 `gc` 里出现的是 `G1 Young Generation`，说明默认 G1 已经生效。要是你看到的是 `PS Scavenge` 之类的名字，那多半是启动参数里写死了 Parallel GC。

现在写关键的那个测量类：它分配一千万个只有两个 int 字段的小对象，测出每个对象实际占多少字节。它不依赖任何第三方库，是完整的、可以直接跑的程序：

```java
package com.example.jdk27demo;

import java.lang.management.ManagementFactory;
import java.util.ArrayList;
import java.util.List;

public class ObjectFootprintDemo {

    static final class Point {
        final int x;
        final int y;

        Point(int x, int y) {
            this.x = x;
            this.y = y;
        }
    }

    public static void main(String[] args) throws InterruptedException {
        int count = 10_000_000;
        List<Point> points = new ArrayList<>(count);

        long before = usedHeapAfterGc();
        for (int i = 0; i < count; i++) {
            points.add(new Point(i, i));
        }
        long after = usedHeapAfterGc();

        double perObject = (after - before) / (double) count;
        System.out.printf("对象数量   : %d%n", count);
        System.out.printf("堆增长     : %.1f MB%n", (after - before) / 1024.0 / 1024.0);
        System.out.printf("单对象均摊 : %.2f 字节%n", perObject);
        System.out.println("集合保留     : " + points.size());
    }

    private static long usedHeapAfterGc() throws InterruptedException {
        for (int i = 0; i < 3; i++) {
            System.gc();
            Thread.sleep(200);
        }
        return ManagementFactory.getMemoryMXBean().getHeapMemoryUsage().getUsed();
    }
}
```

这段代码的逻辑：先在分配前强制 GC 三次、读一次已用堆，记作起点；再往 `ArrayList` 里塞一千万个 `Point`；然后同样强制 GC 再读一次。两次差值是这些对象真正占掉的内存，除以对象数量就是单个对象的均摊大小。数组本身占的那部分引用空间是固定的，两种布局下都一样，不影响对比结论。

打包并分别在两种布局下跑一遍，再用一条命令确认 JVM 的默认值：

```bash
cd jdk27-demo
mvn clean package -DskipTests

# 默认：紧凑对象头 + G1
java -Xms1g -Xmx1g -cp target/classes com.example.jdk27demo.ObjectFootprintDemo

# 对照：显式关掉紧凑对象头
java -Xms1g -Xmx1g -XX:-UseCompactObjectHeaders -cp target/classes com.example.jdk27demo.ObjectFootprintDemo

# 确认对象头布局开关和默认回收器的当前取值
java -XX:+PrintFlagsFinal -version | grep -Ei 'UseCompactObjectHeaders|UseG1GC'
```

两次输出对比着看。默认那次的「单对象均摊」会明显更小，这就是紧凑对象头带来的差别。想让服务也吃到这份收益，用普通方式启动 jar 就行，不用加任何参数。

## 四、踩坑经验和最佳实践

结论先行：JDK 27 的默认值已经够聪明，升级时最大的坑往往不是 JVM，而是你自己的启动脚本和容器镜像。

**坑一：本地换了 JDK，容器里没换。** 这是最常见的「白高兴」。本地 `java -version` 显示 27，编译也过了，但 Dockerfile 的基础镜像还是老 JDK，线上跑的还是老布局，一点收益都没有。升级后第一件事：进容器执行 `java -version` 确认，再把基础镜像的 JDK 换到 27。

**坑二：启动脚本写死了回收器，G1 默认根本轮不到。** G1 成为默认的前提是「命令行不指定回收器」。如果你的启动脚本里还留着 `-XX:+UseParallelGC` 这类历史参数，JVM 会尊重你的显式选择，默认值形同虚设。升级前 grep 一遍启动参数，把没必要的回收器配置删掉。

**坑三：别拿紧凑对象头当万能药。** 它省的是每个对象的头开销。如果你服务的内存是被大数组、大缓存或者超宽实体撑起来的，这 4 个字节救不了你。缓存不设上限、SQL 一次性捞出几十万行，这类问题得从代码和架构上治。

**坑四：极少数「玩对象头」的库要回归测试。** 有少数库会用 `Unsafe` 直接读写对象内存做黑科技优化。紧凑对象头改变了对象内部布局，这类代码有概率踩坑。上线前跑一遍回归；真出问题，用 `-XX:-UseCompactObjectHeaders` 单独关掉就行，其他收益照拿。

**一个顺手的好习惯：容器里别写死 `-Xmx`。** 换成 `-XX:MaxRAMPercentage=75`，让 JVM 按容器内存上限自己算堆大小。机器规格变了不用改参数，也不会因为写死的值超过容器限额被直接 OOM Kill。

**JFR 脱敏默认就生效，但敏感字段名千奇百怪，建议显式配一遍。** 比如把启动命令改成这样：

```bash
java -XX:FlightRecorderOptions:redact-key=confidential,redact-argument=--dbpassword -XX:StartFlightRecording:filename=dump.jfr -Dconfidential=SECRET -jar target/jdk27-demo-1.0.0.jar
```

这条命令的意思是：凡是名字匹配 `confidential` 的环境变量或系统属性，值都记成 `[REDACTED]`；命令行里出现 `--dbpassword` 这个参数也一并脱敏。过滤规则支持 glob，`*` 和 `?` 是通配符；如果密码是跟在选项后面的下一个参数，可以写成 `--password ***`，让 JFR 连下一个参数一起脱敏。想确认到底脱了哪些，启动时加 `-Xlog:jfr+redact=debug` 看日志就行。

## 五、性能对比和技术选型

结论先行：紧凑对象头是零成本、默认开启的收益，没有理由拒绝；真正的选型题在回收器上。

先看同一个对象在两种布局下的差别，按 HotSpot 的 8 字节对齐规则算：

| 对比项 | 关闭紧凑对象头 | 默认（紧凑对象头） | 变化 |
| --- | --- | --- | --- |
| 对象头大小 | 12 字节 | 8 字节 | 省 4 字节 |
| 两个 int 字段的小对象 | 24 字节 | 16 字节 | 省三分之一 |
| 一千万个该对象（含引用数组） | 约 280 MB | 约 200 MB | 省约 80 MB |
| 需要额外参数 | 不需要 | 不需要 | 默认即开启 |

官方基准的数据更直观（来自 JEP 534）：SPECjbb2015 堆空间少 22%、CPU 时间少 8%，GC 次数少 15%。这些是综合负载下的结果，具体到你的服务能省多少，用第三节的测量类跑一遍最实在。

回收器怎么选，给你几句实在话：

- 绝大多数 Web 后端：**用默认的 G1 就行**，别乱调。它已经把延迟和吞吐拉到一个平衡点。
- 堆特别大（几十 GB）、又追求极低停顿：考虑 ZGC。
- 小内存、启动要快的场景：JDK 27 里默认也是 G1；如果实测 Serial 更快，再手动指回去。

## 六、总结

JDK 27 这次升级，对 Spring Boot 服务来说是白捡的便宜。紧凑对象头默认把每个对象的头开销从 12 字节砍到 8 字节，叠加内存对齐，小对象最多省三分之一空间；G1 成了统一默认回收器，历史遗留的回收器参数可以清一清；JFR 默认脱敏，顺手把日志里的密码风险摁住。

真正要动手的地方很少：换个 JDK，把编译版本提到 27，清掉启动脚本里互相打架的回收器参数，在容器里确认一遍版本。剩下的收益，JVM 自己会送上。

要不要升？我的建议是先在预发环境把服务跑起来，用文里那个测量类对比开关前后的堆占用。数据比任何人的嘴都靠谱。

## 参考资料

- [JEP 534: Compact Object Headers](https://openjdk.org/jeps/534)
- [JEP 523: Make G1 the Default Garbage Collector](https://openjdk.org/jeps/523)
- [JEP 536: JFR In-Process Data Redaction](https://openjdk.org/jeps/536)
- [OpenJDK JDK 27 Project Page](https://openjdk.org/projects/jdk/27/)

文 / 会编程的吕洞宾
