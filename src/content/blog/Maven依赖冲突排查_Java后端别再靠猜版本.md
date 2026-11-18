---
title: "Maven依赖冲突排查：Java后端别再靠猜版本"
date: 2026-10-22T09:00:00+08:00
category: "java"
tags: ["maven"]
---

> 改完一行 pom，本地编译通过，打包也正常，服务一启动就给你一记 NoSuchMethodError；或者服务跑得好好的，某个接口一被调用就炸。这种「编译期全绿、运行期报错」的事，十有八九不是业务代码写错了，而是 classpath 上出现了同一个类的两个版本，JVM 挑了个不对的。Maven 选版本不看新旧，只看远近——坑就埋在这。

## 一、依赖冲突到底长什么样

依赖冲突的本质是：同一个类在 classpath 上存在多个版本，编译时用的是一份，运行时加载的是另一份，两边对不上。

它最气人的地方在于「编译能过」。IDE 里没有红波浪线，`mvn package` 也不报错，CI 一路绿灯，直到某个方法被调用，JVM 才告诉你方法不存在。这时候很多人第一反应是「是不是 Spring Boot 版本不对」「是不是 JDK 装错了」，然后开始升级框架、换镜像，折腾半天，问题还在。

先认脸。依赖冲突常见的几种报错：

| 报错 | 含义 | 典型场景 |
| --- | --- | --- |
| `NoSuchMethodError` | 类找到了，方法没找到 | 新版本加了方法，运行时却是旧版 |
| `NoClassDefFoundError` | 类压根没加载到 | 依赖被 exclusion 掉，或静态块初始化失败 |
| `NoSuchFieldError` | 字段没了 | 常量被改名或挪走 |
| `AbstractMethodError` | 接口方法没实现 | 接口加了方法，实现类还是旧版 |
| `IncompatibleClassChangeError` | 类的结构变了 | 类改成了接口，或反之 |
| 启动失败 `ClassNotFoundException` | 运行期缺包 | scope 写错、打包漏了 |

举个真实世界里最常见的画面：项目里有个 `legacy-sdk`，是几年前封装的工具包，内部用 Guava 做了集合处理。某天有人为了兼容另一段老代码，在 pom 里手写了一条 `guava:19.0` 的声明。编译没问题，单测也能跑，因为单测的 classpath 和运行时未必一致。上线后只要调用到 SDK 里那个用 `ImmutableList.toImmutableList()` 的方法，立刻抛 `NoSuchMethodError`——这个方法在 Guava 21 才加进来，19.0 里根本不存在。

再看一眼报错栈，第一行往往就写着「谁的类、缺哪个方法」：

```
java.lang.NoSuchMethodError: com.google.common.collect.ImmutableList.toImmutableList()
    at com.example.legacy.NameService.normalize(NameService.java:16)
```

栈顶是 Guava 的类，但真正的问题在你的 pom 里。这就是依赖冲突最难的地方：凶手和受害者不在同一个包。

还有一个隐蔽变种：不报错，但行为不对。比如日期序列化格式突然变了、JSON 字段名少了、连接池参数不生效。这类问题查起来比崩溃更费劲，因为没有任何异常提示，只能靠比对依赖版本。

## 二、Maven 到底怎么选版本

Maven 选版本的规则只有一句话：路径最短的赢；路径一样长，先声明的赢。它不看版本号大小，也不管谁新谁旧。

这句话拆开是三件事。

**第一，classpath 是扁平的。** 不管依赖嵌套多少层，最后都会被摊平成一条长长的 jar 列表。JVM 的类加载器按这条列表的顺序找类，同一个类名只会加载一次，后面同名的直接忽略。所以「哪个 jar 排在前面」比「哪个版本更新」更重要。

**第二，Maven 用「最近者胜」调解。** 假设你的项目这样依赖：

```
app
├── legacy-sdk
│   └── guava 33.7.2
└── guava 19.0
```

