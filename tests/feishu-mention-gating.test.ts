import { describe, it, expect } from 'vitest';
import { createReceiveHandler, extractTextFromPost } from '../src/feishu/event-handler.js';
import type { BotConfig } from '../src/config.js';
import type { IncomingMessage } from '../src/types.js';

/**
 * [本地私改·patch S] @ 门控与「未 @ 先缓存」全链路。
 *
 * 2026-09-04 生产事故：补丁 S 上线后，KK 在私聊里先发链接与要求、最后 @ 一句
 * 「处理以上需求」——前面的文本全被静默丢弃，bot 只拿到最后一句。这些用例锁定：
 *   1. 私聊/群聊/两人群都要 @；未 @ 静默、不回提示。
 *   2. 私聊未 @ 的文本（含引用回复的 parentId）与媒体一起暂存，@ 时按时间顺序拼回，
 *      触发消息永远在最后；缓存只消费一次、按发送人隔离。
 *   3. 群聊未 @ 的文本不缓存（群里闲聊不是说给 bot 的），媒体照旧缓存。
 *   4. 富文本链接保留 href，粘贴的文档链接不再只剩标题。
 *
 * 处理器有模块级缓存（去重 message_id / chat:user 媒体文本），每个用例用新 id 隔离。
 */

const BOT = 'ou_bot';
const logger: any = { debug() {}, info() {}, warn() {}, error() {} };
let seq = 0;
const fresh = (prefix: string) => `${prefix}_${process.pid}_${Date.now()}_${++seq}`;

interface EvOpts { chatId: string; chatType: 'p2p' | 'group'; userId?: string; mention?: boolean; parentId?: string }
const mentions = (on?: boolean) => (on ? [{ key: '@_user_1', id: { open_id: BOT }, name: 'bot' }] : []);
const sender = (o: EvOpts) => ({ sender_id: { open_id: o.userId ?? 'ou_u1' }, sender_type: 'user' });

function textEvent(o: EvOpts & { text: string }) {
  return {
    message: {
      message_id: fresh('om'), chat_id: o.chatId, chat_type: o.chatType, message_type: 'text',
      content: JSON.stringify({ text: o.mention ? `@_user_1 ${o.text}` : o.text }),
      mentions: mentions(o.mention), parent_id: o.parentId,
    },
    sender: sender(o),
  };
}
function imageEvent(o: EvOpts & { imageKey: string }) {
  return {
    message: {
      message_id: fresh('om'), chat_id: o.chatId, chat_type: o.chatType, message_type: 'image',
      content: JSON.stringify({ image_key: o.imageKey }), mentions: mentions(o.mention),
    },
    sender: sender(o),
  };
}
function fileEvent(o: EvOpts & { fileKey: string; fileName: string }) {
  return {
    message: {
      message_id: fresh('om'), chat_id: o.chatId, chat_type: o.chatType, message_type: 'file',
      content: JSON.stringify({ file_key: o.fileKey, file_name: o.fileName }), mentions: [],
    },
    sender: sender(o),
  };
}
function postEvent(o: EvOpts & { paragraphs: unknown[][] }) {
  return {
    message: {
      message_id: fresh('om'), chat_id: o.chatId, chat_type: o.chatType, message_type: 'post',
      content: JSON.stringify({ zh_cn: { title: '', content: o.paragraphs } }), mentions: mentions(o.mention),
    },
    sender: sender(o),
  };
}

function makeHandler(cfg: Partial<BotConfig> = {}) {
  const received: IncomingMessage[] = [];
  const sent: string[] = [];
  const messageSender: any = {
    sendText: async (_chatId: string, text: string) => { sent.push(text); },
    getChatMemberCount: async () => 2,
  };
  const config = { name: 'demo', feishu: { appId: 'a', appSecret: 'b' }, ...cfg } as BotConfig;
  const handle = createReceiveHandler(config, logger, (m) => received.push(m), BOT, messageSender);
  return { handle, received, sent };
}

