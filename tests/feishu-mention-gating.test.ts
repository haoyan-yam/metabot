import { describe, it, expect } from 'vitest';
import { createReceiveHandler } from '../src/feishu/event-handler.js';
import type { BotConfig } from '../src/config.js';
import type { IncomingMessage } from '../src/types.js';
import type { ListedMessage } from '../src/feishu/round-context.js';

/**
 * [本地私改·patch S] @ 门控 + 本轮上下文拉取 — 接收处理器全链路。
 *
 * 0904/0905 生产事故：用户先发链接/要求/图片，几小时后 @ 一句「处理以上问题」，bot 只
 * 拿到最后一句。现在 @ 触发时桥接按飞书接口拉这个人「本轮」（上一条 @ 之后）的消息：
 * 文本按序拼在前、媒体作附件、引用回复的被引 id 沿用。私聊群聊同一机制，只拉 @ 的
 * 这个人，别人的消息不拉；未 @ 的消息一律静默。假客户端用一份按 chat 存的历史夹具，
 * 结构与真实 im.message.list 一致。处理器有模块级去重表，每条消息用新 id。
 */

const BOT = 'ou_bot';
const logger: any = { debug() {}, info() {}, warn() {}, error() {} };
let seq = 0;
const fresh = (p: string) => `${p}_${process.pid}_${Date.now()}_${++seq}`;
const T0 = Date.parse('2026-09-05T15:49:00+08:00');

/** 一条历史消息（接口结构）。 */
function hist(o: {
  at: number; from?: string; type?: string; content?: unknown; at_bot?: boolean; parent_id?: string; fromBot?: boolean;
}): ListedMessage {
  return {
    message_id: fresh('om'),
    msg_type: o.type ?? 'text',
    create_time: String(o.at),
    parent_id: o.parent_id,
    sender: o.fromBot
      ? { id: 'cli_app', id_type: 'app_id', sender_type: 'app' }
      : { id: o.from ?? 'ou_u1', id_type: 'open_id', sender_type: 'user' },
    body: { content: JSON.stringify(o.content ?? { text: 'x' }) },
    mentions: o.at_bot ? [{ key: '@_user_1', id: BOT, name: 'bot' }] : [],
  };
}

/** 触发事件（WebSocket 结构）。同一条也会被放进历史夹具，与真实一致。 */
function event(o: {
  chatId: string; chatType: 'p2p' | 'group'; at?: number; userId?: string; mention?: boolean;
  type?: 'text' | 'image' | 'post'; text?: string; imageKey?: string; paragraphs?: unknown[][]; parentId?: string;
}) {
  const type = o.type ?? 'text';
  const content = type === 'image'
    ? { image_key: o.imageKey ?? 'img_t' }
    : type === 'post'
      ? { zh_cn: { title: '', content: o.paragraphs ?? [] } }
      : { text: o.mention ? `@_user_1 ${o.text ?? 'go'}` : (o.text ?? 'go') };
  return {
    message: {
      message_id: fresh('om'), chat_id: o.chatId, chat_type: o.chatType, message_type: type,
      create_time: String(o.at ?? T0), content: JSON.stringify(content), parent_id: o.parentId,
      mentions: o.mention ? [{ key: '@_user_1', id: { open_id: BOT }, name: 'bot' }] : [],
    },
    sender: { sender_id: { open_id: o.userId ?? 'ou_u1' }, sender_type: 'user' },
  };
}

function makeHandler(cfg: Partial<BotConfig> = {}, history: Record<string, ListedMessage[]> = {}, opts: { listFails?: boolean } = {}) {
  const received: IncomingMessage[] = [];
  const sent: string[] = [];
  const listCalls: string[] = [];
  const messageSender: any = {
    sendText: async (_c: string, t: string) => { sent.push(t); },
    getChatMemberCount: async () => 2,
    listMessages: async (chatId: string, start: string, end: string) => {
      listCalls.push(chatId);
      if (opts.listFails) return undefined;
      const s = Number(start) * 1000; const e = Number(end) * 1000;
      const items = (history[chatId] ?? [])
        .filter((m) => Number(m.create_time) >= s && Number(m.create_time) <= e)
        .sort((a, b) => Number(b.create_time) - Number(a.create_time));
      return { items, hasMore: false };
    },
  };
  const config = { name: 'demo', feishu: { appId: 'a', appSecret: 'b' }, ...cfg } as BotConfig;
  const handle = createReceiveHandler(config, logger, (m) => received.push(m), BOT, messageSender);
  return { handle, received, sent, listCalls };
}