`guava 19.0` 在第二层（直接依赖），`guava 33.7.2` 在第三层（传递依赖）。Maven 选 19.0，跟它老不老没关系，只因为它离根更近。

如果两个版本都在第三层呢？比如 A 和 B 都依赖 Guava，版本不同：

```
app
├── A
│   └── guava 19.0
└── B
    └── guava 33.7.2
```

这时候看 pom 里谁写在前面。A 在前，选 19.0；B 在前，选 33.7.2。把两个依赖的顺序调换一下，运行结果就变了——这种「靠排版决定行为」的设计，第一次见确实想骂人。

**第三，`dependencyManagement` 能一票否决。** 只要在 `dependencyManagement` 里锁了版本，传递依赖带进来的版本统统作废。

```xml
<dependencyManagement>
    <dependencies>
        <dependency>
            <groupId>com.google.guava</groupId>
            <artifactId>guava</artifactId>
            <version>33.7.2-jre</version>
        </dependency>
    </dependencies>
</dependencyManagement>
```

Spring Boot 的 `spring-boot-dependencies` 就是一个超大号的 `dependencyManagement`，所以只要你用了 Boot 的 parent，Spring 全家桶、Jackson、Tomcat、HikariCP 这些版本都被管住了，别人想传旧版本也传不进来。

但它的保护范围是有限的。Guava 就不在 Boot 的管辖名单里（BOM 里那条 `com.github.ben-manes.caffeine:guava` 是另一个 artifact，别混淆）。不少第三方 SDK 常用的 `okhttp`、`fastjson2`、`hutool`、各种云厂商 SDK，也都不在。BOM 管不到的地方，就是冲突的高发区。

**scope 也会影响结果。** `test` 和 `provided` 的依赖不进运行时 classpath，自然也不会参与运行期的类加载。有时候你在 IDE 里跑单测一切正常，打包部署就炸，就是因为测试 classpath 比运行时多了几个 jar。

顺带说一句 Gradle。Gradle 默认策略是「选最高版本」，跟 Maven 的「选最近版本」正好相反。同一个项目从 Maven 迁到 Gradle，依赖冲突的表现可能完全变样——原来被旧版本压住的问题会消失，原来正常的地方反而可能冒出新的不兼容。

## 三、实战：亲手复现一次冲突，再把它修掉

下面这个 demo 完整可跑，两个模块：`legacy-sdk` 用新版 Guava 编译，`app` 是 Spring Boot 服务，pom 里留了一条旧的 Guava 声明。跑起来就会复现 `NoSuchMethodError`。

目录结构：

```
dep-conflict-demo
├── pom.xml
├── legacy-sdk
│   ├── pom.xml
│   └── src/main/java/com/example/legacy/NameService.java
└── app
    ├── pom.xml
    └── src/main/java/com/example/app/DepConflictDemoApplication.java
```

### 3.1 聚合工程 pom

这个 pom 只负责把两个模块串起来，不继承 Spring Boot：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
    <modelVersion>4.0.0</modelVersion>

    <groupId>com.example</groupId>
    <artifactId>dep-conflict-demo</artifactId>
    <version>1.0.0</version>
    <packaging>pom</packaging>

    <modules>
        <module>legacy-sdk</module>
        <module>app</module>
    </modules>
</project>
```

### 3.2 legacy-sdk 模块

这个模块模拟公司里的老工具包。它自己声明 Guava 33.7.2，编译时看到的是新 API：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
    <modelVersion>4.0.0</modelVersion>

    <groupId>com.example</groupId>
    <artifactId>legacy-sdk</artifactId>
    <version>1.0.0</version>
    <packaging>jar</packaging>

    <properties>
        <maven.compiler.release>21</maven.compiler.release>
        <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
    </properties>

    <dependencies>
        <dependency>
            <groupId>com.google.guava</groupId>
            <artifactId>guava</artifactId>
            <version>33.7.2-jre</version>
        </dependency>
    </dependencies>

    <build>
        <plugins>
            <plugin>
                <groupId>org.apache.maven.plugins</groupId>
                <artifactId>maven-compiler-plugin</artifactId>
                <version>3.16.0</version>
            </plugin>
        </plugins>
    </build>
</project>
```

