import * as lark from '@larksuiteoapi/node-sdk';
import type { BotConfig } from '../config.js';
import type { Logger } from '../utils/logger.js';
import { MessageSender } from './message-sender.js';
import { fetchRoundContext, buildRoundPrompt, type RoundContext } from './round-context.js';

// Re-export from shared types so existing imports continue to work
export type { IncomingMessage } from '../types.js';
import type { IncomingMessage } from '../types.js';

export type MessageHandler = (msg: IncomingMessage) => void;

/** Payload delivered when a user clicks a button on an interactive card. */
export interface CardActionEvent {
  chatId: string;
  userId: string;
  messageId: string;
  /** Arbitrary value object set by the card builder on the clicked button. */
  value: Record<string, unknown>;
}

export type CardActionHandler = (event: CardActionEvent) => void;

// Dedup cache for already-processed message ids. Feishu retries webhook delivery
// (at-least-once) when the handler is slow to respond — e.g. a long-running task
// or media download — so without dedup the same message gets processed repeatedly.
const PROCESSED_MSG_TTL_MS = 10 * 60 * 1000; // 10 minutes
const processedMessages = new Map<string, number>(); // messageId -> ts

/** Returns true if this messageId was already seen (and records it otherwise). */
function isDuplicateMessage(messageId: string): boolean {
  const now = Date.now();
  // Opportunistic cleanup of stale entries
  if (processedMessages.size > 500) {
    for (const [id, ts] of processedMessages) {
      if (now - ts > PROCESSED_MSG_TTL_MS) processedMessages.delete(id);
    }
  }
  const seen = processedMessages.get(messageId);
  if (seen !== undefined && now - seen < PROCESSED_MSG_TTL_MS) return true;
  processedMessages.set(messageId, now);
  return false;
}

export function createEventDispatcher(
  config: BotConfig,
  logger: Logger,
  onMessage: MessageHandler,
  botOpenId?: string,
  messageSender?: MessageSender,
  onCardAction?: CardActionHandler,
): lark.EventDispatcher {
  const dispatcher = new lark.EventDispatcher({});

  // Register the card action trigger handler (fired when a user clicks a button
  // on an interactive card). The lark SDK types omit this event so we cast.
  if (onCardAction) {
    (dispatcher as unknown as {
      register: (handlers: Record<string, (data: unknown) => unknown>) => void;
    }).register({
      'card.action.trigger': (data: unknown) => {
        try {
          const d = data as {
            operator?: { open_id?: string };
            action?: { value?: unknown };
            context?: { open_message_id?: string; open_chat_id?: string };
          };
          const userId = d.operator?.open_id;
          const messageId = d.context?.open_message_id;
          const chatId = d.context?.open_chat_id;
          const raw = d.action?.value;
          if (!userId || !messageId || !chatId || !raw || typeof raw !== 'object') {
            logger.warn({ data }, 'Card action missing required fields');
            return { toast: { type: 'error', content: 'Invalid card action' } };
          }
          onCardAction({
            chatId,
            userId,
            messageId,
            value: raw as Record<string, unknown>,
          });
          return { toast: { type: 'success', content: '已收到' } };
        } catch (err) {
          logger.error({ err }, 'Error handling card action');
          return { toast: { type: 'error', content: 'Internal error' } };
        }
      },
    });
  }

  dispatcher.register({
    'im.message.receive_v1': createReceiveHandler(config, logger, onMessage, botOpenId, messageSender),
  });

  return dispatcher;
}

/**
 * [本地私改·patch S] 接收处理器抽成独立工厂并导出：单测可以直接驱动整条链路
 * （去重 / @ 门控 / 媒体与文本缓存 / 拼接），生产行为不变。
 */
