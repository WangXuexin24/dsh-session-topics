# HANDOFF — dsh-session-topics 交接文档

> 面向**下一个接手改进这个插件的 agent**。先读这一份，再读 [`README.md`](../README.md)
> （那里写的是设计取舍的来龙去脉与踩坑史）。
> 本文只写"接手需要的事实"：现状、代码地图、契约、坑、待办。
> 最后核对：**2026-09-11**（DSH 0.1.5-rc.1 / profile `web`）。

---

## 0. 一句话现状

| 项 | 值 |
|---|---|
| 插件 | `dsh-session-topics` v0.1.0，**纯客户端** |
| 安装 | `~/.dsh/profiles/web/package.json`：`"dsh-session-topics": "link:D:/DSH_Projects/dsh-session-topics"`，且同名条目在 `dsh.profile.bundles` 里 |
| 市场状态 | 插件市场 → **已安装** 列表中可见，带「启用中」开关 / 恢复 / 卸载 |
| host 半边 | `lib/index.js` **故意空壳**，不 inject 任何服务（结构性零启动风险） |
| 功能半边 | `lib/client.js`（约 1325 行，`window.__ModuleLoader__` 包装） |
| 验证 | `node test/smoke.mjs` → **RESULT: all checks passed**（退出码 0） |

**"注入 dsh-market 并随时开关"这件事已经完成** —— 开关由市场自己完成，它改的是 profile 的
patch 层（禁用/启用该插件行），插件本身不需要实现开关。

---

## 1. 30 秒看懂架构

```
┌ host 进程（node） ────────────────────────────────┐
│ cordis.patch.yml  insert: { id: session-topics,   │
│                            name: 'dsh-session-topics' }
│ lib/index.js      apply() 是 no-op                │  ← 故意什么都不做
└───────────────────────────────────────────────────┘
┌ 浏览器（client bundle） ──────────────────────────┐
│ lib/client.js                                     │
│  inject = ["slots","sessions","workspaces","locale"] │
│  ├ slots.inject("sidebar.workspaces", …)  priority -1  ← 顶替官方浏览器
│  ├ 渲染：工作区 → [话题 → 子话题 → 会话] + 未归话题 + 其他
│  ├ 拖拽 / 右键菜单 / 相对时间 / 新建话题
│  └ 状态：defineStore({ persist: "dsh.session.topics.v2" })     ← 浏览器本地
│           备份：              "dsh.session.topics.v2.bak"
└───────────────────────────────────────────────────┘
```

数据**全部在浏览器本地存储**（不是 `~/.dsh` 文件，不是 host 内存）。这是刻意的取舍：
换来"零 host 依赖、零启动风险"，代价是不跨设备、清缓存即丢（有 `.bak` + 恢复条兜底）。

---

## 2. 代码地图（`lib/client.js`，行号锚点）

| 行 | 内容 | 改动风险 |
|---|---|---|
| 45–67 | bundle 头：`__ModuleLoader__.load({…})`、`MAX_TOPIC_DEPTH = 2` | 改包装格式会直接加载失败 |
| 70 / 79 | `PERSIST_KEY = "dsh.session.topics.v2"` / `BACKUP_KEY = …".bak"` | 改 key = 用户分组全丢，必须写迁移 |
| 92–133 | 中英文案字典（`topic.loose` = 「未归话题」、`other.title` = 「其他」） | 低 |
| 337 | `defineStore({ persist: PERSIST_KEY })` | 低 |
| 404–419 | **`isListable()`**：隐藏 subagent（按 `origin`）、已归档、非当前空白会话 | **高**：这是"看不到会话"类 bug 的唯一闸门 |
| 429–443 | `formatRelative()` 相对时间（定时刷新） | 低 |
| 453+ | `SessionRow`：悬停/拖拽半区/内联重命名 | 中 |
| 737+ | `WorkspaceSection`：工作区小节 + `+` 新建话题 + 「未归话题」投放行（837） | 中 |
| 923–936 | 启动窗口的 GC（**必须等 `phase === 'ready'`** 才能 `retain`） | **高**：写错会把用户分组删光 |
| 976–981 | `summariesOf()`：按工作区取会话并按 `isListable` 过滤 | 高 |
| 1138 | `renderTopic()`：话题子树递归 | 中 |
| 1170–1176 | `strays`：「其他」组 = 不属于任何工作区的会话 | 中 |
| 1178–1204 | `sections`：`membersOf` / `loose`（未归话题）/ `totalOf`（表头计数） | 中 |
| 1263–1264 | `inject = ["slots","sessions","workspaces","locale"]` | 加依赖 = 加启动风险 |
| 1279–1306 | `injected()`：**接管后必须继承的官方能力**（见 §3） | **高**：漏一个 = 静默少一个功能 |
| 1308+ | `slots.inject("sidebar.workspaces", …)`，`priority: -1` | **高**：单槽 shadow 的核心 |
| test/smoke.mjs | 离线冒烟测试（迷你 React 桩 + 361 项断言） | 改 UI 后必须同步 |

