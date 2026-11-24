---
title: Python 写 MCP 服务：工具、挂载与鉴权
date: 2026-11-24 13:20:11
tags: ["Python", "MCP", "AI", "FastAPI"]
categories: python
---

# Python 写 MCP 服务：工具、挂载与鉴权

上个月同事来找我，说想让 Cursor 直接查生产库的订单。

他的方案是把订单表结构贴进提示词，让模型自己拼 SQL。我没批。不是怕它拼错，是怕它拼对——拼错了顶多报个错，拼对了就意味着模型能自由查询任何一张表，而我没地方去限制它到底能查什么。

后来这件事做成了一个 MCP 服务。模型只能调 `get_order` 和 `search_orders` 两个函数，参数由 schema 卡死，查谁、查几条，代码说了算。

这套东西跑了两周，踩的坑基本都在「怎么挂进现有服务」这一段，不在工具本身。代码和过程整理在下面。

## MCP 不是新协议，是新约定

手写 function calling 的人都经历过这种循环：给模型描述工具，写一份 JSON Schema，然后每个客户端再抄一遍；模型传错参数，你自己校验、自己写错误提示；接口改了个字段名，Schema 忘了同步，模型开始胡编参数。

MCP（Model Context Protocol）把这一坨标准化了。服务端声明有哪些工具、每个工具吃什么参数、返回什么结构，客户端负责连接和调用，协议本身走 JSON-RPC。写一个服务端，Cursor、Claude Desktop、你自己写的 Agent 都能接——这就是它比「每个客户端写一遍胶水代码」值钱的地方。

传输层只有两种需要记：

- `stdio`：宿主把你的脚本拉起来当子进程，用 stdin/stdout 通信。本地开发和桌面客户端走这条。
- `streamable-http`：一个真正的 HTTP 端点。要部署的东西都走这条。

至于 SSE，它已经被 Streamable HTTP 取代了。SDK 里还留着，是为了兼容没升级的客户端，新项目别往上建。我之前有个项目就建在 SSE 上，后来客户端一升级，整条链路得重做。

## 类型注解就是 schema

先看能跑的最小版本。

```python
from mcp.server import MCPServer

mcp = MCPServer("demo")


@mcp.tool()
def add(a: int, b: int) -> int:
    """两数相加。"""
    return a + b


if __name__ == "__main__":
    mcp.run()
```

没有 JSON Schema，没有参数解析，没有协议处理。`a: int, b: int` 本身就是 schema。

有个细节得提醒：老代码里的类叫 `FastMCP`，从 `mcp.server.fastmcp` 导入。这个导入路径现在直接没了——不是标了弃用，是删掉。网上那些教程照抄过来，第一行就报 `ModuleNotFoundError`。名字现在是 `MCPServer`。

跑起来看效果：

```bash
uv run --with "mcp[cli]" mcp dev server.py
```

会拉起 Inspector，用 stdio 连你的脚本，能在网页里点着调工具，不用写客户端。

顺便一句：docstring 不是注释，它是工具描述，模型靠这段话决定调不调你。`"""查订单"""` 这种等于没写，写清楚「按订单号查明细、状态和金额，订单号形如 A1001」，模型选错工具的概率会低很多。

## 返回值有两个通道

这块是我一开始没搞明白、后来觉得设计得挺聪明的地方。

```python
from mcp.server import MCPServer
from pydantic import BaseModel, Field

mcp = MCPServer("weather")


class WeatherData(BaseModel):
    temperature: float = Field(description="摄氏度")
    humidity: float = Field(description="相对湿度，0 到 1")
    conditions: str


@mcp.tool()
def get_weather(city: str) -> WeatherData:
    """查某个城市的当前天气。"""
    return WeatherData(temperature=16.2, humidity=0.83, conditions="阴")
```

返回类型注解 `-> WeatherData` 会被编译成工具的 `output_schema`。调用之后，结果里有两个字段：

- `content`：给**模型**看的。SDK 把对象序列化成 JSON 文本塞进去。
- `structured_content`：给**调用方程序**看的。就是你返回的那个对象，一个字段不多一个字段不少。

`Field(description=...)` 同时进输入和输出两边，跟 FastAPI 的 `response_model` 是一个路子。你只返回一个 Python 对象，两个通道由 SDK 填。

为什么拆两份？语言模型只读文本，而你的代码想要的是 `{"temperature": 16.2}`，不是一句「16.2 摄氏度」。

## 真实一点的服务

演示代码不碰数据源，等于没写。下面这个是能直接跑的完整服务，仓储挂在 lifespan 上——生产里换成连接池、Redis 客户端、内部 API 客户端，位置一样。