export function createReceiveHandler(
  config: BotConfig,
  logger: Logger,
  onMessage: MessageHandler,
  botOpenId?: string,
  messageSender?: MessageSender,
): (data: any) => Promise<void> {
  return async (data: any) => {
      try {
        const event = data;
        const message = event.message;
        const sender = event.sender;

        const msgType = message.message_type;

        // Only handle text, post (rich text), image, and file messages
        if (msgType !== 'text' && msgType !== 'post' && msgType !== 'image' && msgType !== 'file') {
          logger.debug({ type: msgType }, 'Ignoring unsupported message type');
          return;
        }

        const userId = sender?.sender_id?.open_id;
        if (!userId) {
          logger.warn('Message missing sender open_id');
          return;
        }

        const chatId = message.chat_id;
        const chatType = message.chat_type;
        const messageId = message.message_id;
        // [本地私改·patch P] 引用回复带 parent_id（被引消息 id）；桥接据此把被引内容注入回合上下文。
        // root_id 仅入日志，供「话题内普通消息是否误带 parent_id」这类语义边界的事后诊断。
        let parentId: string | undefined = message.parent_id;
        if (parentId) {
          logger.info({ chatId, userId, messageId, parentId, rootId: message.root_id }, 'Message is a quote-reply');
        }

        // Dedup: Feishu retries delivery if we respond slowly (e.g. during a
        // long task). Mark this messageId as seen up-front so retries are dropped.
        if (messageId && isDuplicateMessage(messageId)) {
          logger.debug({ messageId, msgType }, 'Duplicate message delivery ignored');
          return;
        }

        // groupOnly mode: ignore private (1-on-1) chats entirely. Employees can
        // only interact with the bot inside project groups. Reply once with a
        // short hint so they know where to go, then drop the message.
        const groupOnlyAllowed = config.groupOnlyAllowUsers?.includes(userId);
        if (config.groupOnly && chatType !== 'group' && !groupOnlyAllowed) {
          logger.info({ chatId, userId, chatType }, 'groupOnly mode: ignoring private chat message');
          if (messageSender) {
            try {
              await messageSender.sendText(chatId, '你好,我只在项目群里工作,请到对应的项目群里 @我使用 🙂');
            } catch (err) {
              logger.warn({ err }, 'Failed to send groupOnly hint reply');
            }
          }
          return;
        }

        // [本地私改·patch S] 私聊也要 @bot 才回答，判定与群聊完全一致：
        //   - 飞书私聊里 @ 弹得出机器人，mentions 里带 bot open_id，直接复用群聊判定，不做文本兜底；
        //   - 未 @ 的消息静默丢弃（不回提示）；图片/文件先缓存，下次 @ 时自动带上；
        //   - 上游对「两人群视同私聊免 @」的豁免（isPrivateLikeGroup）一并去掉——两人群就是群；
        //   - groupNoMention 仍是唯一的免 @ 开关，对群聊和私聊同时生效。
        // 谁能私聊由补丁 A 的 groupOnly 白名单决定，与本补丁正交。
        const mentions = message.mentions;
        const botMentioned = botOpenId
          ? mentions?.some((m: any) => m.id?.open_id === botOpenId)
          : mentions && mentions.length > 0;
        if (!botMentioned) {
          if (config.groupNoMention && chatType === 'group') {
            // groupNoMention mode: respond to all group messages without @mention
            logger.debug({ chatId, chatType }, 'Group no-mention mode enabled, processing without @mention');
          } else {
            // [本地私改·patch S] 未 @ 的消息一律静默不处理（私聊群聊同）。它们不会丢：
            // 下次这个人 @ 时，桥接按飞书接口拉「本轮」历史把它们带上（见 round-context.ts），
            // 不再依赖内存缓存与 30 分钟寿命。
            logger.debug({ chatId, chatType, msgType }, 'Ignoring message without @mention');
            return;
          }
        }

        let text = '';
        let imageKey: string | undefined;
        let fileKey: string | undefined;
        let fileName: string | undefined;
        let postExtraImages: string[] = [];

        if (msgType === 'image') {
          // Image message: extract image_key
          try {
            const content = JSON.parse(message.content);
            imageKey = content.image_key;
          } catch {
            logger.warn('Failed to parse image message content');
            return;
          }
          if (!imageKey) {
            logger.warn('Image message missing image_key');
            return;
          }
          text = '请分析这张图片';
          logger.info({ userId, chatId, chatType, imageKey }, 'Received image message');
        } else if (msgType === 'file') {
          // File message: extract file_key and file_name
          try {
            const content = JSON.parse(message.content);
            fileKey = content.file_key;
            fileName = content.file_name;
          } catch {
            logger.warn('Failed to parse file message content');
            return;
          }
          if (!fileKey || !fileName) {
            logger.warn('File message missing file_key or file_name');
            return;
          }
          text = '请分析这个文件';
          logger.info({ userId, chatId, chatType, fileKey, fileName }, 'Received file message');
        } else {
          // Text / rich text (post): extract, clean, split post images
          const parsed = extractPromptText(message, msgType, logger);
          if (!parsed) return;
          text = parsed.text;
          if (parsed.postImages.length > 0) {
            imageKey = parsed.postImages[0];
            postExtraImages = parsed.postImages.slice(1);
          }
        }

        if (msgType === 'text' || msgType === 'post') {
          if (!text && !imageKey) {
            logger.debug('Empty message after stripping mentions');
            return;
          }

          // If text is empty but we have an image (e.g. @bot + image in group chat), set default prompt
          if (!text && imageKey) {
            text = '请分析这张图片';
          }

          logger.info({ userId, chatId, chatType, text: text.slice(0, 100), imageKey }, 'Received message');
        }

        // Collect extra media: post images (2nd+) and cached group media
        let extraMedia: IncomingMessage['extraMedia'];
        if (postExtraImages.length > 0) {
          extraMedia = postExtraImages.map(key => ({
            messageId,
            imageKey: key,
          }));
          logger.info({ chatId, postExtraImageCount: postExtraImages.length }, 'Attached extra images from post');
        }
        // [本地私改·patch S] @ 触发：按飞书接口拉这个人「本轮」（上一条 @ 之后）的消息，
        //   文本按序拼在本条前面、媒体作附件、引用回复沿用最早那条的被引 id。
        //   私聊群聊同一机制；groupNoMention 模式下非 @ 消息不拉（没有积压）。
        //   拉取失败降级为提示词里一句说明，绝不阻塞回合。
        if (botMentioned && messageSender) {
          const triggerTimeMs = Number(message.create_time) || Date.now();
          const round: RoundContext = await fetchRoundContext(
            (c, st, et, pt) => messageSender.listMessages(c, st, et, pt),
            { chatId, triggerMessageId: messageId, triggerTimeMs, senderId: userId, botOpenId },
            { extractPostText: extractTextFromPost, extractPostImages: extractImagesFromPost },
          );
          if (round.error) {
            logger.warn({ chatId, chatType, userId, error: round.error, scanned: round.scanned }, 'Round context fetch failed; continuing without it');
          }
          if (round.media.length > 0) {
            extraMedia = extraMedia ? [...extraMedia, ...round.media] : round.media;
          }
          if (!parentId) {
            parentId = round.texts.find(m => m.parentId)?.parentId;
          }
          text = buildRoundPrompt(round, text);
          if (round.texts.length > 0 || round.media.length > 0 || round.truncated) {
            logger.info(
              { chatId, chatType, userId, textCount: round.texts.length, mediaCount: round.media.length, truncated: round.truncated, scanned: round.scanned, parentId },
              'Attached round context to @mention message',
            );
          }
        }

        onMessage({ messageId, chatId, chatType, userId, parentId, text, imageKey, fileKey, fileName, extraMedia });
      } catch (err) {
        logger.error({ err }, 'Error handling message event');
      }
    };
}