`NameService` 里用了 `ImmutableList.toImmutableList()` 这个收集器。它在 Guava 21 才出现，19.0 没有：

```java
package com.example.legacy;

import com.google.common.collect.ImmutableList;

import java.util.List;

public class NameService {

    public List<String> normalize(List<String> raw) {
        return raw.stream()
                .filter(name -> name != null && !name.isBlank())
                .map(String::trim)
                .map(String::toUpperCase)
                .collect(ImmutableList.toImmutableList());
    }

    public String join(List<String> raw) {
        return String.join(",", normalize(raw));
    }
}
```

这里的关键点：`legacy-sdk` 编译时拿到的是 Guava 33.7.2，所以 `toImmutableList()` 能编译通过，class 文件里记下的调用目标就是「Guava 33 的 ImmutableList.toImmutableList」。

### 3.3 app 模块（有问题的版本）

app 继承 Spring Boot 的 parent，依赖 `legacy-sdk`，同时留了一条历史遗留的 Guava 19.0 声明：

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
    <artifactId>app</artifactId>
    <version>1.0.0</version>
    <packaging>jar</packaging>

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
            <groupId>com.example</groupId>
            <artifactId>legacy-sdk</artifactId>
            <version>1.0.0</version>
        </dependency>

        <!-- 历史遗留：为兼容一段老代码写死的老版本 -->
        <dependency>
            <groupId>com.google.guava</groupId>
            <artifactId>guava</artifactId>
            <version>19.0</version>
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

启动类和接口写在一个文件里，方便直接跑：

```java
package com.example.app;

import com.example.legacy.NameService;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

@SpringBootApplication
@RestController
public class DepConflictDemoApplication {

    private final NameService nameService = new NameService();

    public static void main(String[] args) {
        SpringApplication.run(DepConflictDemoApplication.class, args);
    }

    @GetMapping("/names")
    public String names(@RequestParam(defaultValue = "alice,bob") List<String> names) {
        return nameService.join(names);
    }
}
```

### 3.4 复现

在根目录执行：

```bash
mvn clean install
mvn -pl app spring-boot:run
```

服务能正常启动。因为 Spring 启动过程没碰 Guava，问题藏着。然后另开一个终端：

```bash
curl "http://localhost:8080/names?names=alice,bob"
```

接口 500，应用日志里出现：

```
java.lang.NoSuchMethodError: com.google.common.collect.ImmutableList.toImmutableList()
    at com.example.legacy.NameService.lambda$normalize$2(NameService.java:16)
    at java.base/java.util.stream.ReferencePipeline.collect(ReferencePipeline.java:682)
    at com.example.legacy.NameService.normalize(NameService.java:16)
    at com.example.legacy.NameService.join(NameService.java:22)
    at com.example.app.DepConflictDemoApplication.names(DepConflictDemoApplication.java:24)
```

看到了吗？报错栈从 `NameService` 一路指到 Controller，但 `NameService` 的源码一个字都没改。它编译时用的 Guava 有这个方法，运行时 classpath 上却是 19.0。

### 3.5 定位

不要靠猜，直接让 Maven 把依赖树打出来。指定插件完整坐标，避免用到本机缓存里的老版本插件：

```bash
mvn org.apache.maven.plugins:maven-dependency-plugin:3.11.0:tree \
  -Dincludes=com.google.guava:guava
```

输出：

