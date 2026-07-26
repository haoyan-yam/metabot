# MetaBot 本地补丁集 · Local Patch Set

基于上游 [xvirobotics/metabot](https://github.com/xvirobotics/metabot) `main`（f5454e9，2026-07）的 **12 个功能补丁**，主要增强飞书（Feishu/Lark）桥接的群聊体验与消息投递可靠性。

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

代号 A–N 与源码注释里的 `[本地私改·patch X]` 标记一一对应，方便在代码里定位每个补丁的改动和设计取舍说明。

> **已移除**：原补丁 09（thread-topic-reply，代号 I）与 10（at-requester-on-completion，代号 J）于 2026-07-26 移除——飞书话题（thread）功能在部署中已停用，二者生产一个月零触发，且是未来升级基底时最大的冲突面。编号保留空洞不重排；旧补丁可在 git 历史（提交 fd66d7a 及之前）找回。移除时补丁 04/11/12/14 已在无话题基线上重新生成。

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
- **必须按文件名编号顺序应用** —— 多个补丁改同一文件，存在上下文依赖（补丁 14 与 01–07、11 多个补丁同文件叠加，必须最后打）。
- 补丁 02 的配套测试 `tests/media-batch.test.ts` 不在 .patch 内，从 `local-patches` 分支拷贝：
  `git checkout local-patches -- tests/media-batch.test.ts`（补丁 14 的两个新测试已内含在 .patch 中，无需拷贝）。
- 每次改动后全套补丁在干净 f5454e9 检出上重打过，与 `local-patches` 分支逐字节一致；全量测试通过。

## 与上游的关系

其中 3 个补丁已提交上游 PR（复核于 2026-07-22 晚，均仍为 open），上游合并后重打时跳过对应补丁即可：

- 补丁 08（E）→ [xvirobotics/metabot#336](https://github.com/xvirobotics/metabot/pull/336)
- 补丁 01 的去重部分 → [xvirobotics/metabot#337](https://github.com/xvirobotics/metabot/pull/337)
- 补丁 03（B）→ [xvirobotics/metabot#338](https://github.com/xvirobotics/metabot/pull/338)

## License

与上游一致，MIT。原始版权声明见仓库根目录 [LICENSE](../LICENSE)。
