# MetaBot 本地补丁集 · Local Patch Set

基于上游 [xvirobotics/metabot](https://github.com/xvirobotics/metabot) `main`（f5454e9，2026-07）的 **13 个功能补丁**，主要增强飞书（Feishu/Lark）桥接的群聊体验与消息投递可靠性。

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
| 09 | thread-topic-reply | I | 话题（thread）内触发的任务，所有卡片/产物/通知全部落回原话题 |
| 10 | at-requester-on-completion | J | 话题任务完成时 @ 发起人，且不受 10 秒免打扰门槛限制 |
| 11 | upload-retry | K | 飞书文件/图片上传加单次超时 + 指数退避重试，防 502 静默丢文件 |
| 12 | notify-send-failure | L | 重试仍失败的文件在群里明确告知文件名，不再静默丢弃 |
| 13 | workspace-claude-template | M | 新 bot 工作区 `CLAUDE.md` 换成精简的初始模板 |

代号 A–M 与源码注释里的 `[本地私改·patch X]` 标记一一对应，方便在代码里定位每个补丁的改动和设计取舍说明。

## 使用方式

**方式一（推荐）：直接用 `local-patches` 分支**

```bash
git clone <本仓库> && cd metabot
git checkout local-patches
```

**方式二：在你自己的 metabot 检出上重打**

```bash
cd /path/to/your/metabot   # 基于上游 f5454e9 附近的版本
bash patches/apply-all.sh
```

或手工按编号顺序逐个 `git apply --recount patches/NN-*.patch`。

注意事项：

- **必须按文件名编号顺序应用** —— 多个补丁改同一文件，存在上下文依赖。
- 补丁 02 的配套测试 `tests/media-batch.test.ts` 不在 .patch 内，从 `local-patches` 分支拷贝：
  `git checkout local-patches -- tests/media-batch.test.ts`
- 基于其他上游版本重打可能需要手工解决冲突；`--recount` 已容忍行号漂移。

## 与上游的关系

其中 3 个补丁已提交上游 PR（截至 2026-07-22 均为 open 状态），上游合并后重打时跳过对应补丁即可：

- 补丁 08（E）→ [xvirobotics/metabot#336](https://github.com/xvirobotics/metabot/pull/336)
- 补丁 01 的去重部分 → [xvirobotics/metabot#337](https://github.com/xvirobotics/metabot/pull/337)
- 补丁 03（B）→ [xvirobotics/metabot#338](https://github.com/xvirobotics/metabot/pull/338)

## License

与上游一致，MIT。原始版权声明见仓库根目录 [LICENSE](../LICENSE)。
