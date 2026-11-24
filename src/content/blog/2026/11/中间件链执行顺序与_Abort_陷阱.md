---
title: Gin 中间件链执行顺序与 Abort 陷阱
date: 2026-11-24 14:47:25
tags: ["Go", "Gin", "中间件"]
categories: go
---

# Gin 中间件链执行顺序与 Abort 陷阱

前段时间帮人看一个后台接口：鉴权失败时客户端收到的是 HTTP 200，body 里是正常业务数据，日志里还夹着一句：

```
http: superfluous response.WriteHeader call from main.AuthRequired.func1 (auth.go:23)
```

代码不长，写的人也很自信："我先 c.Next() 放行，再判断有没有登录，没登录就返回 401。" 逻辑读起来通顺，跑起来完全是另一回事。问题不在 Gin 有什么隐藏坑，而在于没人真的搞清楚 c.Next() 干了什么。

## 先把链子拆开

打开 gin 的 context.go，Context 上有两个字段值得盯：

```go
// 摘自 gin context.go，删掉了无关字段
type Context struct {
	index    int8
	handlers HandlersChain
	// ...
}
```

index 是"当前跑到第几个"，handlers 是这条路由最后拼出来的函数切片。整条链的驱动逻辑一共就十几行，我把它抽成一个能直接跑的独立程序，行为跟 gin 一模一样：

```go
// chain.go
package main

import "fmt"

const abortIndex int8 = 63

type Context struct {
	handlers []func(*Context)
	index    int8
}

func (c *Context) Next() {
	c.index++
	for c.index < int8(len(c.handlers)) {
		c.handlers[c.index](c)
		c.index++
	}
}

func (c *Context) Abort() {
	c.index = abortIndex
}

func (c *Context) Aborted() bool {
	return c.index >= abortIndex
}

func run(name string, handlers ...func(*Context)) {
	fmt.Println("==", name)
	c := &Context{handlers: handlers}
	c.Next()
	fmt.Println("aborted:", c.Aborted())
}

func main() {
	run("正常嵌套",
		func(c *Context) { fmt.Println("A before"); c.Next(); fmt.Println("A after") },
		func(c *Context) { fmt.Println("B before"); c.Next(); fmt.Println("B after") },
		func(c *Context) { fmt.Println("handler") },
	)

	run("中途 Abort",
		func(c *Context) { fmt.Println("A before"); c.Next(); fmt.Println("A after") },
		func(c *Context) { fmt.Println("B 拦截"); c.Abort() },
		func(c *Context) { fmt.Println("handler 不会执行") },
	)
}
```

输出：

```
== 正常嵌套
A before
B before
handler
B after
A after
aborted: false
== 中途 Abort
A before
B 拦截
A after
aborted: true
```

这段输出就是理解 Gin 中间件的全部钥匙。注意 "B after" 在 "A after" 前面——"after" 部分是倒着出来的。

## c.Next() 不是"下一行"，是"跑到头再回来"

看 Next() 的实现：它自己就带一个 for 循环。

所以 A 里调用 c.Next()，进入的是一个新的循环，这个循环从 B 开始一路把 B、handler 全部执行完，index 被推到末尾，才返回 A。A 拿到控制权的时候，后面的东西早就跑完了。

这也解释了为什么每个 handler 只执行一次：内层 Next() 已经把 index 顶到了 len(handlers)，外层循环再 index++ 直接越界退出，不会重来一遍。

一句话：c.Next() 是"放行"，不是"前进一格"。写中间件时脑子里要有洋葱，不是队列。

洋葱模型还决定了数据怎么传。中间件在 c.Next() 之前 c.Set("uid", id)，后面的业务 handler 用 c.Get 就能拿到，因为大家操作同一个 Context；反过来，业务 handler 里 Set 的东西，中间件在 c.Next() 之后也读得到。这让"先设值、后收尾"成为可能，也是很多耗时统计、错误聚合中间件的写法基础。

但别把 c 当全局变量使。c.Keys 内部带锁，高频请求下往同一个 key 上反复写，竞争是实打实的。能塞进 request context 的东西就塞 context，除非你就是图省事。

## 鉴权中间件写完 401 还继续跑

现在回头看那段出问题的代码，大概是这么写的：

```go
// 错误写法
func AuthRequired() gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Next() // 先把业务跑了
		if c.GetHeader("Authorization") == "" {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
		}
	}
}
```

c.Next() 返回时，业务 handler 已经把 200 和 body 写出去了。HTTP 响应头一旦发出就没法改，你这时候再 c.JSON(401, ...)，gin 只能往已经打开的连接里再塞一段 JSON，日志里就出现那句 superfluous response.WriteHeader，客户端看到的仍然是 200。

正确顺序是：先判断，不通过就 AbortWithStatusJSON 然后 return；通过了再 c.Next()。

```go
func AuthRequired() gin.HandlerFunc {
	return func(c *gin.Context) {
		if c.GetHeader("Authorization") != "Bearer secret" {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
			return
		}
		c.Next()
	}
}
```

这里 AbortWithStatusJSON 干了三件事：写状态码和响应体、调用 Abort()、停止后续 handler。中间的 return 是给自己用的，防止当前函数继续往下走。