```
[INFO] com.example:app:jar:1.0.0
[INFO] +- com.example:legacy-sdk:jar:1.0.0:compile
[INFO] |  \- (com.google.guava:guava:jar:33.7.2-jre:compile - omitted for conflict with 19.0)
[INFO] \- com.google.guava:guava:jar:19.0:compile
```

关键就是 `omitted for conflict with 19.0` 这行。它明确告诉你：33.7.2 被 19.0 干掉了，因为 19.0 离根更近。很多人排查时只看第一层依赖，看不见这条括号里的信息，于是一直找不到原因。加 `-Dverbose` 能把所有被忽略的版本都列出来，树会很长，建议配合 `-Dincludes` 过滤。

### 3.6 修复

修法有三种，效果不一样。最省事的是把那条 19.0 删掉，让 `legacy-sdk` 带的 33.7.2 浮上来。但下一个人可能又加回来，所以更稳的做法是：用 `dependencyManagement` 锁死版本，再用 enforcer 插件把旧版本拦在门外。

下面是修好之后的完整 app pom：

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
    <artifactId>app</artifactId>
    <version>1.0.0</version>
    <packaging>jar</packaging>

    <properties>
        <java.version>21</java.version>
        <guava.version>33.7.2-jre</guava.version>
    </properties>

    <dependencyManagement>
        <dependencies>
            <dependency>
                <groupId>com.google.guava</groupId>
                <artifactId>guava</artifactId>
                <version>${guava.version}</version>
            </dependency>
        </dependencies>
    </dependencyManagement>

    <dependencies>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-web</artifactId>
            <version>4.1.1</version>
        </dependency>

        <dependency>
            <groupId>com.example</groupId>
            <artifactId>legacy-sdk</artifactId>
            <version>1.0.0</version>
        </dependency>
    </dependencies>

    <build>
        <plugins>
            <plugin>
                <groupId>org.springframework.boot</groupId>
                <artifactId>spring-boot-maven-plugin</artifactId>
                <version>4.1.1</version>
            </plugin>

            <plugin>
                <groupId>org.apache.maven.plugins</groupId>
                <artifactId>maven-enforcer-plugin</artifactId>
                <version>3.6.3</version>
                <executions>
                    <execution>
                        <id>ban-old-guava</id>
                        <goals>
                            <goal>enforce</goal>
                        </goals>
                        <configuration>
                            <rules>
                                <bannedDependencies>
                                    <excludes>
                                        <exclude>com.google.guava:guava:[,30)</exclude>
                                    </excludes>
                                    <message>禁止使用 Guava 30 以下的版本，请通过 dependencyManagement 统一版本</message>
                                </bannedDependencies>
                            </rules>
                            <fail>true</fail>
                        </configuration>
                    </execution>
                </executions>
            </plugin>
        </plugins>
    </build>