`requirements.txt`：

```
# Python 3.13
mcp==2.3.0
pydantic==2.14.4
fastapi==0.165.0
uvicorn==0.54.0
httpx2==2.16.2
```

`order_mcp/server.py`：

```python
from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass

from mcp.server import MCPServer
from mcp.server.mcpserver import Context
from pydantic import BaseModel, Field


class OrderItem(BaseModel):
    sku: str
    title: str
    quantity: int = Field(description="件数")
    unit_price: float = Field(description="单价，单位：元")


class OrderDetail(BaseModel):
    order_id: str
    customer_email: str
    status: str = Field(description="paid / shipped / refunded 之一")
    items: list[OrderItem]
    total_amount: float = Field(description="订单总额，单位：元")


class OrderSearchResult(BaseModel):
    orders: list[OrderDetail]
    matched: int = Field(description="命中条数，可能超过返回的 orders 长度")


class OrderStore:
    """演示用的内存仓储。生产里换成数据库连接池或内部 API 客户端。"""

    def __init__(self) -> None:
        self._orders: dict[str, OrderDetail] = {}

    def add(self, order: OrderDetail) -> None:
        self._orders[order.order_id] = order

    def get(self, order_id: str) -> OrderDetail | None:
        return self._orders.get(order_id)

    def find_by_email(self, email: str, limit: int) -> tuple[list[OrderDetail], int]:
        hits = [o for o in self._orders.values() if o.customer_email == email]
        return hits[:limit], len(hits)

    def close(self) -> None:
        self._orders.clear()


@dataclass
class AppContext:
    store: OrderStore


def build_store() -> OrderStore:
    store = OrderStore()
    store.add(
        OrderDetail(
            order_id="A1001",
            customer_email="li.lei@example.com",
            status="shipped",
            items=[
                OrderItem(sku="KB-87", title="机械键盘 87 键", quantity=1, unit_price=499.0),
                OrderItem(sku="MP-01", title="鼠标垫", quantity=2, unit_price=39.0),
            ],
            total_amount=577.0,
        )
    )
    store.add(
        OrderDetail(
            order_id="A1002",
            customer_email="li.lei@example.com",
            status="paid",
            items=[OrderItem(sku="HD-10", title="显示器支架", quantity=1, unit_price=259.0)],
            total_amount=259.0,
        )
    )
    return store


@asynccontextmanager
async def app_lifespan(server: MCPServer) -> AsyncIterator[AppContext]:
    store = build_store()
    try:
        yield AppContext(store=store)
    finally:
        store.close()


mcp = MCPServer("order-tools", lifespan=app_lifespan)


@mcp.tool()
def get_order(order_id: str, ctx: Context[AppContext]) -> OrderDetail:
    """按订单号查一张订单的明细、状态和金额。订单号形如 A1001。"""
    order = ctx.request_context.lifespan_context.store.get(order_id)
    if order is None:
        raise ValueError(f"订单 {order_id} 不存在")
    return order


@mcp.tool()
def search_orders(
    customer_email: str,
    ctx: Context[AppContext],
    limit: int = 10,
) -> OrderSearchResult:
    """按客户邮箱查她名下的订单，用于客服核对历史记录。limit 为返回条数上限。"""
    orders, matched = ctx.request_context.lifespan_context.store.find_by_email(
        customer_email, limit
    )
    return OrderSearchResult(orders=orders, matched=matched)


if __name__ == "__main__":
    mcp.run(transport="streamable-http", port=8000)
```

几个点单独说。

**`Context[AppContext]` 那个泛型别省。** 写成光秃秃的 `Context`，`lifespan_context` 在类型检查器眼里就是 `dict[str, Any]`，`.store` 不会补全，拼错了要到运行时才炸。带上类型参数，`.store` 是 `OrderStore`，编辑器直接认。运行时的对象一直都在，你丢掉的只是那点帮助。

**`ctx` 不会进 schema。** 它是 SDK 注入的，模型能看见的参数只有 `order_id`、`customer_email`、`limit`。连接池这种东西本来就该藏在服务端。

**同步函数会被扔到线程里跑。** 文档写得很直白：普通的 `def` 工具，SDK 放到线程里执行，不阻塞服务；`async def` 则直接 await。所以查数据库、调内部 HTTP 这类阻塞活，用 `def` 加同步客户端就够了。别为了「异步」硬套 `async def`，然后在里面调同步驱动——那才是真的把事件循环堵死，一个慢查询拖垮整个服务。

**参数校验不用你管。** 模型把字符串传给 `limit`，SDK 会拒掉，并且把错误以模型能读懂的形式返回，它能自己改。