describe('patch S: private chats require @mention', () => {
  it('p2p without @ is silently dropped (no hint reply); with @ is processed and tag stripped', async () => {
    const h = makeHandler();
    const chatId = fresh('oc');
    await h.handle(textEvent({ chatId, chatType: 'p2p', text: 'hi' }));
    expect(h.received).toHaveLength(0);
    expect(h.sent).toHaveLength(0);
    await h.handle(textEvent({ chatId: fresh('oc'), chatType: 'p2p', text: 'hi', mention: true }));
    expect(h.received).toHaveLength(1);
    expect(h.received[0].text).toBe('hi');
  });

  it('a mention of someone else does not count', async () => {
    const h = makeHandler();
    const ev = textEvent({ chatId: fresh('oc'), chatType: 'p2p', text: 'hi', mention: true });
    ev.message.mentions = [{ key: '@_user_1', id: { open_id: 'ou_other' }, name: 'x' }];
    await h.handle(ev);
    expect(h.received).toHaveLength(0);
  });

  it('2-member groups are groups: @ required, no member-count exemption', async () => {
    const h = makeHandler();
    const chatId = fresh('oc');
    await h.handle(textEvent({ chatId, chatType: 'group', text: 'hi' }));
    expect(h.received).toHaveLength(0);
    await h.handle(textEvent({ chatId, chatType: 'group', text: 'hi', mention: true }));
    expect(h.received).toHaveLength(1);
  });

  it('groupNoMention is the only bypass and applies to p2p too', async () => {
    const h = makeHandler({ groupNoMention: true });
    await h.handle(textEvent({ chatId: fresh('oc'), chatType: 'p2p', text: 'hi' }));
    await h.handle(textEvent({ chatId: fresh('oc'), chatType: 'group', text: 'hi' }));
    expect(h.received).toHaveLength(2);
  });

  it('groupOnly whitelist gate runs before the @ gate', async () => {
    const h = makeHandler({ groupOnly: true, groupOnlyAllowUsers: ['ou_admin'] });
    await h.handle(textEvent({ chatId: fresh('oc'), chatType: 'p2p', text: 'hi', mention: true, userId: 'ou_x' }));
    expect(h.received).toHaveLength(0);
    expect(h.sent).toHaveLength(1);
    await h.handle(textEvent({ chatId: fresh('oc'), chatType: 'p2p', text: 'hi', userId: 'ou_admin' }));
    expect(h.received).toHaveLength(0);
    expect(h.sent).toHaveLength(1);
    await h.handle(textEvent({ chatId: fresh('oc'), chatType: 'p2p', text: 'hi', mention: true, userId: 'ou_admin' }));
    expect(h.received).toHaveLength(1);
  });
});

