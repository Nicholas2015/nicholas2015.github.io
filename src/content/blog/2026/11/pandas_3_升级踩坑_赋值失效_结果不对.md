---
title: pandas 3 升级踩坑：赋值失效，结果不对
date: 2026-11-23 22:19:15
tags: ["Python", "pandas", "数据处理", "版本迁移"]
categories: python
---

# pandas 3 升级踩坑：赋值失效，结果不对

两周前把一条跑了两年多的订单清洗脚本升到 pandas 3。跑完没报错，报表 GMV 少了 12%。

查了两个小时，问题出在一行看着特别正常的代码：

```python
import pandas as pd

df = pd.DataFrame({"city": ["北京", "上海"], "amount": [100.0, 200.0]})
df[df["city"] == "北京"]["amount"] *= 0.9
```

这行在 pandas 2 里就属于"有时候生效"，到了 pandas 3 彻底不生效——不抛异常，只丢一个 warning。日志级别设成 INFO 的话，你什么都看不见。

pandas 3 是一次"清账"式的大版本，1.x 攒到 2.x 的 deprecation 集中在这版执行。所以升级时最坑的不是报错，是**不报错**：代码照跑，结果悄悄错。

下面五个坑，全是我这段时间真踩到的，每个都附能直接跑的验证脚本。

## 环境先固定住

```text
# requirements.txt
pandas==3.1.1
pyarrow==26.0.1
numpy==2.5.5
```

Python 用 3.13。pyarrow 建议一定装：新的字符串类型底层优先走 PyArrow，装了内存和速度都更好；不装也能跑，会退回 NumPy 对象底座，行为一致，只是没那么省。

## 坑一：链式赋值彻底失效

原因不复杂。pandas 3 把 Copy-on-Write 设成默认语义：任何索引、切片、方法返回的新对象，在用户 API 层面一律等同于**副本**。所以 `df[mask]["amount"] = ...` 里那个中间对象是临时的，改它跟原表没关系。

验证一下：

```python
from __future__ import annotations

import pandas as pd


def main() -> None:
    df = pd.DataFrame({"a": [1, 2, 3], "b": [10, 20, 30]})

    df[df["a"] > 1]["b"] = 0
    print("链式赋值后:", df["b"].tolist())

    df.loc[df["a"] > 1, "b"] = 0
    print("loc 赋值后:", df["b"].tolist())


if __name__ == "__main__":
    main()
```

输出：

```text
链式赋值后: [10, 20, 30]
loc 赋值后: [10, 0, 0]
```

第一行还附送一个 warning：`ChainedAssignmentError: A value is being set on a copy of a DataFrame or Series through chained assignment.`

重点是这个类是 **Warning**，继承自 UserWarning，不继承 Exception。默认不会中断程序，也不影响退出码。CI 里那一堆 warning 被 `-W ignore` 或者日志配置淹掉，你就只能靠线上对账发现。

我现在的做法是在测试的 `conftest.py` 里把它升级成异常：

```python
import warnings

import pandas as pd

warnings.filterwarnings("error", category=pd.errors.ChainedAssignmentError)
```

测试一跑就炸，比少算 12% 强。别指望命令行 `-W error::pandas.errors.ChainedAssignmentError`，解释器启动时 pandas 还没导入，会提示 invalid module name 然后直接忽略——这个坑我也踩了。

顺带说一个好消息：`SettingWithCopyWarning` 被删了。以前为了压这个警告到处加的 `.copy()`，现在多数可以删。删之前想清楚一件事：如果那段代码原本依赖"改子集顺手改原表"，那要改的是逻辑，不是删一行 copy。

## 坑二：字符串列的 dtype 不叫 object 了

这条影响面最大，因为老代码里判断"这列是不是文本"的写法太常见。

```python
from __future__ import annotations

import pandas as pd


def main() -> None:
    s = pd.Series(["北京", "上海", None])
    print("dtype:", s.dtype)
    print("== object ?", s.dtype == object)
    print("is_string_dtype:", pd.api.types.is_string_dtype(s.dtype))

    try:
        s.loc[0] = 1
    except TypeError as exc:
        print("塞整数:", exc)


if __name__ == "__main__":
    main()
```

输出：

```text
dtype: str
== object ? False
is_string_dtype: True
塞整数: Invalid value '1' for dtype 'str'. Value should be a string or missing value, got 'int' instead.
```

会挂的地方大概这几类：

- `if df[col].dtype == object:` 分支进不去了。这类判断在清洗脚本里通常是"文本列才做 strip"的门槛。
- 单元测试里 `assert df["city"].dtype == object` 直接失败。
- `df.select_dtypes(include="object")` 目前还会把 str 列带出来，但会报 `Pandas4Warning`，明说这是兼容行为、以后删除。想干净就用 `include="str"`。
- 往 str 列塞非字符串会 TypeError。这点我倒觉得是好事：脏数据提前暴露，不用等到下游报表才发现有列混进了 `1` 和 `"1"`。