describe('patch S: @ gating — all chat types alike', () => {
  it('p2p / group / 2-member group without @ are silently dropped; no hint, no history fetch', async () => {
    const h = makeHandler();
    await h.handle(event({ chatId: fresh('oc'), chatType: 'p2p' }));
    await h.handle(event({ chatId: fresh('oc'), chatType: 'group' }));
    await h.handle(event({ chatId: fresh('oc'), chatType: 'p2p', type: 'image' }));
    expect(h.received).toHaveLength(0);
    expect(h.sent).toHaveLength(0);
    expect(h.listCalls).toHaveLength(0);
  });

  it('with @ the message is processed and the tag stripped; a mention of someone else does not count', async () => {
    const h = makeHandler();
    await h.handle(event({ chatId: fresh('oc'), chatType: 'p2p', mention: true, text: 'hi' }));
    expect(h.received).toHaveLength(1);
    expect(h.received[0].text).toBe('hi');
    const ev = event({ chatId: fresh('oc'), chatType: 'group', mention: true, text: 'hi' });
    ev.message.mentions = [{ key: '@_user_1', id: { open_id: 'ou_other' }, name: 'x' }];
    await h.handle(ev);
    expect(h.received).toHaveLength(1);
  });

  it('groupNoMention: group messages pass without @ and do NOT trigger a history fetch; p2p still requires @', async () => {
    const h = makeHandler({ groupNoMention: true });
    await h.handle(event({ chatId: fresh('oc'), chatType: 'group', text: 'hi' }));
    expect(h.received).toHaveLength(1);
    expect(h.listCalls).toHaveLength(0);
    await h.handle(event({ chatId: fresh('oc'), chatType: 'p2p', text: 'hi' }));
    expect(h.received).toHaveLength(1);
  });

  it('groupOnly whitelist gate runs before the @ gate', async () => {
    const h = makeHandler({ groupOnly: true, groupOnlyAllowUsers: ['ou_admin'] });
    await h.handle(event({ chatId: fresh('oc'), chatType: 'p2p', mention: true, userId: 'ou_x' }));
    expect(h.received).toHaveLength(0);
    expect(h.sent).toHaveLength(1);
    await h.handle(event({ chatId: fresh('oc'), chatType: 'p2p', mention: true, userId: 'ou_admin' }));
    expect(h.received).toHaveLength(1);
  });
});

