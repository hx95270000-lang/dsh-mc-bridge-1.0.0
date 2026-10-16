# DSH Minecraft 控制桥：安装与使用

让 DSH 智能体进入你的 Minecraft **1.20.1 Forge** 客户端：在游戏里聊天、采集原版与模组物品、搭建筑、放/挖方块、操作客户端界面。

整个东西分成两半，**各自独立**：

| 部件 | 装在哪 | 作用 |
|---|---|---|
| `dsh-mc-bridge-1.0.0.jar` | Minecraft 客户端的 `mods/` | 把真实客户端变成可被控制的机器人（**只装客户端**，服务器/整合包不用装） |
| `dsh-minecraft-agent/` | DSH Desktop 的 profile | 提供 `mc_*` 工具给智能体 |

**不需要共享任何账号密码**：桥驱动的是**你自己已经登录的客户端**，正版、皮肤站（authlib-injector）都照常工作。

---

## 前提

- Minecraft **1.20.1 + Forge 47.x**（任意小版本；`mods.toml` 声明 `[47,)`、`[1.20.1,1.21)`、`side=CLIENT`，并且 `displayTest=IGNORE_ALL_VERSION`，所以它不挑整合包、也不影响联机握手）
- 已安装 **DSH Desktop**
- **不需要 Node.js / pnpm**：插件在桥后端下零第三方依赖（已实测：删掉 `node_modules` 后 30/31 项测试通过，唯一失败项是测试自己引用的 `prismarine-nbt`）
  - 只有要用**协议后端**去连普通服务器（`mc_join address=...`）才需要 `pnpm install`
  - 只有要读**旧版 `.schematic`** 蓝图才需要 `prismarine-nbt`（`.schem` 是纯 JS 解码）

---

## 一、装 mod（Minecraft 侧）

1. **完全关闭游戏**（运行中替换 jar 会让已加载的类失效，报 `NoClassDefFoundError`）
2. 把 `dsh-mc-bridge-1.0.0.jar` 复制进整合包实例的 `mods/` 目录
3. 启动游戏，进到主菜单
4. 确认成功：游戏目录下出现 `dsh-bridge/status.json`，内容类似
   ```json
   {"port":25577,"status":"listening","pid":1234,"ticks":42}
   ```
   如果 `port` 是 `-1`，说明端口被占用，换一个端口启动（见下）

端口冲突时用 JVM 参数换端口（PCL：版本设置 → 高级 → JVM 参数；官方启动器：JVM 参数里加）：

```
-Ddshmcbridge.port=25588
-Ddshmcbridge.bind=127.0.0.1     # 默认就是 127.0.0.1，不要改成 0.0.0.0
```

---

## 二、装插件（DSH 侧）

1. 把 `dsh-minecraft-agent` 整个文件夹放到任意位置，例如 `D:\dsh\minecraft-agent`
2. 编辑 `%USERPROFILE%\.dsh\profiles\desktop\package.json`：

   ```json
   {
     "dsh": {
       "profile": {
         "bundles": [
           "@deepseek-ai/dsh-base",
           "@deepseek-ai/dsh-web-app",
           "@local/dsh-minecraft-agent"
         ]
       }
     },
     "dependencies": {
       "@local/dsh-minecraft-agent": "link:D:/dsh/minecraft-agent"
     }
   }
   ```

   - `bundles` 里加一项 `"@local/dsh-minecraft-agent"`
   - `dependencies` 里把它指向你放文件夹的位置（Windows 路径写成 `link:D:/dsh/minecraft-agent` 或 `link:C:/Users/你/...`）
   - `cordis.patch.yml` 是插件自带的 bundle patch（负责插入 `mc-bot` 条目），跟着文件夹一起复制，不用改

3. **重启 DSH Desktop**（必须：Loader/ESM 会缓存已加载的模块，改完文件不重启不会生效）
4. 验证：对 DSH 说一句「看看 Minecraft 状态」，应当出现 `mc_state` 工具；重启后再确认 `mc_state` 返回 `status: idle`

可选：想改默认用户名或桥端口，编辑 profile 的 `cordis.patch.yml`：