判断文本列，现在推荐这两条路：

```python
from __future__ import annotations

import pandas as pd


def is_text(series: pd.Series) -> bool:
    return pd.api.types.is_string_dtype(series.dtype)


def main() -> None:
    df = pd.DataFrame({"city": ["北京", "上海"], "amount": [1.0, 2.0]})
    print(is_text(df["city"]), is_text(df["amount"]))
    print(df.select_dtypes(include="str").columns.tolist())


if __name__ == "__main__":
    main()
```

内存收益是真的。我拿 20 万行 `order-000001` 这种字符串实测，`deep=True` 统计下 str 列 3.9 MB，`astype(object)` 之后 13.7 MB。四倍差距，宽表里几列文本就是几百 MB 的区别。

还有一点容易忽略：新 str 列的缺失值哨兵统一是 `NaN`，跟其他默认 dtype 一致。判断缺失继续用 `.isna()`，别写 `value is None`，更别 `== np.nan`。

## 坑三：Series 的整数下标按标签走

```python
from __future__ import annotations

import pandas as pd


def main() -> None:
    s = pd.Series([1, 2, 3], index=[10, 20, 30])
    print("iloc:", s.iloc[0])
    try:
        print("方括号:", s[0])
    except KeyError as exc:
        print("方括号:", type(exc).__name__, exc)


if __name__ == "__main__":
    main()
```

输出：

```text
iloc: 1
方括号: KeyError 0
```

pandas 3 起，`[]` 里的整数一律当标签，和 DataFrame 保持一致。以前 `s[0]` 在非 RangeIndex 上按位置取，是历史包袱。

这个改动在循环里特别阴。比如 `for i in range(len(s)): s[i]`，RangeIndex 下一切正常，一旦分组后索引变成用户 ID，立刻 KeyError。按位置就用 `.iloc`，按标签用 `.loc` 或 `.at`，别偷懒。

## 坑四：一批方法被删干净

这次删得挺狠：

- `DataFrame.applymap`、`Styler.applymap`、`Styler.applymap_index` 全删，改用 `DataFrame.map`、`Styler.map`
- `DataFrame.swapaxes`、`Series.swapaxes` 删了，用 `.T` 或 `.transpose()`
- `to_datetime`、`to_timedelta`、`to_numeric` 的 `errors="ignore"` 删了，传进去直接 `ValueError: invalid error value specified`

```python
from __future__ import annotations

import pandas as pd


def main() -> None:
    df = pd.DataFrame({"a": [1, 2], "b": [3, 4]})
    print(df.map(lambda value: value * 2).to_dict("list"))
    print(df.T.to_dict("list"))

    nums = pd.to_numeric(pd.Series(["1", "x"]), errors="coerce")
    print(nums.tolist())

    try:
        pd.to_numeric(pd.Series(["1", "x"]), errors="ignore")
    except ValueError as exc:
        print("errors=ignore:", exc)


if __name__ == "__main__":
    main()
```

输出：

```text
{'a': [2, 4], 'b': [6, 8]}
{0: [1, 3], 1: [2, 4]}
[1.0, nan]
errors=ignore: invalid error value specified
```

`errors="ignore"` 没了之后，想"转不了就保留原值"，只能自己 `try/except` 包一层，或者先 `errors="coerce"` 再回填。我倾向于让它炸——静默保留脏值，跟埋雷没区别。

## 坑五：别再把 DataFrame 当共享内存

```python
from __future__ import annotations

import pandas as pd


def main() -> None:
    base = pd.DataFrame({"a": [1, 2], "b": [3, 4]})
    sub = base[["a"]]
    sub["a"] += 10
    print("sub:", sub["a"].tolist())
    print("base:", base["a"].tolist())


if __name__ == "__main__":
    main()
```

输出：

```text
sub: [11, 12]
base: [1, 2]
```

注意，直接改传进来的 df 还是生效的——那本来就是同一个对象。变的是"从它身上切出来的东西"：不再回写。

所以函数签名最好表个态。要么返回新对象：

```python
from __future__ import annotations

import pandas as pd


def discount_beijing(orders: pd.DataFrame, rate: float = 0.9) -> pd.DataFrame:
    result = orders.copy()
    mask = result["city"] == "北京"
    result.loc[mask, "amount"] = (result.loc[mask, "amount"] * rate).round(2)
    return result


def main() -> None:
    orders = pd.DataFrame({"city": ["北京", "上海", "北京"], "amount": [100.0, 200.0, 300.0]})
    updated = discount_beijing(orders)
    print("updated:", updated["amount"].tolist())
    print("original:", orders["amount"].tolist())


if __name__ == "__main__":
    main()
```