## Abort 只停链，不撤销任何已经发生的事

Abort() 的实现朴素得过分：c.index = 63。因为 63 一定大于任何合理长度的 handler 链，循环条件 c.index < len(handlers) 直接不成立，后面的 handler 就进不来了。

它有三个"不"：

- 不影响当前函数。Abort() 后面的语句照样执行，所以基本都得配 return。
- 不撤销已经写出去的响应。
- 不给你兜底状态码。Abort() 完什么都不写，gin 在 handleHTTPRequest 最后会调一次 WriteHeaderNow()，客户端拿到的是一个 200 空 body。拦截了请求却返回 200，监控和网关都会懵。

只用 Abort() 不写响应，是个很常见的半成品。

## 日志中间件的状态码为什么总是 200

统计中间件爱这么写：

```go
func AccessLog() gin.HandlerFunc {
	return func(c *gin.Context) {
		start := time.Now()
		c.Next()
		log.Printf("%s %s %d %v", c.Request.Method, c.Request.URL.Path,
			c.Writer.Status(), time.Since(start))
	}
}
```

c.Writer.Status() 在没写响应之前就返回 200（responseWriter 初始化时 status 就是 200），c.Writer.Size() 在没写 body 之前返回 -1。所以这两个值必须在 c.Next() 之后读，这是对的；读之前要判断 c.Writer.Written()，否则你会把"没写响应"和"写了 200"混为一谈。

另一个更隐蔽的点：panic 之后还能不能拿到 500，取决于中间件注册顺序。

gin.Default() 里是 Logger() 先、Recovery() 后。Logger 在外层，Recovery 在内层，panic 被内层 recover 掉、写入 500，控制权顺着 Next() 的调用栈回到外层 Logger，这时候 c.Writer.Status() 已经是 500 了。要是你把 gin.Recovery() 放在 AccessLog() 前面，日志里就永远看不到 5xx。

顺序不是随便排的：越靠前的中间件，看到的越多，也越"外层"。

还有个真的会搞挂进程的：在 handler 里 go func() 起协程，协程里 panic，gin.Recovery() 抓不到。recover 只对同一个 goroutine 的 panic 有效。这种 panic 会直接把整个服务带走。子协程里要么自己 defer recover，要么别起。

## 统一错误响应：c.Error 加 Written 判断

既然 Abort 之后不好收场，那让业务 handler 别自己写错误、只做登记，由最外层中间件统一输出，是更稳的做法。

```go
func ErrorHandler() gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Next()
		if len(c.Errors) == 0 || c.Writer.Written() {
			return
		}
		err := c.Errors.Last()
		status := http.StatusInternalServerError
		if err.Type == gin.ErrorTypeBind {
			status = http.StatusBadRequest
		}
		c.JSON(status, gin.H{"error": err.Error()})
	}
}
```

业务里写 c.Error(errors.New("库存不足"))，不再手写 c.JSON。那句 c.Writer.Written() 判断不能省——有些 handler 已经把响应写好了又顺手 Error 一下，你不判断就会再叠一层 JSON，还是同一个 superfluous 报错。

这个模式有前提：ErrorHandler 必须注册在链的最外层，业务 handler 里也别再 AbortWithStatus。两种风格混着用，早晚出事。

## 指标标签别用 URL.Path

Prometheus 的 HTTP 请求指标，标签写 c.Request.URL.Path，上线第一天标签基数就爆了：/api/user/1001、/api/user/1002 每个 ID 一条时间序列，几小时后内存开始报警，查面板还得翻五分钟。

用 c.FullPath()，它返回注册时的路由模板 /api/user/:id，基数可控，完整实现在最后那段程序里。

没匹配到路由时 c.FullPath() 返回空字符串，404 会全落到 unmatched 上，比几十条随机路径好得多。别问我怎么知道的。

## 超时中间件管不住 handler

很多人写过一个"超时中间件"：context.WithTimeout 包一下 c.Request.Context()，c.Next()，再加个 select 等超时，到点就 AbortWithStatus(504)。

它不生效。c.Next() 是同步调用，会一直阻塞到业务 handler 返回，中间件在那段时间里根本没有机会插手。业务该跑多久还跑多久，504 只会在它跑完之后才写出去。

真想限时只有两条路：业务 handler 自己 select ctx.Done()（这样换过的 context 才有意义），或者用 http.TimeoutHandler 这类在连接层动手的包装。gin-contrib/timeout 靠独立 goroutine 加 channel 模拟，能兜住响应，但业务 goroutine 照样在跑——超时之后它可能还在写数据库。

超时本质是协议层的问题，别指望中间件把已经跑起来的函数掐死。Go 没有这个能力。

## 在子协程里用 *gin.Context

```go
func Async() gin.HandlerFunc {
	return func(c *gin.Context) {
		cc := c.Copy() // 用副本，别把原 c 传出去
		go func() {
			time.Sleep(100 * time.Millisecond)
			log.Println(cc.Request.URL.Path)
		}()
		c.JSON(http.StatusOK, gin.H{"ok": true})
	}
}
```

