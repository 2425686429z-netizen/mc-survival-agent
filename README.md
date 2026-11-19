# mineflayer-survival-agent

一个会自己活下去的 Minecraft 机器人：只做「手」，不做「脑」。

它是一座本地 HTTP 服务，通过 [mineflayer](https://github.com/PrismarineJS/mineflayer) 连进世界，把「往哪走、挖什么、垒墙、吃饭、还手」这些动作暴露成接口。至于「今天想干什么」，由外面的 LLM 决定——服务本身不接任何模型，也不含任何密钥。

这样拆的好处：想换模型、换人格、换任务编排，都不用碰这份代码。

```
你的 LLM / 调度器  ──HTTP──▶  server.js  ──mineflayer──▶  MC 服务器
   （决定做什么）              （负责做到）                （世界）
```

## 它凭什么「活得下去」

不是靠脚本硬编码，而是一层本能：饿了找吃的、挨打还手、掉坑里爬出来、天黑垒墙、背包满了清理、找不到资源就换个方向走。计划只是「上层意志」，本能负责让它在执行计划的过程中不饿死。

这份代码里比较花心思的几处：

**1. 备料不足不动工**
垒墙要 8 个方向 × 2 格高 = 16 块。以前只检查「有没有 6 块」就开垒，结果永远是「垒了两块就没料了」。现在动工前先数料：够 16 块围满圈；8~15 块缩成四面小隔间并如实说明；不足 8 块就先去挖石头备料，备不齐就掏洞——任何情况下都不会留下半成品。

**2. 到达判定分两档**
赶路、回家、够掉落物用严格判定（水平 3 格 / 垂直 4 格）；溜达和找资源放宽到 6 格。同一个阈值套所有场景，要么「走了二十格还报没走到」，要么「其实没挪动也算成功」，后者会让脱困机制失效。

**3. 找资源记得路**
纯随机方向走，就会在一片没树没羊的地方反复空转。现在会记住「哪个方向找到过东西」：下次有 65% 概率还往那边走，连走两次扑空就换方向。只记一个方位，不建地图。

**4. 重垒不重复消耗**
同一位置再垒一遍时，先看一眼目标格已经是实心就算数，不消耗材料。否则第二遍会报「只放上 2/16」，然后误判失败。

## 快速开始

需要 Node 18+ 和一个能连的 Minecraft 服务端（建议 `online-mode=false`，即局域网/离线模式）。

```bash
git clone <this-repo>
cd mineflayer-survival-agent
npm install
```

必须设的环境变量（**至少前两个，否则会在没有 D 盘的机器上启动失败**）：

| 变量 | 说明 | 默认值 |
|---|---|---|
| `HER_MC_DATA` | 日志与记账目录，须已存在 | `D:/AstrBot` |
| `HER_MC_OWNER` | 「主人」的游戏 ID，只有这个 ID 说的话会被收进收件箱 | 空（等于功能关闭） |
| `HER_MC_PORT` | 本地监听端口 | `8765` |
| `HER_MC_DEEDS` | 记账文件完整路径 | `<DATA>/_她做过的事.log` |
| `HER_MC_LOG` | 事件流水完整路径 | `<DATA>/_她玩MC了.log` |
| `HER_MC_RECORD` | 录像输出目录 | `<DATA>/_mc_record` |

Linux / macOS：

```bash
export HER_MC_DATA="$HOME/mcbot"
export HER_MC_OWNER="你的游戏ID"
mkdir -p "$HER_MC_DATA"
node server.js
```

Windows：

```bat
set HER_MC_DATA=D:\mcbot
set HER_MC_OWNER=YourName
node server.js
```

起来后：

```bash
curl -X POST http://127.0.0.1:8765/join \
  -H "Content-Type: application/json" \
  -d '{"host":"127.0.0.1","port":25565,"username":"Bot","version":"26.1"}'

curl http://127.0.0.1:8765/state
```

`version` 填 mineflayer 支持的协议版本；不确定就先查 `require('minecraft-protocol').supportedVersions`。

## 接口

所有接口返回 JSON，失败时带 `{ok:false, msg}`。

| 方法 | 路径 | 参数 | 作用 |
|---|---|---|---|
| POST | `/join` | `host, port, username, version` | 上线 |
| POST | `/quit` | — | 下线 |
| GET | `/state` | — | 位置、血量、饥饿、背包 |
| GET | `/around` | — | 周围方块与实体摘要 |
| POST | `/walk` | `target:{x,y,z}` | 走过去 |
| POST | `/follow` | `name` | 跟着某个玩家 |
| POST | `/mine` | `block, count` | 挖指定方块 |
| POST | `/place` | `block, x, y, z` | 放方块 |
| POST | `/craft` | `item, count` | 合成 |
| POST | `/smelt` | — | 烧一炉 |
| POST | `/say` | `text` | 在游戏里说话 |
| POST | `/eat` | — | 吃东西 |
| POST | `/attack` | `seconds, radius, force` | 还手 |
| POST | `/defend` | — | 清掉附近的威胁 |
| GET | `/deeds` | — | 读记账 |
| GET / POST | `/inbox` | — / `text` | 取/存「主人说的话」 |
| POST | `/autoplay` | `minutes` | 开始自主行动 |
| POST | `/autostop` | — | 停止自主行动 |
| GET | `/auto` | — | 自主行动状态 |
| POST | `/record/start` | `tag` | 开始录屏（仅 Windows） |
| POST | `/record/stop` | — | 停止录屏 |

## 自主行动的判定

`autoplay` 打开后，服务按优先级处理：逃生 > 挨打还手 > 饥饿 > 执行计划里的当前步 > 随机溜达。计划来自同目录的 `_goal.json`（可选，格式见下），里面是一份分步清单，做完一步游标加一；某一步连续失败 6 次会被跳过，不会整晚吊死在同一件事上。

```json
{
  "date": "2026-11-19",
  "goal": "把住处弄好",
  "minutes": 40,
  "cursor": 0,
  "steps": [
    { "step": "把洞口垒严实挡风", "do": "wall" },
    { "step": "挖点石头存着", "do": "mine", "block": "stone", "count": 16 }
  ]
}
```

`date` 不是今天时整份计划视为过期，回退到自由行动。

## 测试

```bash
node --check server.js
node _test_survival.js
```

`_test_survival.js` 不连游戏、不起服务：它把源码里的函数原文切出来，注入假的 `bot` / `pathfinder` 再跑断言，覆盖到达判定的两档阈值、备料不足的四种分支、方位记忆的概率与失效、以及步骤完成判定。**测的是文件里的真实代码**，改了源码测试会跟着变。共 26 项。

## 已知限制

- 录屏用 `gdigrab`，仅 Windows；且写死了窗口标题 `Minecraft 26.1`，换版本要改。
- 路径与记账文件是中文命名，Windows 以外注意文件系统编码。
- 没有鉴权，只监听 `127.0.0.1`。别把它暴露到公网。
- `_goal.json` 的生成逻辑不在这个仓库里，需要外部写入。

## License

MIT
