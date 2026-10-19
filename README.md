# 🗑️ dsh-minimal-session-delete

**DeepSeek Harness 的小插件：把一条会话永久删掉，干净利落。**

DSH 有归档、没有删除。插件优先寻找 Host 是否已经提供原生删除 API（`sessions.delete` / `sessionPersistence.delete`）；有就**完全委托**给它，绝不再碰文件系统。没有原生 API 时，才按本仓库验证过的 Host 内部契约走完：侧边栏入口 → 二次确认 → Host 鉴权路由 → 把会话的日志、缓存、归档/置顶标记和工作区槽位一次清干净。它同时通过 `GET` 暴露自己的能力，遇到不支持的 Host 版本会**明确失败**，而不是删到一半。

- 📦 包名：`dsh-minimal-session-delete` · 🧩 Host 半 + 浏览器半的 bundle 插件 · 🪶 依赖 0、构建 0、配置 0
- 🔗 安装：`dsh plugin add dsh-minimal-session-delete`（npm 已发布 1.1.0；本文对应 1.1.0，若 npm 尚未同步可稍后重试或走 GitHub/本地目录）
- 🧭 兼容性：**不是公开 Host API，宿主升级可能改变契约**；`GET /api/dsh-session-delete` 可先查能力，详细边界见第五节

---

## 一、项目简介

**🎯 只做一件事**：删掉一条会话。没有设置页、没有开关、没有批量清理、没有回收站、不联网 —— 唯一一次 `fetch` 也发往 DSH 自己的删除路由。需要配置，往往说明功能已经跑偏了。

**🎨 画风跟 DSH 一模一样**：三个界面元素都从 Host 自带组件复刻 —— `...` 菜单项照归档菜单项，同款图标与快捷键 chip，只把颜色换成危险色；悬停按钮照会话行的 `iconButton`；对话框照 `Modal`。颜色圆角全用 Host 的设计变量，主题深浅色自动跟着变。

**🪶 轻量**：三个源文件、约 1280 行；零依赖、零构建，源码原样就能被 DSH 加载。

---

## 二、主要功能

**🖱️ 三个入口**

| 入口 | 位置 |
| --- | --- |
| 菜单项 | 侧边栏会话行的 `...` 菜单 →「删除会话」 |
| 悬停按钮 | 会话行 hover 时出现的垃圾桶图标 |
| 快捷键 | 桌面 `Ctrl/⌘ + Shift + D`，浏览器 `Ctrl/⌘ + Alt + D`，作用于主视图当前的会话 |

三条入口都会先弹确认：显示标题与会话 id、不可恢复的警告与级联说明；会话正在运行时提示先停止并禁用确认按钮；若会话派生过子代理会话，确认框会提示会一并删除；失败原因直接显示在对话框里。

**🧹 一次删干净**：会话日志目录、投影缓存行、归档与置顶标记、工作区 `sessionIds` 槽位、内存里的活动会话，一个都不留；删完浏览器**原地移除该行，不用刷新页面**。删除会级联清理该会话派生的子代理会话（`origin: subagent` 的后代），用户主动 fork 出来的会话则保留。Host 将来若提供原生删除 API，插件会整条委托给它，由 Host 自己完成上述生命周期。

**🛡️ 删得安全**：先等当前回合真正停下（最多 15 秒，超时 `409 still-running`，此时什么都没动），再把会话的日志文件改名为同目录下的隐藏文件名（列表里立即消失，且不会破坏 Host 的持久层枚举），随后才 detach 会话、物理删除目录；改名失败直接 `500`、文件与界面原样保留，detach 失败会回滚改名。运行中的会话（含子代理）直接 `409` 拒绝；物理删除最多重试 11 轮，仍删不掉时会话已逻辑删除（不再出现在列表里），响应带 `200` + `remainingDirs`/`warnings`，残留的暂存文件会在之后任意一次删除时自动清扫（只清超过 10 分钟的）。id 只接受单段安全字符集（字母数字与 `-_.`，拒路径分隔符、`.hidden`、结尾的点），第三方插件造的 `social-<hex>` 这类 id 也能删，同时杜绝路径穿越；解析出的目录必须 `realpath` 落在会话根内，符号链接指到根外会被忽略并记 `warnings`；`abc` 与 `session-abc` 同时存在时返回 `409 ambiguous-id` 而不是猜一个删掉；`dryRun` 可以先只看不动。

---

## 三、安装方法

> 前置：已装 DSH。`$DSH_HOME` 默认 `~/.dsh`，桌面版 profile 叫 `desktop`。

**🥇 推荐：从 npm 安装**。打开 **设置 → 插件 → 添加插件**，在「包名或地址」中输入：

```
dsh-minimal-session-delete
```

装好会自动进 `dsh.profile.bundles` 并默认启用，**不需要 clone、构建或额外安装**。应用提示刷新或重新打开，按提示完成即可。

命令行等价写法（先完全退出桌面应用）：

```bash
dsh plugin --profile desktop add dsh-minimal-session-delete
```

**🥈 备选：从 GitHub 或本地目录安装**。同一个输入框里填 GitHub 规格或本地绝对路径：

```
github:reverse-PAI/dsh-minimal-session-delete#v1.1.0
```

末尾 `#v1.1.0` 是版本 tag（需仓库已推送该 tag），想跟主分支最新代码就省略；本地开发可以直接填 `<项目目录>`。

**⌨️ 手动接 profile**：在 profile 的 `package.json` 里把 `dsh-minimal-session-delete` 加进 `dsh.profile.bundles`，并在 `dependencies` 里写 `"dsh-minimal-session-delete": "^1.1.0"`（走 npm）或 `"dsh-minimal-session-delete": "link:<项目目录>"`（走本地源码）。