</project>
```

`dependencyManagement` 里的版本会压过所有传递依赖，不管谁带进来的、路径有多近。enforcer 那段是保险：以后再有人手写一条旧版本，`mvn validate` 阶段就会失败，不用等到线上才发现。

改完重新构建、启动、请求：

```bash
mvn clean install
mvn -pl app spring-boot:run
curl "http://localhost:8080/names?names=alice,bob"
```

返回 `ALICE,BOB`。再查一次依赖树，19.0 已经消失了：

```
[INFO] com.example:app:jar:1.0.0
[INFO] \- com.example:legacy-sdk:jar:1.0.0:compile
[INFO]    \- com.google.guava:guava:jar:33.7.2-jre:compile
```

## 四、踩过的坑和几条硬规矩

**只看直接依赖，等于没查。** 冲突九成来自传递依赖。排查第一步永远是 `dependency:tree`，而且要带 `-Dincludes` 精确过滤，不然几千行输出根本看不过来。

**IDE 不报错不代表没问题。** IDEA 的 Maven 面板展示的是它自己索引出来的依赖，和 `mvn` 命令行算出来的偶尔不一致，尤其是多模块工程改了 pom 没重新导入的时候。以命令行结果为准，别跟 IDE 较劲。

**exclusion 是手术刀，不是锤子。** 排除一个传递依赖，可能连带把功能排掉。比如排掉 `spring-boot-starter-logging`，日志直接没了；排掉某个 SDK 的 `okhttp`，运行时才报 `ClassNotFoundException`。用完记得跑一遍完整回归。

**多模块工程要先 install。** 只执行 `mvn -pl app spring-boot:run`，本地仓库里没有 `legacy-sdk` 就会报找不到依赖。要么先 `mvn install`，要么加 `-am` 让 Maven 顺带构建上游模块。

**别拿 `dependency:analyze` 当冲突检测工具。** 它查的是「声明了没用」和「用了没声明」，跟版本冲突是两码事。真要看冲突，用 `dependency:tree -Dverbose`。

**升级 Spring Boot 大版本时，BOM 会换血。** 原来被管住的包可能不再被管，原来锁的版本可能和新的 BOM 打架。升级后重新跑一次依赖树，比事后排查便宜得多。

**测试通过不等于运行通过。** `test` scope 的依赖只在测试 classpath 上，单测能跑通、打包后缺类，这种事故年年都有。打包完用 `java -jar` 真跑一次，别偷懒。

## 五、几种修法怎么选

| 做法 | 作用范围 | 优点 | 缺点 | 适用场景 |
| --- | --- | --- | --- | --- |
| 直接声明新版本 | 单个 artifact | 一行搞定 | 只压住这一处，别处还会带进来 | 临时救火 |
| `dependencyManagement` | 整个工程 | 全局统一，传递依赖也生效 | 版本要自己维护 | 首选方案 |
| `exclusions` | 指定依赖 | 精准 | 容易误伤，维护成本高 | 明确知道不需要该传递依赖 |
| enforcer 插件 | 构建阶段 | 提前失败，防回归 | 需要写规则 | 团队协作、长期项目 |
| shade relocation | 打包产物 | 彻底隔离，各用各的 | 包变大，调试麻烦 | 两个 SDK 死活不能统一版本 |

我的建议很直接：常规项目用 `dependencyManagement` 统一版本，配一条 enforcer 规则挡住已知的坏版本。这两步加起来不到二十行配置，能省掉大量「线上突然 NoSuchMethodError」的夜晚。

`exclusions` 留给真正确定不需要的依赖，别拿它当万能药。shade relocation 是最后手段，只有两个第三方 SDK 互相锁死、谁都不肯升级时才考虑，代价是构建变慢、栈变难读。

## 六、总结

依赖冲突的根因不是版本旧，而是「运行时加载的类」和「编译时看到的类」不是同一个。

记住三件事就够了：

- Maven 选版本看路径远近，不看版本号大小；同距离看声明顺序。
- `dependencyManagement` 能覆盖一切传递依赖，Spring Boot 的 BOM 就是这么工作的，但它只管自己名单里的包。
- 排查靠 `mvn dependency:tree -Dincludes=groupId:artifactId`，不要靠猜、不要靠升级框架碰运气。

真要在团队里推一条规矩，就推这条：任何跨模块共用的第三方库，版本只能出现在 `dependencyManagement` 里，别散落在各个模块的 `<dependencies>` 中。版本一旦集中，冲突就从「玄学」变成了「改一行」。

文 / 会编程的吕洞宾

## 参考资料

- [Introduction to the Dependency Mechanism](https://maven.apache.org/guides/introduction/introduction-to-dependency-mechanism.html)
- [Banned Dependencies](https://maven.apache.org/enforcer/enforcer-rules/bannedDependencies.html)
- [Apache Maven Dependency Plugin – dependency:tree](https://maven.apache.org/plugins/maven-dependency-plugin/tree-mojo.html)
- [Spring Boot Maven Plugin](https://docs.spring.io/spring-boot/maven-plugin/index.html)