---

## 3. 契约（改代码前必须知道）

1. **单槽 shadow 用最低优先级取胜**：`sidebar.workspaces` 是 single/root 槽，官方注册
   `priority 0`，本插件用 `-1` 抢到槽位。**改了优先级就等于把侧边栏还回官方**（不是"出错"，
   是静默消失）。
2. **接管即继承**：会话行从此由本插件渲染，官方原有的每一项操作都变成本插件的责任。
   当前已实现：打开、重命名（内联）、分叉、归档、拖拽排序、工作区重命名/删除。
   **新增接管范围时，先盘点被替换方的全部动作**（历史事故：第一版只做了"打开"，重命名/分叉/
   归档全静默消失，用户只看到"少了个功能"，看不到是谁拿走的）。
3. **滚动契约**：根节点必须 `flex:1; min-height:0; flex-direction:column`，列表 `flex:1; overflow-y:auto`。
   违反 = 内容被裁且滚不动，**看起来像前端卡死，其实 JS 线程健康**。
4. **store action 可能不返回值**（Redux 风格）：需要原子性的写入要做成单个 action
   （如 `createTopicWithSessions`），不要靠读返回值取新 id。
5. **`retain()` 的空集语义**：比较集为空 = "还没加载"，不是"全都没了"，此时必须直接返回。
   否则刷新后的前几帧会把分组整个删光（历史事故，见 README）。
6. **过滤会话只能用 `origin === 'subagent'`**；`parentId` 是**分叉血缘**，用它过滤会把每个
   分叉出来的会话藏起来。
7. **捕获阶段的监听器早于冒泡**：菜单"点外面关闭"必须判 `ref.current.contains(target)`，
   `stopPropagation` 在捕获阶段救不了。
8. **fixed 菜单要在挂载后量尺寸再钳制视口**，否则贴底右键时最后几项物理上点不到。

---

## 4. 数据与恢复

- 主存储：`localStorage["dsh.session.topics.v2"]`（话题树、会话归属、展开态、排序账户）
- 备份：`localStorage["dsh.session.topics.v2.bak"]`，**每次非空变更都写**
- 恢复条：主存储为空而备份有内容时，侧边栏顶部出现一键还原
- 用户清缓存 = 分组丢失（这是"零 host 依赖"的代价；若要跨设备，需要新增 host 侧存储，
  会破坏 §0 的结构性零风险，属于产品决策，别顺手改）

---

## 5. 已知问题

### 5.1 空壳会话会显示成正常会话（**根因不在本插件**，2026-09-11 查实）

**现象**：侧边栏出现一批零消息的"空对话"，标题回落成工作区名，年龄正好落在崩溃发生的时刻。

**根因**（`@deepseek-ai/dsh-api-session-controller/lib/index.js`）：
```js
:1750  applySessionListMetadata: blank = state.blank && event.type !== "turn/start"
:1819  summaryFor(live):    blank: metadata?.blank ?? session.seq === 0
:1855  summarizeCold(cold): blank: metadata?.blank ?? false     // ← 冷会话缺投影即默认「非草稿」
```
那些会话的 id **不在** `~/.dsh/storages/session_projcache.json` → 走 `:1855` 的默认分支 →
`blank = false` → 官方 `sessionVisible`（`!session.blank || session.id === current`）**和本插件
的 `isListable`（:417）用的是同一个字段**，于是两边都把它们列出来。**改本插件无意义。**

**产生原因**：它们不是对话，是"开起来就死"的会话残骸 —— 日志里只有 3 个配置事件、0 条消息：
```
{"type":"permission/preset","seq":0,"data":{"preset":"workspace-write"}}
{"type":"sandbox/mode","seq":1,"data":{"mode":"workspace-write"}}
{"type":"approval/policy","seq":2,"data":{"policy":"ask"}}
```
与 Windows 沙箱 `0xC0000142`（沙箱子进程 spawn 即死）精确对齐。治本是让新会话默认
`danger-full-access`（已做）。

**可选的缓解路径（各有代价，需产品决策）**：

| 方案 | 做法 | 代价 |
|---|---|---|
| A 客户端启发式 | 无消息 → 视为草稿 | 客户端**拿不到**消息计数（冷会话无 projections），只能靠 `updatedAt`/标题猜，会误杀真会话 |
| B host 侧判定 | 加一个**惰性** host 行，暴露"该会话有几个消息事件" | 破坏"host 半边空壳"的核心设计（但可做成不 inject、只在被调用时才读日志的路由） |
| C 上游修复 | 让 `summarizeCold` 不默认 `false`（或用持久化的 `sessionListMetadata` 投影判断） | 需要提 issue/PR 给 DSH；见效慢但最正确 |

**建议**：先按 C 提上游（本插件不改），若用户不接受等待再评估 B。

### 5.2 官方槽位演进需要人工跟进
本插件顶替 `sidebar.workspaces`。官方若更新该槽位的渲染契约（新增动作/结构），
本插件必须同步实现，否则表现为"用户少了个功能"。