c.Copy() 复制的是 Context 结构，Request.Context() 该取消还是会取消——请求结束、或者客户端断开，这个 context 就 done 了。异步任务要一个不随请求取消的 context，用 context.WithoutCancel(c.Request.Context()) 再套上自己的超时，不要直接复用。

顺带一提：如果异步任务里要写响应，别写，请求早就返回了。

## Use 和 Group 的注册时机

两个时机问题，踩的人不少。

第一，r.Use() 写在路由注册之后，对已经注册的路由无效。路由注册时 combineHandlers 就把当时的中间件复制进了那条路由的 handlers 切片，之后再 Use 只是改 engine 自己的模板。

第二，g := r.Group("/v1") 创建分组时也会立刻复制父级中间件。之后再对 r 调 Use，不会影响已经建好的 g。

工程上的结论很土但很有用：中间件统一在文件开头注册，路由往下排。中间别插 Use。

## 拼一个能跑的组合

把前面几块拼起来，一个能直接上线的骨架：

```go
// go.mod
module example.com/ginmw

go 1.27.4

require (
	github.com/gin-gonic/gin v1.12.0
	github.com/prometheus/client_golang v1.25.0
)
```

只写直接依赖，剩下的 go mod tidy 会补齐。

```go
// main.go
package main

import (
	"errors"
	"log"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

var reqDuration = prometheus.NewHistogramVec(
	prometheus.HistogramOpts{
		Name:    "http_request_duration_seconds",
		Help:    "HTTP 请求耗时分布",
		Buckets: prometheus.DefBuckets,
	},
	[]string{"method", "route", "status"},
)

func init() {
	prometheus.MustRegister(reqDuration)
}

// AccessLog 在最外层：它看到的状态码才是最终的
func AccessLog() gin.HandlerFunc {
	return func(c *gin.Context) {
		start := time.Now()
		c.Next()
		if !c.Writer.Written() {
			return
		}
		log.Printf("%s %s -> %d (%v, %d bytes)",
			c.Request.Method, c.Request.URL.Path,
			c.Writer.Status(), time.Since(start), c.Writer.Size())
	}
}

// Metrics 用路由模板做标签，避免时间序列爆炸
func Metrics() gin.HandlerFunc {
	return func(c *gin.Context) {
		start := time.Now()
		c.Next()
		route := c.FullPath()
		if route == "" {
			route = "unmatched"
		}
		reqDuration.WithLabelValues(c.Request.Method, route, strconv.Itoa(c.Writer.Status())).
			Observe(time.Since(start).Seconds())
	}
}

// ErrorHandler 统一收口：业务只登记，不自己写响应
func ErrorHandler() gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Next()
		if len(c.Errors) == 0 || c.Writer.Written() {
			return
		}
		err := c.Errors.Last()
		status := http.StatusInternalServerError
		if err.Type == gin.ErrorTypeBind {
			status = http.StatusBadRequest
		}
		c.JSON(status, gin.H{"error": err.Error()})
	}
}

func AuthRequired() gin.HandlerFunc {
	return func(c *gin.Context) {
		if c.GetHeader("Authorization") != "Bearer secret" {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
			return
		}
		c.Next()
	}
}

func main() {
	r := gin.New()
	// 由外到内：日志、指标、错误收口、panic 恢复
	r.Use(AccessLog(), Metrics(), ErrorHandler(), gin.Recovery())

	r.GET("/metrics", gin.WrapH(promhttp.Handler()))

	r.GET("/ping", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"msg": "pong"})
	})

	api := r.Group("/api", AuthRequired())
	api.GET("/me", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"user": "lvdonbin"})
	})
	api.GET("/boom", func(c *gin.Context) {
		c.Error(errors.New("库存不足"))
	})

	srv := &http.Server{
		Addr:              ":8080",
		Handler:           r,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      15 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}
```

跑起来之后 curl 带上 Authorization 头访问 /api/boom，返回的是 500 加统一格式的错误体；不带头的访问 /api/me，是干净的 401。这时候再回去看 `c.Next()` 那十几行，会顺眼很多。

r.Run() 也能跑，但它内部就是一个几乎没设超时的 http.Server。暴露在公网的服务，四个超时得自己写清楚，慢连接拖住 goroutine 是很老套但一直有效的小成本攻击。

## 最后一句

Gin 的中间件模型本身没毛病，毛病都出在把它当"按行执行的队列"来理解。记住 c.Next() 是放行到链尾再回来，Abort() 只是把 index 扔到 63，剩下的全是常识问题。

写中间件之前，先问自己一句：我这行代码，是在写响应之前跑的，还是之后？

## 参考资料

- [gin.Context 的 Next / Abort 文档](https://pkg.go.dev/github.com/gin-gonic/gin#Context.Next)
- [gin 源码 context.go](https://github.com/gin-gonic/gin/blob/master/context.go)
- [gin 源码 gin.go（handleHTTPRequest 与 WriteHeaderNow）](https://github.com/gin-gonic/gin/blob/master/gin.go)
- [net/http Server 的超时字段](https://pkg.go.dev/net/http#Server)

文 / 会编程的吕洞宾