输出 `updated: [90.0, 200.0, 270.0]`、`original: [100.0, 200.0, 300.0]`。要么在 docstring 里写清楚"本函数原地修改入参"。最怕的是两边都不表态，谁读谁猜。

## 改造完的完整清洗脚本

把上面几条揉进一个真实场景：读订单 CSV，清洗城市名，过滤已支付，按城市出汇总，落 Parquet。

```python
from __future__ import annotations

import pandas as pd


def make_orders(path: str) -> None:
    rows = [
        ("A-1001", "u01", "  beijing ", 320.0, "paid", "2026-11-01 10:00:00"),
        ("A-1002", "u02", "shanghai", 129.9, "paid", "2026-11-01 11:20:00"),
        ("A-1003", "u03", "Beijing", 88.0, "refunded", "2026-11-02 09:05:00"),
        ("A-1004", "u01", "SHANGHAI ", 500.0, "paid", "2026-11-02 21:40:00"),
        ("A-1005", "u04", "hangzhou", 66.6, "paid", "2026-11-03 08:15:00"),
        ("A-1006", "u05", "Beijing", 210.0, "paid", "2026-11-03 19:30:00"),
    ]
    frame = pd.DataFrame(
        rows,
        columns=["order_id", "user_id", "city", "amount", "status", "created_at"],
    )
    frame.to_csv(path, index=False)


def clean_orders(path: str) -> pd.DataFrame:
    raw = pd.read_csv(path, parse_dates=["created_at"])
    df = raw.copy()
    df["city"] = df["city"].str.strip().str.lower()
    df = df.loc[df["status"] == "paid"].copy()
    df["amount"] = pd.to_numeric(df["amount"], errors="coerce")
    return df.dropna(subset=["amount"])


def city_report(orders: pd.DataFrame) -> pd.DataFrame:
    return (
        orders.groupby("city", as_index=False)
        .agg(orders=("order_id", "count"), gmv=("amount", "sum"))
        .assign(avg=pd.col("gmv") / pd.col("orders"))
        .sort_values("gmv", ascending=False)
    )


def main() -> None:
    make_orders("/tmp/orders.csv")
    orders = clean_orders("/tmp/orders.csv")
    print(orders.dtypes.to_string())
    print(city_report(orders).to_string(index=False))
    orders.to_parquet("/tmp/orders.parquet", index=False)
    print("回读行数:", len(pd.read_parquet("/tmp/orders.parquet")))


if __name__ == "__main__":
    main()
```

汇总结果：

```text
    city  orders   gmv    avg
shanghai       2 629.9 314.95
 beijing       2 530.0 265.00
hangzhou       1  66.6  66.60
```

这里用了 `pd.col("gmv") / pd.col("orders")`，pandas 3 新增的表达式写法，`assign` 里不用再写 lambda。它支持常规运算符，也支持大部分 Series 方法，比如 `pd.col("city").str.upper()`。

还有个小变化值得留意：`parse_dates` 解析出来的时间列现在是 `datetime64[us]`。如果有测试硬断言 `datetime64[ns]`，会挂。

## 我现在的升级顺序

1. 先升到 2.3，把 warning 全部清零，再跳到 3.0。官方迁移文档也是这个建议，别一步跨。
2. 装 pyarrow。字符串列会走它，行为不变但资源占用差一截。
3. 在测试里把 `ChainedAssignmentError` 设成 error。
4. 全仓扫一遍：`grep -rnE "applymap|swapaxes|errors=\"ignore\"|dtype == object" --include="*.py" .`
5. 清掉只为压 `SettingWithCopyWarning` 加的 `.copy()`，同时确认没依赖"子集回写"。
6. 拿一份生产样本跑升级前后对比，比行数、求和、去重数和服务重算结果。测试全绿不等于结果对——这条是血的教训。

去年 NumPy 2 那波也是同样的剧情：导入不报错，数值悄悄变。大版本迁移，永远要留一步对账。

## 参考资料

- [What's new in 3.0.0](https://pandas.pydata.org/docs/whatsnew/v3.0.0.html)
- [Copy-on-Write 用户指南](https://pandas.pydata.org/docs/user_guide/copy_on_write.html)
- [pandas 3.0 迁移指南](https://pandas.pydata.org/docs/user_guide/migration.html)
- [字符串类型迁移说明](https://pandas.pydata.org/docs/user_guide/migration-3-strings.html)
- [pandas.DataFrame.map](https://pandas.pydata.org/docs/reference/api/pandas.DataFrame.map.html)

文 / 会编程的吕洞宾