## 查不到的时候，别抛异常

上面 `get_order` 里那句 `raise ValueError` 是我最初写的版本。跑起来才发现，模型收到的是这个：

```
Error executing tool get_order
```

我那句中文明明白白写着的「订单 A1001 不存在」，只出现在服务端日志里。模型不知道自己错在哪，于是换个订单号再试，试到第三次开始编订单号。

想让模型能自我纠正，就得把「没找到」当成一种正常结果返回，而不是异常。`order_mcp/lookup.py`：

```python
from __future__ import annotations

from mcp.server import MCPServer
from pydantic import BaseModel, Field

ORDERS = {"A1001": "shipped", "A1002": "paid"}

mcp = MCPServer("order-lookup")


class OrderLookup(BaseModel):
    found: bool = Field(description="是否查到该订单")
    order_id: str
    status: str | None = Field(default=None, description="找不到时为 null")


@mcp.tool()
def get_order(order_id: str) -> OrderLookup:
    """按订单号查订单状态。查不到时 found 为 false，换一个订单号再试没有意义。"""
    status = ORDERS.get(order_id)
    if status is None:
        return OrderLookup(found=False, order_id=order_id)
    return OrderLookup(found=True, order_id=order_id, status=status)


if __name__ == "__main__":
    mcp.run()
```

生成的 schema 里 `status` 是 `anyOf: [string, null]`，`found` 是必填布尔。模型看到 `{"found": false, "order_id": "X", "status": null}`，就知道该换参数或者直接告诉用户查不到，而不是瞎重试。

这是这件事上我最实在的一条经验：**工具返回的错误信息是给模型看的产品文案，不是给运维看的日志。** 异常路径留给真正的 bug，业务上的「没有」用结构化结果表达。

## 挂进 FastAPI：三个坑

大部分人的 MCP 服务不会是独立进程，而是现有后端的一部分。SDK 给了 `mcp.streamable_http_app()`，返回一个 Starlette 应用，任何能跑 ASGI 的东西都能托管它。

`order_mcp/api.py`：

```python
from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI

from order_mcp.server import mcp


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    async with mcp.session_manager.run():
        yield


app = FastAPI(lifespan=lifespan)


@app.get("/healthz")
async def healthz() -> dict[str, str]:
    return {"status": "ok"}


app.mount("/agent", mcp.streamable_http_app())
```

坑一，**路径是拼出来的。** `Mount("/agent", ...)` 加上默认的 `streamable_http_path="/mcp"`，最终端点是 `/agent/mcp`。少写一层就是 404，而 MCP 客户端报的会是「连接异常」，看不出是路径问题。

坑二，**`Mount` 会吃掉它后面的路由。** Starlette 按顺序匹配，`Mount("/agent")` 只吃 `/agent/*`，但如果你按某些示例那样 `Mount("/")`，它匹配一切，健康检查和业务接口全被挡在后面。自定义路由写在挂载之前，这条别省。

坑三，也是最贵的那个：**宿主的 lifespan 必须手动启动 session manager。**

`streamable_http_app()` 返回的那个 Starlette 自带 lifespan，里面负责 `mcp.session_manager.run()`。但只要它被 `Mount` 进去，子应用的 lifespan 就不执行了——Starlette 不跑子应用的 lifespan，那段代码变成死代码。

现象特别迷惑：服务能起来，`/healthz` 正常，端口通，工具列表也能拉到，但真正调工具的时候客户端直接抛异常。服务端日志里是：

```
RuntimeError: Task group is not initialized. Make sure to use run().
```

客户端那一侧看不到这句话，只有一个 `ExceptionGroup`。我第一次排查了一下午，因为在客户端这边怎么看都像网络问题。

修法就是把 session manager 提到宿主应用的 lifespan 里，也就是上面那段 `async with mcp.session_manager.run()`。要挂多个 MCP 服务，用 `AsyncExitStack` 一个个进，它们一起启动、倒序关闭。

还有个前提：`streamable_http_app()` 得在模块级调用，因为 `mcp.session_manager` 是它建出来的，lifespan 里才有东西可以启动。

启动命令用 `uvicorn order_mcp.api:app`，别用 `python order_mcp/api.py`。后者会把脚本所在目录塞进 `sys.path`，包内导入直接报 `ModuleNotFoundError`。我在这上面浪费过十分钟。

## 客户端：读结构化结果

`order_mcp/client_demo.py`：