```yaml
- id: mc-bot
  disabled: false
  config:
    defaultUsername: SkyAgent
    bridgePort: 25577
```

---

## 三、怎么用

先在游戏里进到一个世界（或联机服务器），保持游戏窗口在前台，然后：

```
mc_join                      # 不带参数：先探测本机客户端的桥，接上
mc_observe radius=16         # 看周围：坐标、方块普查、玩家、实体、聊天
mc_chat message=大家好        # 游戏内说话（也会执行 / 开头的命令）
mc_collect block=create:cogwheel count=8    # 按模组真实注册名采集
mc_build source=shape shape=hollow_box options={"width":9,"height":4,"length":7,"block":"oak_planks"}
```

模组内容能直接用**真实注册名**（`create:cogwheel`、`ae2:controller`、`gtceu:...`）——因为控制逻辑跑在装了同一批模组的真实客户端里，不需要任何映射文件。

### 客户端停在 Forge 启动警告界面怎么办

整合包常在进游戏前弹一个 "Loading Error / 加载错误" 界面，不点按钮就不会继续。用桥点它：

```
mc_control action=screen                    # 列出界面上的全部按钮（含索引与显示文字）
mc_control action=screen_click index=2      # 点第 2 个（"继续返回主菜单"）
mc_control action=open_world world=创造1     # 直接加载某个存档（立刻返回，加载在后台继续）
```

Forge 这个界面的按钮是**已本地化的字面量**，翻译键在运行时已经丢失，所以 `text=continue` 在中文客户端上匹配不到——照 `action=screen` 返回的文字或索引来点。

---

## 四、常见问题

| 现象 | 原因与处理 |
|---|---|
| `mc_join` 报连不上桥 / `ECONNREFUSED 25577` | 游戏没开、mod 没装、或端口不是 25577。看 `<游戏目录>/dsh-bridge/status.json` |
| 挖方块、走路「在动但位置不变」 | 单人世界窗口失焦会暂停（原版行为），服务端不 tick。把游戏窗口切到前台；`stats.paused` 会如实报告 |
| `NoClassDefFoundError: local/dsh/mcbridge/Ops` | 游戏运行中替换过 mod jar。彻底关掉游戏再启动 |
| 改了插件代码但工具行为没变 | Loader 缓存模块，重启 DSH Desktop |
| `place` 返回 `player-occupied` | 目标格子就是玩家自己站的位置，原版不允许把方块放进玩家身体，换个相邻格子 |
| `place` 返回 `no-support` | 目标位置周围没有可点击的实体面（悬空放不了方块），换个贴着地面的位置 |
| `.schematic` 蓝图报 `prismarine-nbt could not be loaded` | 在插件目录执行 `pnpm add prismarine-nbt`（`.schem` 不需要） |
| 想让智能体连普通服务器而不是本机客户端 | `mc_join address=play.example.com:25565`，此时需要 `pnpm install`（依赖 mineflayer） |

---

## 五、能力与边界

能：进服/进世界、观察世界（模组方块也能按名识别）、游戏内聊天与命令、行走（直线+跳跃）、按真实注册名采集、把掉落物捡进背包、按蓝图/形状/`.schem` 建造、放/挖方块、点击界面按钮、加载存档。

不能：**没有寻路**（走不过复杂障碍，会如实返回「没走到」）；`eat` 未实现（会明确报错）；容器存取与合成目前只在协议后端可用；不会自动避怪/避岩浆；只在已加载区块内工作。

---

## 六、安全

- 桥**默认只绑 `127.0.0.1`**，并且**没有鉴权**：能访问本机端口的程序就能控制这个客户端。
- **不要**用 `-Ddshmcbridge.bind=0.0.0.0` 把它开放到局域网/公网——那等于把客户端的操作权交出去。
- mod 不联网、不上传任何数据；关掉游戏即断开。
- 分享这个包**不需要**附带任何账号、令牌或密码。

---

## 七、许可

mod 与插件均为 MIT。可以自由再分发；请不要把 GPL 或闭源组件打包进来。
