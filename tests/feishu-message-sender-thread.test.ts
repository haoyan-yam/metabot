import { describe, it, expect, vi } from 'vitest';
import { MessageSender } from '../src/feishu/message-sender.js';
import type { ReplyTarget } from '../src/bridge/message-sender.interface.js';

/**
 * [本地私改·patch I] 话题（thread/topic）回复路由 — MessageSender 层。
 *
 * 在话题里 @bot 时，所有出站消息必须以「回复触发消息」的形式创建才会落进
 * 话题（message.create 只能发到主聊天）。这些测试锁定三条硬规则：
 *
 *   1. 带 replyTo → 走 im.v1.message.reply（inThread 时带 reply_in_thread），
 *      不碰 create；返回 reply 的 message_id 供后续 patch 流式更新。
 *   2. 不带 replyTo → 行为与改动前逐字节一致（走 create）——主聊天/私聊回归。
 *   3. reply 失败（锚点消息被撤回/过期）→ 回退 create 主聊天保底，绝不丢消息。
 *
 * 另锁定 patch G 回归：reply 分支同样要走 redactSensitive 出站脱敏。
 */

const mockLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as any;

function makeClient(opts: { replyFails?: boolean } = {}) {
  const reply = opts.replyFails
    ? vi.fn().mockRejectedValue(new Error('reply target gone'))
    : vi.fn().mockResolvedValue({ data: { message_id: 'om_reply' } });
  const create = vi.fn().mockResolvedValue({ data: { message_id: 'om_create' } });
  const client = { im: { v1: { message: { reply, create, patch: vi.fn() } } } } as any;
  return { client, reply, create };
}

const target: ReplyTarget = { messageId: 'om_trigger', inThread: true };

describe('MessageSender thread reply routing (patch I)', () => {
  it('sendCard with replyTo goes through reply (reply_in_thread) and returns its message_id', async () => {
    const { client, reply, create } = makeClient();
    const sender = new MessageSender(client, mockLogger);
    const id = await sender.sendCard('oc_chat', '{"elements":[]}', target);
    expect(id).toBe('om_reply');
    expect(create).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledOnce();
    const call = reply.mock.calls[0][0];
    expect(call.path.message_id).toBe('om_trigger');
    expect(call.data.msg_type).toBe('interactive');
    expect(call.data.reply_in_thread).toBe(true);
  });

  it('sendCard with replyTo but no inThread omits reply_in_thread', async () => {
    const { client, reply } = makeClient();
    const sender = new MessageSender(client, mockLogger);
    await sender.sendCard('oc_chat', '{}', { messageId: 'om_trigger' });
    expect(reply.mock.calls[0][0].data).not.toHaveProperty('reply_in_thread');
  });

  it('sendCard without replyTo still uses create (main-chat regression)', async () => {
    const { client, reply, create } = makeClient();
    const sender = new MessageSender(client, mockLogger);
    const id = await sender.sendCard('oc_chat', '{}');
    expect(id).toBe('om_create');
    expect(reply).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0][0].params.receive_id_type).toBe('chat_id');
  });

  it('sendCard falls back to create when reply fails (anchor recalled)', async () => {
    const { client, reply, create } = makeClient({ replyFails: true });
    const sender = new MessageSender(client, mockLogger);
    const id = await sender.sendCard('oc_chat', '{}', target);
    expect(reply).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledOnce();
    expect(id).toBe('om_create');
  });

  it('reply path still applies outbound redaction (patch G regression)', async () => {
    const { client, reply } = makeClient();
    const sender = new MessageSender(client, mockLogger);
    await sender.sendCard('oc_chat', '{"text":"saved to /Users/alice/projects/secret-dir/plan"}', target);
    const sent = reply.mock.calls[0][0].data.content as string;
    expect(sent).not.toContain('/Users/alice');
    expect(sent).toContain('〈本地路径〉');
  });

  it('sendImage / sendFile / sendAudio with replyTo reply with the right msg_type', async () => {
    const { client, reply, create } = makeClient();
    const sender = new MessageSender(client, mockLogger);
    await expect(sender.sendImage('oc_chat', 'img_key', target)).resolves.toBe(true);
    await expect(sender.sendFile('oc_chat', 'file_key', target)).resolves.toBe(true);
    await expect(sender.sendAudio('oc_chat', 'audio_key', target)).resolves.toBe(true);
    expect(create).not.toHaveBeenCalled();
    expect(reply.mock.calls.map((c: any[]) => c[0].data.msg_type)).toEqual(['image', 'file', 'audio']);
    expect(JSON.parse(reply.mock.calls[0][0].data.content).image_key).toBe('img_key');
  });

  it('sendImage falls back to create and still succeeds when reply fails', async () => {
    const { client, create } = makeClient({ replyFails: true });
    const sender = new MessageSender(client, mockLogger);
    await expect(sender.sendImage('oc_chat', 'img_key', target)).resolves.toBe(true);
    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0][0].data.msg_type).toBe('image');
  });

  it('sendText quote-reply stays untouched — no reply_in_thread (patch D regression)', async () => {
    const { client, reply } = makeClient();
    const sender = new MessageSender(client, mockLogger);
    await sender.sendText('oc_chat', 'done', 'om_trigger');
    expect(reply).toHaveBeenCalledOnce();
    expect(reply.mock.calls[0][0].data).not.toHaveProperty('reply_in_thread');
  });
});