describe('patch S: private un-@ text is cached and prepended on the next @ (the 0904 incident shape)', () => {
  it('link + requirement sent first, "@bot 处理以上需求" last → bot sees all three in order', async () => {
    const h = makeHandler();
    const chatId = fresh('oc');
    await h.handle(textEvent({ chatId, chatType: 'p2p', text: 'https://x.feishu.cn/docx/AAA' }));
    await h.handle(textEvent({ chatId, chatType: 'p2p', text: '根据会议纪要出一份工作安排' }));
    expect(h.received).toHaveLength(0);
    await h.handle(textEvent({ chatId, chatType: 'p2p', text: '处理以上需求', mention: true }));
    expect(h.received).toHaveLength(1);
    expect(h.received[0].text).toBe('https://x.feishu.cn/docx/AAA\n\n根据会议纪要出一份工作安排\n\n处理以上需求');
  });

  it('text and media interleave: texts joined in order, media become extraMedia', async () => {
    const h = makeHandler();
    const chatId = fresh('oc');
    await h.handle(textEvent({ chatId, chatType: 'p2p', text: 'A' }));
    await h.handle(imageEvent({ chatId, chatType: 'p2p', imageKey: 'img_1' }));
    await h.handle(fileEvent({ chatId, chatType: 'p2p', fileKey: 'file_1', fileName: 'a.pdf' }));
    await h.handle(textEvent({ chatId, chatType: 'p2p', text: 'B' }));
    await h.handle(textEvent({ chatId, chatType: 'p2p', text: 'go', mention: true }));
    expect(h.received).toHaveLength(1);
    expect(h.received[0].text).toBe('A\n\nB\n\ngo');
    expect(h.received[0].extraMedia?.map((m) => m.imageKey ?? m.fileKey)).toEqual(['img_1', 'file_1']);
  });

  it('cache is consumed once and isolated per sender', async () => {
    const h = makeHandler();
    const chatId = fresh('oc');
    await h.handle(textEvent({ chatId, chatType: 'p2p', text: 'A', userId: 'ou_a' }));
    await h.handle(textEvent({ chatId, chatType: 'p2p', text: 'go', mention: true, userId: 'ou_b' }));
    expect(h.received[0].text).toBe('go');
    await h.handle(textEvent({ chatId, chatType: 'p2p', text: 'go', mention: true, userId: 'ou_a' }));
    expect(h.received[1].text).toBe('A\n\ngo');
    expect(h.received[1].extraMedia).toBeUndefined();
    await h.handle(textEvent({ chatId, chatType: 'p2p', text: 'again', mention: true, userId: 'ou_a' }));
    expect(h.received[2].text).toBe('again');
  });

  it('an un-@ quote-reply carries its parentId to the trigger; the trigger\'s own parentId wins', async () => {
    const h = makeHandler();
    const chatId = fresh('oc');
    await h.handle(textEvent({ chatId, chatType: 'p2p', text: '看这个', parentId: 'om_quoted' }));
    await h.handle(textEvent({ chatId, chatType: 'p2p', text: '处理', mention: true }));
    expect(h.received[0].parentId).toBe('om_quoted');
    expect(h.received[0].text).toBe('看这个\n\n处理');

    await h.handle(textEvent({ chatId, chatType: 'p2p', text: '看这个', parentId: 'om_old' }));
    await h.handle(textEvent({ chatId, chatType: 'p2p', text: '处理', mention: true, parentId: 'om_new' }));
    expect(h.received[1].parentId).toBe('om_new');
  });

  it('@ + image trigger still gets the cached text prepended to the default image prompt', async () => {
    const h = makeHandler();
    const chatId = fresh('oc');
    await h.handle(textEvent({ chatId, chatType: 'p2p', text: '按这个风格' }));
    await h.handle(imageEvent({ chatId, chatType: 'p2p', imageKey: 'img_t', mention: true }));
    expect(h.received[0].text).toBe('按这个风格\n\n请分析这张图片');
    expect(h.received[0].imageKey).toBe('img_t');
  });

  it('un-@ post in p2p: text cached, its images cached as media', async () => {
    const h = makeHandler();
    const chatId = fresh('oc');
    await h.handle(postEvent({ chatId, chatType: 'p2p', paragraphs: [
      [{ tag: 'text', text: '参考图' }],
      [{ tag: 'img', image_key: 'img_p1' }],
      [{ tag: 'img', image_key: 'img_p2' }],
    ] }));
    expect(h.received).toHaveLength(0);
    await h.handle(textEvent({ chatId, chatType: 'p2p', text: '出图', mention: true }));
    expect(h.received[0].text).toBe('参考图\n\n出图');
    expect(h.received[0].extraMedia?.map((m) => m.imageKey)).toEqual(['img_p1', 'img_p2']);
  });
});

describe('patch S: group text is NOT cached, group media still is', () => {
  it('un-@ group text is dropped for good; media attaches on the next @', async () => {
    const h = makeHandler();
    const chatId = fresh('oc');
    await h.handle(textEvent({ chatId, chatType: 'group', text: '闲聊' }));
    await h.handle(imageEvent({ chatId, chatType: 'group', imageKey: 'img_g' }));
    await h.handle(textEvent({ chatId, chatType: 'group', text: '看图', mention: true }));
    expect(h.received).toHaveLength(1);
    expect(h.received[0].text).toBe('看图');
    expect(h.received[0].extraMedia?.[0].imageKey).toBe('img_g');
  });
});

describe('patch S: rich-text links keep their URL', () => {
  const post = (paragraphs: unknown[][]) => ({ zh_cn: { title: '', content: paragraphs } });

  it('label + href → "label (href)"; label that is the URL itself is not duplicated', () => {
    expect(extractTextFromPost(post([[
      { tag: 'text', text: '见 ' },
      { tag: 'a', text: '会议纪要', href: 'https://x.feishu.cn/docx/AAA' },
    ]]))).toBe('见 会议纪要 (https://x.feishu.cn/docx/AAA)');
    expect(extractTextFromPost(post([[
      { tag: 'a', text: 'https://x.feishu.cn/docx/AAA', href: 'https://x.feishu.cn/docx/AAA' },
    ]]))).toBe('https://x.feishu.cn/docx/AAA');
    expect(extractTextFromPost(post([[{ tag: 'a', text: 'no-href' }]]))).toBe('no-href');
  });

  it('the URL survives the whole pipeline into the prompt', async () => {
    const h = makeHandler();
    await h.handle(postEvent({ chatId: fresh('oc'), chatType: 'p2p', mention: true, paragraphs: [[
      { tag: 'at', user_id: BOT, user_name: 'bot' },
      { tag: 'a', text: '会议纪要', href: 'https://x.feishu.cn/docx/AAA' },
    ] ] }));
    expect(h.received[0].text).toContain('https://x.feishu.cn/docx/AAA');
  });
});