```python
import asyncio

from mcp import Client


async def main() -> None:
    async with Client("http://127.0.0.1:8000/agent/mcp") as client:
        tools = await client.list_tools()
        print("tools:", [t.name for t in tools.tools])

        result = await client.call_tool("get_order", {"order_id": "A1001"})
        print("structured:", result.structured_content)
        print("text:", result.content[0].text)

        found = await client.call_tool(
            "search_orders", {"customer_email": "li.lei@example.com"}
        )
        print("search:", found.structured_content)

        bad = await client.call_tool("get_order", {"order_id": "NOPE"})
        print("is_error:", bad.is_error)


if __name__ == "__main__":
    asyncio.run(main())
```

`Client(...)` 只是选传输，构造时不连；`async with` 才真正连上并协商协议版本。传 URL 走 Streamable HTTP，传 `StdioServerParameters` 走 stdio 子进程，传 server 对象走内存——写单元测试用最后这种，不用起端口。

拿结果请用 `structured_content`，别去正则解析 `content[0].text` 里那坨 JSON。前者是对象，后者是给模型看的字符串，字段顺序、缩进都不保证。

要带鉴权，就自己建 HTTP 客户端。`order_mcp/client_auth.py`：

```python
import asyncio
import os

import httpx2
from mcp import Client
from mcp.client.streamable_http import streamable_http_client


async def main() -> None:
    token = os.environ["MCP_TOKEN"]
    async with httpx2.AsyncClient(
        headers={"Authorization": f"Bearer {token}"},
        timeout=httpx2.Timeout(30.0, read=300.0),
    ) as http_client:
        transport = streamable_http_client(
            "http://127.0.0.1:8000/agent/mcp",
            http_client=http_client,
        )
        async with Client(transport) as client:
            result = await client.call_tool("get_order", {"order_id": "A1001"})
            print(result.structured_content)


if __name__ == "__main__":
    asyncio.run(main())
```

两个细节：`httpx2` 是你自己建的，进出也由你负责，SDK 不会替你关；`timeout` 必须显式给，它默认读超时才 5 秒，工具跑久一点就超时，而 SDK 自己用的是 30 秒连接、300 秒读。

## 上线前，三件事

**一、Host 白名单。** 这个坑我实测撞了。`streamable_http_app()` 不知道你会挂在哪个域名后面，于是默认只放行 `127.0.0.1`、`localhost`、`[::1]`，其他一律：

```
HTTP/1.1 421 Misdirected Request
Invalid Host header
```

反代做好、域名解析好，请求全 421，而错误只在服务端日志里，客户端那边还是个笼统的传输错误。放行要显式传。`order_mcp/api_deploy.py`：

```python
from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import uvicorn
from fastapi import FastAPI
from mcp.server.transport_security import TransportSecuritySettings

from order_mcp.server import mcp

security = TransportSecuritySettings(
    allowed_hosts=["mcp.shop.example.com", "mcp.shop.example.com:*"],
    allowed_origins=["https://console.shop.example.com"],
)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    async with mcp.session_manager.run():
        yield


app = FastAPI(lifespan=lifespan)
app.mount("/agent", mcp.streamable_http_app(transport_security=security))


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8000)
```

`allowed_hosts` 是精确匹配：`"mcp.shop.example.com"` 匹配不带端口的 Host，`"mcp.shop.example.com:*"` 匹配任意端口，两个都写。`allowed_origins` 是给浏览器客户端的。

有个参数叫 `host=`，看着像能解决，其实它只关掉默认的本地保护，等于对所有 Host 敞开。别拿它糊弄过去。

**二、鉴权。** MCP 端点就是一个 HTTP 端点，没有内置用户体系。挂在网关后面走统一的 Bearer 校验，或者接 SDK 的授权支持走 OAuth。别指望「模型不会乱调」——它连参数类型都能编，何况 URL。

**三、工具粒度。** 只读工具先上；参数必须显式，默认值越少，模型越难猜错；单个工具内部做条数上限和限流。写操作要么不做，要么设计成「返回一个待确认的变更」由人点确认。我到现在都没给模型开直接改订单状态的工具，不是技术上做不到。

先让它查，别急着让它改。真想让它动手的时候，你会希望自己当初多留了一道闸。

## 参考资料

- [MCP Python SDK 文档](https://py.sdk.modelcontextprotocol.io/)
- [Add to an existing app](https://py.sdk.modelcontextprotocol.io/run/asgi/)
- [Structured Output](https://py.sdk.modelcontextprotocol.io/servers/structured-output/)
- [Lifespan](https://py.sdk.modelcontextprotocol.io/handlers/lifespan/)
- [MCP 规范](https://modelcontextprotocol.io/specification/latest)

文 / 会编程的吕洞宾