**🗑️ 卸载**：`dsh plugin --profile desktop remove dsh-minimal-session-delete`

**✅ 装完自检**：会话行悬停有垃圾桶按钮、`...` 菜单有「删除会话」→ 先 `dryRun` 看一眼要删什么 → 真删一条，看它原地消失、`$DSH_HOME/sessions/` 下的目录也没了；删一条带子代理的父会话，确认子代理行也一起消失。

---

## 四、使用方法

鼠标移到会话行 → 点垃圾桶；或 `...` 菜单 →「删除会话」→ 核对标题与会话 id → **永久删除**。也可以先用主视图打开会话，再按 ⌨️ 桌面端 `Ctrl/⌘ + Shift + D`、浏览器端 `Ctrl/⌘ + Alt + D`。

> ⚠️ 会话运行中删不掉，Host 返回 `409 running`（等它停下超时会返回 `409 still-running`，此时未做任何修改），请先停止它；子代理还在跑同样会拒绝。
>
> 📁 **归档 ≠ 删除**：只想把会话从列表里收起来，请继续用 DSH 自带的归档功能。

**脚本调用**：

```bash
# 先看当前 Host 支持到哪一步（只读，不删任何东西）
curl 'http://<你的 DSH Web 地址>/api/dsh-session-delete' \
  --cookie '<DSH 会话 Cookie>'

# 只看不动；去掉 "dryRun":true 就是真删
curl -X POST 'http://<你的 DSH Web 地址>/api/dsh-session-delete' \
  -H 'content-type: application/json' --cookie '<DSH 会话 Cookie>' \
  -d '{"sessionId":"session-6f1c2f0e-3b7a-4a6e-9a1d-2c5b8f7d9e01","dryRun":true}'
```

`GET` 返回 `{ok: true, capabilities}`，其中 `mode` 是 `native`（宿主有原生删除 API，插件直接委托）、`detach`（无原生 API，但具备安全 detach 已附着会话所需的内部接口）或 `filesystem-only`（只能删冷会话；删除活跃会话会明确返回 `cannot-detach`），其余布尔字段逐项说明当前 Host 暴露了哪些内部契约。

`sessionId` 必填，宿主 id（`session-<uuid>` 或裸 uuid）和第三方插件自造的 id（例如 `social-<hex>`）都可以，只要是不含路径分隔符的单段安全字符；`dryRun` 可选；成功回 `ok: true`、`mode`，以及实际使用的 `root`、删掉的目录、级联删掉的会话、清理的缓存行数、`warnings`；出错看返回的 `code`：`invalid-id`、`not-found`、`running`、`still-running`（等回合停下超时，未做任何修改）、`cannot-detach`、`ambiguous-id`（两个相似 id 的真实目录同时存在，需用精确 id 逐条删除）、`logs-not-found`（持久层有记录但配置的根目录下找不到日志）、`delete-failed`（暂存失败，文件与界面均未改动）、`detach-failed`（已回滚文件，但可能已部分 detach，建议刷新页面）等。`200` 但带非空 `remainingDirs` 表示会话已逻辑删除、物理文件留待下次清理；`500` 响应带 `warnings` 说明具体失败项。该路由走 DSH 共享的 `/api` 通道，自带 Host/Origin 信任检查与 Cookie 鉴权，且仅 owner 连接可用。

**环境变量**：`DSH_HOME`（默认 `~/.dsh`）只作兜底；会话根目录优先取运行时持久层配置的 `root`，两者不一致时以持久层为准。

**⚠️ 记住三条**：删除不可恢复；运行中的会话拒绝删除；客户端更新后要刷新页面 / 重启应用。

---

## 五、兼容性、能力探测与边界

写这段是因为：**DSH 目前没有公开的会话删除 API**。插件能做到的“普适”是**能力分层、显式失败、绝不半途而废**，而不是假装任何版本都能删。

**能力分层**（`GET /api/dsh-session-delete` 可查）

| 模式 | 判定 | 行为 |
| --- | --- | --- |
| `native` | 宿主存在 `sessions.delete` 或 `sessionPersistence.delete` | 全部委托给宿主；插件不改文件、不广播，完全跟随宿主生命周期 |
| `detach` | 无原生 API，但有 `sessions.detachEntered` + `sessions.store` | 当前完整实现：等回合停下、暂存日志文件、detach、物理删除、清缓存/归档/工作区标记、级联子代理 |
| `filesystem-only` | 连 detach 都没有 | 只删**冷**会话；敢删活跃会话就返回 `409 cannot-detach`，一个字节都不动 |

**安全阀**：删除前先等回合停下（15 秒超时即放弃）；日志文件先改名隐藏，失败即回滚；目录必须 `realpath` 落在会话根内；id 歧义直接拒绝；物理删除失败也保证会话已从列表消失，并把残留目录报给调用方。**残留的 `cancel` 后晚写窗口无法完全消除**——宿主没有删除 API 时，这是所有外部方案共同的边界。

**已验证范围**：Windows 11 + Node 22（`node --test` 27 项全过）、真实会话目录 dryRun、真实 Host 内嵌加载。Linux/macOS 只用标准 `fs.rename/rm`，未实机跑过；非 owner 的远程连接没有删除权限（Host 的 `/api` 通道限制）；附件库 `~/.dsh/attachments/` 是内容寻址的，插件**不**做附件 GC（宿主没有按会话回收的接口）；批量删除、回收站、撤销都不在范围内。

**真正的普适方案**是上游在 Host 里加一个正式的 `session.delete`：由宿主决定 detach、落盘顺序、事件与附件回收。插件已经把这个入口接好了——`native` 模式就是为它留的；等宿主有了 API，插件不需要改一行删除逻辑就能自动切换。


---

📄 License: [MIT](LICENSE)
