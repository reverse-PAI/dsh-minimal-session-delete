# 🗑️ dsh-sessiondelete

**DeepSeek Harness 的小插件：把一条会话永久删掉，干净利落。**

DSH 有归档、没有删除，持久化层也明确不提供删除 API，这条链路就由插件自己走完：侧边栏入口 → 二次确认 → Host 鉴权路由 → 把会话的日志、缓存、归档/置顶标记和工作区槽位一次清干净。

- 📦 包名：`dsh-sessiondelete` · 🧩 Host 半 + 浏览器半的 bundle 插件 · 🪶 依赖 0、构建 0、配置 0
- 🔗 安装：`dsh plugin add dsh-sessiondelete`

---

## 一、项目简介

**🎯 只做一件事**：删掉一条会话。没有设置页、没有开关、没有批量清理、没有回收站、不联网 —— 唯一一次 `fetch` 也发往 DSH 自己的删除路由。需要配置，往往说明功能已经跑偏了。

**🎨 画风跟 DSH 一模一样**：三个界面元素都从 Host 自带组件复刻 —— `...` 菜单项照归档菜单项，同款图标与快捷键 chip，只把颜色换成危险色；悬停按钮照会话行的 `iconButton`；对话框照 `Modal`。颜色圆角全用 Host 的设计变量，主题深浅色自动跟着变。

**🪶 轻量**：三个源文件、约 740 行；零依赖、零构建，源码原样就能被 DSH 加载。

---

## 二、主要功能

**🖱️ 三个入口**

| 入口 | 位置 |
| --- | --- |
| 菜单项 | 侧边栏会话行的 `...` 菜单 →「删除会话」 |
| 悬停按钮 | 会话行 hover 时出现的垃圾桶图标 |
| 快捷键 | 桌面 `Ctrl/⌘ + Shift + D`，浏览器 `Ctrl/⌘ + Alt + D`，作用于主视图当前的会话 |

三条入口都会先弹确认：显示标题与会话 id、两条不可恢复的警告；会话正在运行时提示先停止并禁用确认按钮；失败原因直接显示在对话框里。

**🧹 一次删干净**：会话日志目录、投影缓存行、归档与置顶标记、工作区 `sessionIds` 槽位、内存里的活动会话，一个都不留；删完浏览器**原地移除该行，不用刷新页面**。

**🛡️ 删得安全**：运行中的会话直接返回 `409` 拒绝，绝不删一个正在写入的日志；删不掉最多重试 11 轮，再报 `500` + 剩余目录，不假装成功；id 过白名单正则，杜绝路径穿越；`dryRun` 可以先只看不动。

---

## 三、安装方法

> 前置：已装 DSH。`$DSH_HOME` 默认 `~/.dsh`，桌面版 profile 叫 `desktop`。

**🥇 推荐：从 npm 安装**。打开 **设置 → 插件 → 添加插件**，在「包名或地址」中输入：

```
dsh-sessiondelete
```

装好会自动进 `dsh.profile.bundles` 并默认启用，**不需要 clone、构建或额外安装**。应用提示刷新或重新打开，按提示完成即可。

命令行等价写法（先完全退出桌面应用）：

```bash
dsh plugin --profile desktop add dsh-sessiondelete
```

**🥈 备选：从 GitHub 或本地目录安装**。同一个输入框里填 GitHub 规格或本地绝对路径：

```
github:reverse-PAI/dsh-sessiondelete#v1.0.1
```

末尾 `#v1.0.1` 是版本 tag，想跟主分支最新代码就省略；本地开发可以直接填 `<项目目录>`。

**⌨️ 手动接 profile**：在 profile 的 `package.json` 里把 `dsh-sessiondelete` 加进 `dsh.profile.bundles`，并在 `dependencies` 里写 `"dsh-sessiondelete": "^1.0.1"`（走 npm）或 `"dsh-sessiondelete": "link:<项目目录>"`（走本地源码）。

**🗑️ 卸载**：`dsh plugin --profile desktop remove dsh-sessiondelete`

**✅ 装完自检**：会话行悬停有垃圾桶按钮、`...` 菜单有「删除会话」→ 先 `dryRun` 看一眼要删什么 → 真删一条，看它原地消失、`$DSH_HOME/sessions/` 下的目录也没了。

---

## 四、使用方法

鼠标移到会话行 → 点垃圾桶；或 `...` 菜单 →「删除会话」→ 核对标题与会话 id → **永久删除**。也可以先用主视图打开会话，再按 ⌨️ 桌面端 `Ctrl/⌘ + Shift + D`、浏览器端 `Ctrl/⌘ + Alt + D`。

> ⚠️ 会话运行中删不掉，Host 返回 `409 running`，请先停止它。
>
> 📁 **归档 ≠ 删除**：只想把会话从列表里收起来，请继续用 DSH 自带的归档功能。

**脚本调用**：

```bash
# 只看不动；去掉 "dryRun":true 就是真删
curl -X POST 'http://<你的 DSH Web 地址>/api/dsh-session-delete' \
  -H 'content-type: application/json' --cookie '<DSH 会话 Cookie>' \
  -d '{"sessionId":"session-6f1c2f0e-3b7a-4a6e-9a1d-2c5b8f7d9e01","dryRun":true}'
```

`sessionId` 必填，三种 id 形态都行；`dryRun` 可选；成功回 `ok: true` 以及删掉的目录、清理的缓存行数、`warnings`；出错看返回的 `code`：`invalid-id`、`not-found`、`running`、`cannot-detach`、`delete-failed` 等。该路由走 DSH 共享的 `/api` 通道，自带 Host/Origin 信任检查与 Cookie 鉴权。

**环境变量**：只有 `DSH_HOME` 一个，默认 `~/.dsh`；删除范围完全由它决定。

**⚠️ 记住三条**：删除不可恢复；运行中的会话拒绝删除；客户端更新后要刷新页面 / 重启应用。

---

📄 License: [MIT](LICENSE)