### 5.3 分组不跨设备、清缓存即丢
见 §4，属于已声明的取舍。

---

## 6. 待改进路线（按性价比排序）

1. **话题树导出 / 导入（JSON）** —— 用最小代价补掉 §5.3 的痛点（用户可自行备份/迁移）。
2. **会话搜索 / 过滤**（本插件已在渲染层掌握全量会话，加一个本地过滤输入成本低）。
3. **空壳会话的展示策略** —— 见 §5.1，先定方案再动手。
4. **放开层数**：`MAX_TOPIC_DEPTH` 改大即可，但要先解决侧边栏宽度（缩进会吃掉标题空间）。
5. **打包发布**（见 §8）：npm 包 + GitHub 仓库 + 申请市场收录，让它出现在「发现/主题」。

---

## 7. 开发与验证循环

```powershell
# 1) 改完客户端代码：刷新浏览器页面即可（client bundle 每次加载都重新取）
#    改了 package.json / cordis.patch.yml 才需要重启 dsh web

# 2) 离线回归（不需要浏览器、不需要装依赖）
node D:\DSH_Projects\dsh-session-topics\test\smoke.mjs      # 期望 RESULT: all checks passed

# 3) 静态校验插件行是否被正确解析（工具沙箱里必须重定向到文件，否则输出会被截断成空）
cmd /c "dsh --profile web --dump-config > tmp\dump-topics.txt 2>&1"
Select-String -Path tmp\dump-topics.txt -Pattern 'session-topics' -Context 0,2
```

**回归底线**：冒烟测试必须全绿；动了槽位注册或渲染结构，必须手工点一遍
会话右键菜单（重命名/分叉/归档）、工作区右键菜单、三种拖拽（排序 / 归入话题 / 移出话题）。

---

## 8. 发布与收录（现状：GitHub 已发布；市场收录**未提交**）

**已完成（2026-09-12）**
- 公开仓库 <https://github.com/WangXuexin24/dsh-session-topics>（PUBLIC / 默认分支 `main`）
- 已加 topics：`dsh` `deepseek-harness` `plugin` `session` `sidebar` `dsh-plugin`
- 他人安装：`dsh plugin --profile web add github:WangXuexin24/dsh-session-topics`
- 本机：`link:` 安装，市场「已安装」列表带开关

**未做（可选，按需决定）**
- **npm 发布**：本机 `npm whoami` → 未登录（`ENEEDAUTH`），且 registry 是
  `registry.npmmirror.com`（镜像，不是发布源）。不发不影响从 GitHub 安装。
- **社区目录收录**（出现在市场「发现 / 主题」）：条目已备好 →
  [`market-submission.yml`](./market-submission.yml)。提交前注意：
  - **CI 硬门槛：仓库创建满 1 天**（本仓库创建于 `2026-09-12T03:22:47Z`）——不够会被自动拒；
    官方明确说"做完再重提"不会有任何影响。
  - 一个 PR 最多 3 条；`package.json` 必须有 `dsh.bundle`（我们满足 —— 这是最常见的被拒原因）。
  - CI 依次查：条目数 → `dsh.bundle` → 仓库年龄 → `awesome-lint`；失败可在同分支推修复。

**若将来要提交，建议先做的事**（评审会实际读代码并逐句核对描述）
1. §6 待改进 1：话题树导出/导入 —— 分组只存浏览器本地、清缓存即丢，是用户最容易踩的坑。
2. §5.1 空壳会话：**不要**为了收录去改 host 结构（会破坏「零 host 依赖」的核心设计）；
   正解是上游修复，或做**默认关闭**的可选缓解。

---

## 9. 陷阱速查

- 本仓 README：两条硬约束（GC 只能删它能证明已死的东西 / 用户手搭的东西必须有第二份）+
  菜单捕获阶段 + 滚动契约 + `parentId` 陷阱。
- 本机环境坑：`D:\DSH\notes\dsh-web-运维坑.md`（① 重启 dsh web 必须先杀 3080 旧进程，
  否则静默跑在旧配置上；② 代理靠启动终端的环境变量（含 `NODE_USE_ENV_PROXY=1`）；
  ③ PowerShell `>` 重定向 node 输出会变 UTF-16LE；④ 空壳会话的成因与识别，即 §5.1）。
- 全局规则：`~/.dsh/AGENTS.md`（插件红线：装社区插件前先查是否依赖 `workspace` 服务）。

---

## 附：本次交接时的可核查事实（2026-09-11）

- `node test/smoke.mjs` → `RESULT: all checks passed`（退出码 0）
- 插件在 `~/.dsh/profiles/web/package.json` 的 `dependencies` 与 `dsh.profile.bundles` 中均存在
- 同日运维中归档并删除了 **14 个** 空壳会话日志（共 6578 B），删除后会话目录 0 残留；
  索引库 `session-query.db` 与 `session_projcache.json` 对它们的命中数均为 0
