import type { BotConfigBase } from '../config.js';
import type { CardState } from '../types.js';
import type { Logger } from '../utils/logger.js';
import type { IMessageSender } from './message-sender.interface.js';
import { isVoiceReplyEnabled } from './voice-reply.js';

export const COMPLETION_NOTICE_MIN_DURATION_MS = 10_000;

/**
 * Sends the small push-only completion notice for long-running tasks.
 * Rich details stay in the card footer; this path is only for notification surfaces.
 */
export async function sendCompletionNotice(opts: {
  sender: IMessageSender;
  config: BotConfigBase;
  logger: Logger;
  chatId: string;
  state: CardState;
  durationMs: number;
  /**
   * [本地私改] When set (group chats), the completion notice is sent as a
   * quote-reply to the triggering message, so the asker's Feishu push lands
   * exactly when the answer is ready (the rich answer is already in the card
   * above). Private chats pass undefined and get a plain notice as before.
   */
  replyToMessageId?: string;
  /**
   * [本地私改·patch J] 话题任务的完成通知：话题内回复的推送很弱（不像主聊天
   * 引用回复自带「回复了你」提醒），所以 (1) 文本前 @ 任务发起人做强提醒，
   * (2) 不受 10s 免打扰门槛限制——话题里的活不论长短，干完都要叫到人。
   * 主聊天/私聊不传，行为不变。
   */
  threadNotice?: { atUserId: string };
}): Promise<void> {
  const { sender, config, logger, chatId, state, durationMs, replyToMessageId, threadNotice } = opts;

  if (sender.skipCompletionNotice) return;
  if (state.status === 'complete' && isVoiceReplyEnabled(config)) return;
  if (durationMs < COMPLETION_NOTICE_MIN_DURATION_MS && !threadNotice) return;

  const statusEmoji = state.status === 'complete' ? '✅' : '❌';
  const statusWord = state.status === 'complete' ? 'Done' : 'Failed';
  const atPrefix = threadNotice ? `<at user_id="${threadNotice.atUserId}"></at> ` : '';

  try {
    await sender.sendText(chatId, `${atPrefix}${statusEmoji} ${statusWord}`, replyToMessageId);
  } catch (err) {
    logger.warn({ err, chatId }, 'Failed to send completion notice');
  }
}
