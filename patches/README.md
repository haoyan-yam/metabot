# MetaBot 本地补丁集 · Local Patch Set

基于上游 [xvirobotics/metabot](https://github.com/xvirobotics/metabot) `main`（f5454e9，2026-07）的 **17 个功能补丁**，主要增强飞书（Feishu/Lark）桥接的群聊体验与消息投递可靠性。

**`local-patches` 分支已把全部补丁应用进源码**，clone 后切到该分支即可直接使用；本目录附带补丁原件（`git diff` 格式），便于你在自己的 metabot 检出上选择性重打。

## 补丁清单（文件名按应用顺序编号）

| # | 补丁 | 代号 | 作用 |
|---|------|:---:|------|
| 01 | grouponly-private-chat | A | `groupOnly` 模式：bot 只在群聊工作、私聊仅白名单可用（新增 `groupOnly` / `groupOnlyAllowUsers` 配置）；并按 `message_id` 去重 webhook 重投递 |
| 02 | msg-merge | C | 同一发送人快速连发的多条消息合并为一个任务，不再排队逐条跑 |
| 03 | keep-uploaded-files | B | 下载进持久 `inputs/` 目录的上传文件，任务结束不再被清掉 |
| 04 | reply-quote-notify | D | 群聊完成通知改为对触发消息的「引用回复」，精确通知提问人 |
| 05 | at-user-on-question | F | 选择卡（AskUserQuestion）出现时 @ 提问人，防止 5 分钟无人应答超时 |
| 06 | inject-sender-openid | H | 把提问人 open_id 注入每回合 prompt，bot 授权/发权限时不再猜人 |
| 07 | redact-outbound-sensitive | G | 出站脱敏：本机绝对路径与密钥形态字符串在发出前强制过滤 |
| 08 | clear-outputs-on-turn-start | E | 每回合开始清空发送暂存目录，根治「重复发上一轮图片」 |
| 11 | upload-retry | K | 飞书文件/图片上传加单次超时 + 指数退避重试，防 502 静默丢文件 |
| 12 | notify-send-failure | L | 重试仍失败的文件在群里明确告知文件名，不再静默丢弃 |
| 13 | workspace-claude-template | M | 新 bot 工作区 `CLAUDE.md` 换成精简的初始模板 |
| 14 | large-file-chunk-download | N | 超 100MB 附件（单次 GET 报 234037）自动转 HTTP Range 分片下载；下载失败不再静默——prompt 里写明文件名与原因；群聊媒体缓存 TTL 5→30 分钟、过期丢弃打 WARN |
| 15 | quote-context-injection | P | 群聊「引用回复 + @bot」时把被引内容注入回合上下文：自家消息走出站台账（卡片存终版文本、媒体存 key 可回捞重下），他人消息走 `message.get` 拉取，被引图片/文件落地为本地文件喂给 agent；任何失败降级提示、绝不影响本回合 |
| 16 | send-and-sweep-outputs | Q | 发送目录生命周期补全：发送成功**立即删除**（「目录里还有 = 一定没发过」，所有入口天然免疫重复发送）；spontaneous 卡片后 / 开轮清空前 / 延迟 rmSync 前三处**补扫发送**残留——后台任务（慢速生图）回合结束后落盘的产物不再被静默销毁，落盘即发；per-chat 发送互斥防并发双发。关闭补丁 08 的已知取舍缺口 |
| 17 | background-card-denoise | R | Running 卡片「📡 Background」区块去代码化：后台 Bash 任务的 SDK 描述就是命令原文，逐条上卡即一墙 shell + 蓝链 URL。改为经 tool_use_id（缺失时按命令原文匹配）关联回模型写的人话 `description` 上卡，关联不到时显示「后台命令」；summary 命令回显判重丢弃、展示文本去 URL；failed/stopped 永远逐条且置顶、running 合计上限 6 条溢出折叠、completed 折叠为计数；终卡（Complete/Error）整块隐藏 |
| 18 | private-require-mention | S | 私聊也要 @bot 才回答：判定与群聊完全一致（`mentions` 命中 bot open_id），未 @ 静默；私聊里未 @ 的**文本、链接、引用回复、图片/文件**一起暂存 30 分钟，下次 @ 时文本按时间顺序拼到提示词前面、媒体作附件、被引内容照常注入（「先发材料、最后 @ 一句处理」完整可用）；群聊只暂存媒体不暂存文本；去掉上游「两人群视同私聊免 @」豁免；富文本链接保留 URL。`groupNoMention` 仍是唯一免 @ 开关；谁能私聊仍由补丁 01 白名单决定。接收处理器抽成导出工厂并配 14 例全链路测试 |
| 19 | idle-compacted-rollover | T | 空闲 ≥3 小时**且**已经历过上下文压缩的 Claude 会话，下一条消息自动开新会话（不再 resume），并把旧会话最近 10 轮对话 + 最后一次完整回复作为 `<system-reminder>` 交接块注入首条 prompt（三引号围栏、剥掉旧 prompt 里的提醒块、剔除每日总结等静默定时任务）。根治「一个群一个会话永不清零 → 每天自动压缩 2–6 次、每次 2.5–4 分钟且随机砸在任务中间」（2026-09-05 实证）。判定按 transcript `.jsonl` 的 mtime 与 `compact_boundary` 标记（增量扫描、命中缓存，240 MB 文件 14 ms）；没压缩过的会话继续 resume；只对 claude 引擎生效，带 codex goal 的会话跳过；任何一步失败都退回照常 resume。环境变量 `METABOT_ROLLOVER_IDLE_MS`（默认 3h）/ `METABOT_ROLLOVER_DISABLED=1`。审计事件 `session_rollover`。`SessionManager.rolloverSession` 只清 sessionId，保留用量/模型/goal（与 `/reset` 不同）。15 例单测 |

代号 A–T 与源码注释里的 `[本地私改·patch X]` 标记一一对应，方便在代码里定位每个补丁的改动和设计取舍说明（I/J 已移除、O 预留给搁置的 outputs 投递重构，均不复用）。

> **已移除**：原补丁 09（thread-topic-reply，代号 I）与 10（at-requester-on-completion，代号 J）于 2026-07-26 移除——飞书话题（thread）功能在部署中已停用，二者生产一个月零触发，且是未来升级基底时最大的冲突面。编号保留空洞不重排；旧补丁可在 git 历史（提交 fd66d7a 及之前）找回。移除时补丁 04/11/12/14 已在无话题基线上重新生成。

## 适用性说明（第三方使用前请读）

这套补丁源自一个真实生产部署，承载了该部署的运营决策。代码里**没有任何密钥、真实 ID 或本机路径**（`bots.json`/`.env` 均不入库，需自行配置），可以放心 clone；但直接使用前请了解这些前提：

- **中文 UX 硬编码**：所有用户可见文案（如「⚠️ 有文件没发出来」「请用文字回复…」）与注入给 agent 的 prompt 均为中文，非中文团队需自行替换。
- **仅飞书实现**：全部增强只实现在 Feishu sender；Telegram bot 可正常编译运行，但拿不到任何补丁行为。补丁 07 的路径脱敏规则以类 Unix 路径为主（`/Users/`、`~/`、`/tmp/`），Windows 部署上基本不生效。
- **除 groupOnly 外均无开关**：消息合并（02）、每回合清空发送目录（08）、出站脱敏（07）、@提问人（05）、引用注入（15）等都是 always-on 硬编码行为，不想要某一个只能反打对应补丁。只有补丁 01 的 `groupOnly` 走 `bots.json` 配置，不配即上游默认行为。
- **补丁 08 的已知取舍（已由补丁 16 关闭）**：每回合清空发送暂存目录根治了「重复发上一轮图片」，但若有**跨回合的后台任务**（如空闲窗口落盘生图）把文件写进该目录，会被下一回合开轮清掉或 5 分钟延迟清理静默销毁（2026-07-30 生产事故实锤）。补丁 16 以「发过即删 + 三处补扫」补全生命周期：迟到产物落盘即发、清理前先发后删，重复发送则由「发过即删」物理杜绝。打 08 建议连带打 16；只打 08 不打 16 = 保留该缺口。
- **补丁 18 让私聊也必须 @**：打上后私聊/两人群不 @ 就不回（静默），这是本部署刻意的选择——飞书私聊里发图片/文件会立刻提交给 bot 开始分析，而团队习惯是「先把文件、链接、要求发齐，最后 @ 一句处理」；未 @ 的内容会暂存 30 分钟等下次 @ 一起带上。想保留上游「私聊直接回」行为的，不要打 18。
- **补丁 19 会自动换会话**：空闲 3 小时且压缩过的群会话会在下一条消息时开新会话，bot 会失去旧会话上下文（只保留交接块 + 磁盘文件 + 记忆）。习惯用「接着上次那个改」这类指代的团队要注意首条消息可能多花半分钟定位任务；不想要就设 `METABOT_ROLLOVER_DISABLED=1`，或用 `METABOT_ROLLOVER_IDLE_MS` 调阈值。
- **补丁 15 需要额外飞书权限**：拉取**他人**被引消息依赖应用的消息读取 scope，租户未开通时优雅降级（引用 bot 自己的消息不受影响）；出站台账落在运行者的 `~/.metabot/outbound-ledger.db`（或 `SESSION_STORE_DIR`）。
- **补丁 13 的模板是团队定制**：新 bot 工作区模板指向本部署的 `~/projects/CLAUDE.md` 全局规范与 lark-cli profile 约定，其他环境建议改掉该补丁或自行替换 `src/workspace/CLAUDE.md` 模板内容。

## 使用方式

**方式一（推荐）：直接用 `local-patches` 分支**

```bash
git clone <本仓库> && cd metabot
git checkout local-patches
```

**方式二：在你自己的 metabot 检出上重打**

```bash
cd /path/to/your/metabot
git checkout f5454e9        # 必须基于此基底提交（见下）
bash patches/apply-all.sh
```

或手工按编号顺序逐个 `git apply --recount patches/NN-*.patch`。

注意事项：

- **基底必须是 `f5454e9`** —— 上游 `main` 已前移（截至 2026-07-22 为 `471f36c`，含 #335–#351 / v1.2.0），实测本补丁集在最新上游上无法干净应用（补丁 01 即冲突）。在新上游上使用请等移植版，或自行解决冲突。
- **必须按文件名编号顺序应用** —— 多个补丁改同一文件，存在上下文依赖（补丁 14 与 01–07、11 多个补丁同文件叠加；补丁 15 以 01–14 全打为基线生成，必须最后打）。
- 补丁 02 的配套测试 `tests/media-batch.test.ts` 不在 .patch 内，从 `local-patches` 分支拷贝：
  `git checkout local-patches -- tests/media-batch.test.ts`（补丁 14 的两个新测试、补丁 15 的三个新测试与两个新源文件已内含在各自 .patch 中，无需拷贝）。
- 补丁 15 的出站台账落在 `~/.metabot/outbound-ledger.db`（仓库外），升级/重打不影响已积累的台账。
- 每次改动后全套补丁在干净 f5454e9 检出上重打过，与 `local-patches` 分支逐字节一致；全量测试通过。

## 与上游的关系

其中 3 个补丁已提交上游 PR（复核于 2026-07-22 晚，均仍为 open），上游合并后重打时跳过对应补丁即可：

- 补丁 08（E）→ [xvirobotics/metabot#336](https://github.com/xvirobotics/metabot/pull/336)
- 补丁 01 的去重部分 → [xvirobotics/metabot#337](https://github.com/xvirobotics/metabot/pull/337)
- 补丁 03（B）→ [xvirobotics/metabot#338](https://github.com/xvirobotics/metabot/pull/338)

## License

与上游一致，MIT。原始版权声明见仓库根目录 [LICENSE](../LICENSE)。