/**
 * [本地私改·patch S] 文本/富文本消息的正文抽取 + 通用清理，收口成函数供主路径与
 * 「未 @ 先缓存」两处共用。返回 undefined 表示内容解析失败。
 */
function extractPromptText(
  message: any, msgType: 'text' | 'post', logger: Logger,
): { text: string; postImages: string[] } | undefined {
  let text: string;
  let postImages: string[] = [];
  try {
    const content = JSON.parse(message.content);
    if (msgType === 'post') {
      logger.debug({ postContent: JSON.stringify(content).slice(0, 500) }, 'Raw post content');
      text = extractTextFromPost(content);
      postImages = extractImagesFromPost(content);
      logger.debug({ extractedText: text.slice(0, 200), postImageCount: postImages.length }, 'Extracted post content');
    } else {
      text = content.text || '';
    }
  } catch {
    logger.warn({ content: message.content }, 'Failed to parse message content');
    return undefined;
  }
  // Strip @mention tags (format: @_user_xxx or similar)
  text = text.replace(/@_\w+\s*/g, '').trim();
  // Strip Feishu auto-generated markdown links: [text](url) → text
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  return { text, postImages };
}

/**
 * Extract all image_keys from a Feishu post (rich text) message.
 * Looks for { tag: "img", image_key: "..." } elements in the post content.
 */
