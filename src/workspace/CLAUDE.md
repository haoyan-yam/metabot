# <项目名> 项目工作区(<品牌>)

> **本文件是 MetaBot 新 bot 的初始模板**——把 `<...>` 占位补齐后,删除本说明段。
> 本工作区由一个 MetaBot bot 使用(通过 Feishu/Telegram 访问,引擎按 bot 在 `bots.json` 配置:`engine: "claude" | "kimi" | "codex"`)。
> **前提**:工作目录须放在 `~/projects/` 下,以自动继承 `~/projects/CLAUDE.md` 的全局规范(文件存放规范、lark-cli 身份硬规则、保密规则、MetaBot 能力速查)。共用规则**只写在那份全局文件里**,本文件只写本 bot 专属事实,勿把全局内容复制进来。

本工作区由 **<bot名>** 使用,是 <项目> 的独立工作目录——记忆与会话记录与其他项目 bot 完全隔离,互不可见。

> 对应飞书群:<群名> `oc_xxx`。(没有已知群 ID 就删掉本行)

## Feishu / Lark CLI

本 bot 的 lark-cli profile 是 **`<profile>`**——每条命令必须带 `--profile <profile> --as bot`,严禁裸跑。硬规则与操作提示见 `~/projects/CLAUDE.md`。

## 记忆

写共享库时用 `--tags <tag>`;客户机密只写本地记忆(全局保密规则)。

## 📌 项目背景(待团队补充)

> 按 `~/projects/CLAUDE.md`「项目背景结构」补齐后替换本段。