describe('patch S: round context fetched on @ (the 0905 KK shape)', () => {
  it('p2p: two images + a question 3h earlier, then "@bot 处理以上问题" → all three in order + both images', async () => {
    const chatId = fresh('oc');
    const prevAt = hist({ at: T0 - 4 * 3600e3, at_bot: true, content: { text: '@_user_1 上一轮' } });
    const i1 = hist({ at: T0 - 3 * 3600e3, type: 'image', content: { image_key: 'img_1' } });
    const i2 = hist({ at: T0 - 3 * 3600e3 + 1e3, type: 'image', content: { image_key: 'img_2' } });
    const t1 = hist({ at: T0 - 3 * 3600e3 + 30e3, content: { text: '帮我看看我们直播场景的岛台台面用哪个颜色比较好' } });
    const botReply = hist({ at: T0 - 4 * 3600e3 + 60e3, fromBot: true, type: 'interactive', content: {} });
    const h = makeHandler({}, { [chatId]: [prevAt, botReply, i1, i2, t1] });
    await h.handle(event({ chatId, chatType: 'p2p', mention: true, text: '处理以上问题' }));
    expect(h.received).toHaveLength(1);
    expect(h.received[0].text).toBe(
      '[以下是你本轮早先发来的内容，按时间顺序]\n\n帮我看看我们直播场景的岛台台面用哪个颜色比较好\n\n[本条]\n\n处理以上问题',
    );
    expect(h.received[0].extraMedia?.map((m) => m.imageKey)).toEqual(['img_1', 'img_2']);
    expect(h.listCalls).toEqual([chatId]);
  });

  it('group: only the @-er\'s own messages since their previous @; colleagues\' files and chatter are not pulled', async () => {
    const chatId = fresh('oc');
    const mine1 = hist({ at: T0 - 600e3, from: 'ou_me', type: 'file', content: { file_key: 'f1', file_name: '7月导入表.xlsx' } });
    const theirs = hist({ at: T0 - 500e3, from: 'ou_colleague', type: 'file', content: { file_key: 'f2', file_name: 'other.xlsx' } });
    const chatter = hist({ at: T0 - 400e3, from: 'ou_colleague', content: { text: '中午吃啥' } });
    const mine2 = hist({ at: T0 - 300e3, from: 'ou_me', content: { text: '按 7 月格式出 8 月表' } });
    const h = makeHandler({}, { [chatId]: [mine1, theirs, chatter, mine2] });
    await h.handle(event({ chatId, chatType: 'group', mention: true, userId: 'ou_me', text: '执行一下上面的任务' }));
    expect(h.received[0].text).toContain('按 7 月格式出 8 月表');
    expect(h.received[0].text).not.toContain('中午吃啥');
    expect(h.received[0].extraMedia?.map((m) => m.fileName)).toEqual(['7月导入表.xlsx']);
  });

  it('second round starts after the previous @: nothing from the earlier round leaks', async () => {
    const chatId = fresh('oc');
    const oldMat = hist({ at: T0 - 7200e3, content: { text: '旧材料' } });
    const oldAt = hist({ at: T0 - 7000e3, at_bot: true, content: { text: '@_user_1 处理' } });
    const newMat = hist({ at: T0 - 100e3, content: { text: '新材料' } });
    const h = makeHandler({}, { [chatId]: [oldMat, oldAt, newMat] });
    await h.handle(event({ chatId, chatType: 'p2p', mention: true, text: '再处理' }));
    expect(h.received[0].text).toContain('新材料');
    expect(h.received[0].text).not.toContain('旧材料');
  });

  it('an un-@ quote-reply in the round lends its parentId; the trigger\'s own parentId wins', async () => {
    const chatId = fresh('oc');
    const quoted = hist({ at: T0 - 100e3, content: { text: '看这个' }, parent_id: 'om_quoted' });
    const h = makeHandler({}, { [chatId]: [quoted] });
    await h.handle(event({ chatId, chatType: 'p2p', mention: true, text: '处理' }));
    expect(h.received[0].parentId).toBe('om_quoted');
    await h.handle(event({ chatId, chatType: 'p2p', mention: true, text: '处理', parentId: 'om_new', at: T0 + 1e3 }));
    expect(h.received[1].parentId).toBe('om_new');
  });

  it('@ + image trigger: round text is prepended to the default image prompt', async () => {
    const chatId = fresh('oc');
    const h = makeHandler({}, { [chatId]: [hist({ at: T0 - 50e3, content: { text: '按这个风格' } })] });
    await h.handle(event({ chatId, chatType: 'p2p', mention: true, type: 'image', imageKey: 'img_t' }));
    expect(h.received[0].text).toBe('[以下是你本轮早先发来的内容，按时间顺序]\n\n按这个风格\n\n[本条]\n\n请分析这张图片');
    expect(h.received[0].imageKey).toBe('img_t');
  });

  it('post trigger with images keeps its own extra images before the round media', async () => {
    const chatId = fresh('oc');
    const h = makeHandler({}, { [chatId]: [hist({ at: T0 - 50e3, type: 'image', content: { image_key: 'img_old' } })] });
    await h.handle(event({ chatId, chatType: 'group', mention: true, type: 'post', paragraphs: [
      [{ tag: 'at', user_id: BOT }, { tag: 'text', text: '看图' }],
      [{ tag: 'img', image_key: 'img_a' }], [{ tag: 'img', image_key: 'img_b' }],
    ] }));
    expect(h.received[0].imageKey).toBe('img_a');
    expect(h.received[0].extraMedia?.map((m) => m.imageKey)).toEqual(['img_b', 'img_old']);
  });

  it('empty round → plain trigger text, no marker', async () => {
    const h = makeHandler();
    await h.handle(event({ chatId: fresh('oc'), chatType: 'p2p', mention: true, text: 'hi' }));
    expect(h.received[0].text).toBe('hi');
  });

  it('history API failure → task still starts, prompt carries the failure note', async () => {
    const h = makeHandler({}, {}, { listFails: true });
    await h.handle(event({ chatId: fresh('oc'), chatType: 'p2p', mention: true, text: '处理' }));
    expect(h.received).toHaveLength(1);
    expect(h.received[0].text).toBe('[本轮历史拉取失败，需要材料请让用户重发]\n\n处理');
  });

  it('rich-text links keep their URL through the pipeline', async () => {
    const chatId = fresh('oc');
    const h = makeHandler({}, { [chatId]: [hist({ at: T0 - 50e3, type: 'post', content: { zh_cn: { title: '', content: [
      [{ tag: 'a', text: '会议纪要', href: 'https://x.feishu.cn/docx/AAA' }],
    ] } } })] });
    await h.handle(event({ chatId, chatType: 'p2p', mention: true, text: '根据纪要出方案' }));
    expect(h.received[0].text).toContain('会议纪要 (https://x.feishu.cn/docx/AAA)');
  });
});