// [本地私改·patch S] 导出供 round-context 复用富文本图片解析；生产逻辑不变。
export function extractImagesFromPost(content: Record<string, unknown>): string[] {
  const bodies: Array<Record<string, unknown>> = [];

  if (Array.isArray(content.content)) {
    bodies.push(content);
  } else {
    for (const locale of Object.values(content)) {
      if (locale && typeof locale === 'object' && !Array.isArray(locale)) {
        const loc = locale as Record<string, unknown>;
        if (Array.isArray(loc.content)) {
          bodies.push(loc);
        }
      }
    }
  }

  const keys: string[] = [];
  for (const body of bodies) {
    const paragraphs = body.content as unknown[][];
    for (const paragraph of paragraphs) {
      if (!Array.isArray(paragraph)) continue;
      for (const element of paragraph) {
        if (!element || typeof element !== 'object') continue;
        const el = element as Record<string, unknown>;
        if (el.tag === 'img' && typeof el.image_key === 'string') {
          keys.push(el.image_key);
        }
      }
    }
  }

  return keys;
}

/**
 * Extract plain text from Feishu post (rich text) message content.
 * Handles two formats:
 *   With locale wrapper: { "zh_cn": { "title": "...", "content": [[{tag, text}, ...], ...] } }
 *   Without locale wrapper: { "title": "...", "content": [[{tag, text}, ...], ...] }
 */
// [本地私改·patch P] 导出仅为 quote-context 复用富文本解析；生产逻辑不变。
export function extractTextFromPost(content: Record<string, unknown>): string {
  // Try to find the post body — either the content itself or nested under a locale key
  const bodies: Array<Record<string, unknown>> = [];

  if (Array.isArray(content.content)) {
    // Direct format (no locale wrapper)
    bodies.push(content);
  } else {
    // Locale-wrapped format: values are { title, content }
    for (const locale of Object.values(content)) {
      if (locale && typeof locale === 'object' && !Array.isArray(locale)) {
        const loc = locale as Record<string, unknown>;
        if (Array.isArray(loc.content)) {
          bodies.push(loc);
        }
      }
    }
  }

  for (const body of bodies) {
    const parts: string[] = [];

    if (body.title && typeof body.title === 'string') {
      parts.push(body.title);
    }

    const paragraphs = body.content as unknown[][];
    for (const paragraph of paragraphs) {
      if (!Array.isArray(paragraph)) continue;
      const line: string[] = [];
      for (const element of paragraph) {
        if (!element || typeof element !== 'object') continue;
        const el = element as Record<string, unknown>;
        if (el.tag === 'a' && typeof el.text === 'string') {
          // [本地私改·patch S] 富文本链接原先只取显示文字、丢掉 href——粘贴的飞书文档链接
          // 到 bot 手里只剩标题，无从打开。显示文字本身就是 URL 时不重复。
          const href = typeof el.href === 'string' ? el.href.trim() : '';
          const label = el.text.trim();
          if (href && href !== label) line.push(`${label} (${href})`);
          else line.push(el.text);
        } else if (el.tag === 'text' && typeof el.text === 'string') {
          line.push(el.text);
        }
      }
      if (line.length > 0) {
        parts.push(line.join(''));
      }
    }

    if (parts.length > 0) {
      return parts.join('\n');
    }
  }

  return '';
}

