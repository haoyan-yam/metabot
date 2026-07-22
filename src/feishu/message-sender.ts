import * as fs from 'node:fs';
import type * as lark from '@larksuiteoapi/node-sdk';
import type { Logger } from '../utils/logger.js';
import type { ReplyTarget } from '../bridge/message-sender.interface.js';

/**
 * [本地私改·patch G] 出站脱敏：飞书对话里不透露本机真实路径与密钥。
 *
 * 背景：bot 跑在本机、有完整工具权限，解释自己做了什么时会很自然地把本机绝对
 * 路径说出口——实测曾有 bot 在**客户群**里回过「成品归档到 ~/projects/<client>/
 * outputs/，而桥接只监听系统指定的 outputs 目录」。光靠提示词约束依赖模型自觉、
 * 不可靠，故在**出站收口处**强制过滤：MessageSender 的三个「带文字」出口
 * （sendCard / updateCard / sendText）覆盖全部卡片与文本，模型绕不过去。
 * 对所有会话（群聊 + 私聊）一律生效——私聊同样可能被截图/转发。
 *
 * ⚠️ 刻意**不做**「长 token 通杀」之类的宽泛规则：那会误伤飞书自身的
 * open_id(`ou_…`)、file_key(`file_v3_…`)、image_key(`img_v3_…`)、message_id(`om_…`)，
 * 直接打断 @ 提醒(patch F)与图片/文件发送。只匹配明确的路径与密钥形态。
 * 上传/下载用的 filePath 走 sendImageFile/sendLocalFile/uploadFile，**不经过本函数**
 * （否则真实路径被替换会导致读不到文件）。
 *
 * 替换串只含中文书名号，不含引号/反斜杠 → 不会破坏卡片的 JSON 结构。
 */
// 路径：前面加负向后顾，避免吃掉 URL 里的 /tmp/ 之类（如 https://host/tmp/x）
const LOCAL_PATH_RE =
  /(?<![A-Za-z0-9])(?:\/Users\/|~\/|\/var\/folders\/|\/private\/(?:tmp|var)\/|\/tmp\/)[^\s"'\\,;)\]}]*/g;

// 密钥：仅匹配明确形态；KEY/TOKEN/SECRET 等键名限大写，避免误伤 file_key 等小写字段
const SECRET_RULES: Array<[RegExp, string]> = [
  [/\bsk-[A-Za-z0-9_-]{16,}/g, '〈已隐藏〉'],   // OpenAI 类
  [/\bAKLT[A-Za-z0-9_-]{10,}/g, '〈已隐藏〉'],  // 火山 AK
  [/\bmt_[A-Za-z0-9]{16,}/g, '〈已隐藏〉'],     // metabot-core token
  [/\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)[A-Z0-9_]*)\s*[=:]\s*['"]?[^\s"'\\,;)\]}]+/g, '$1=〈已隐藏〉'],
];

/** [本地私改·patch G] 见上。对出站文字做脱敏；文件名（有扩展名）保留，只抹掉目录结构。 */
export function redactSensitive(text: string): string {
  let out = text;
  for (const [re, to] of SECRET_RULES) out = out.replace(re, to);
  out = out.replace(LOCAL_PATH_RE, (m) => {
    const base = m.slice(m.lastIndexOf('/') + 1);
    // 只在末段像文件名（有扩展名）时保留它；否则整段抹掉，避免 /Users/<用户名> 漏出账号名
    return /\.[A-Za-z0-9]{1,8}$/.test(base) ? `〈本地路径〉/${base}` : '〈本地路径〉';
  });
  return out;
}

// [本地私改·patch K] 飞书上传偶发 502 / 请求 hang 会静默丢文件（uploadFile/uploadImage 原本
// 只发一次、一 catch 就返回 undefined、不重试）——2026-07-07 与 2026-07-22 两个客户群
// PPT 各因 502 静默丢失。这里给上传加「单次超时 + 对 transient 错(5xx/超时/网络)指数退避重试」。
// 卡片发送早有重试(sendFinalCardWithRetry)，文件上传一直没有；本补丁补齐这个不对称。
const UPLOAD_MAX_ATTEMPTS = 3;
const UPLOAD_BASE_DELAY_MS = 1000;          // 退避基数：1s → 2s
const UPLOAD_ATTEMPT_TIMEOUT_MS = 120_000;  // 单次尝试上限 2 分钟，避免像那次 hang 8 分钟

function isTransientUploadError(err: unknown): boolean {
  const e = err as { code?: string; status?: number; message?: string; response?: { status?: number } };
  const status = e?.response?.status ?? e?.status;
  if (typeof status === 'number' && status >= 500 && status < 600) return true;
  if (['ETIMEDOUT', 'ECONNRESET', 'ECONNABORTED', 'EPIPE', 'ENETUNREACH', 'EAI_AGAIN'].includes(String(e?.code || ''))) return true;
  return /\b(50[0-9]|timeout|timed out|socket hang up|network)\b/i.test(String(e?.message || ''));
}

async function withUploadTimeout<T>(p: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${UPLOAD_ATTEMPT_TIMEOUT_MS}ms`)), UPLOAD_ATTEMPT_TIMEOUT_MS);
  });
  try { return await Promise.race([p, timeout]); }
  finally { if (timer) clearTimeout(timer); }
}

export class MessageSender {
  constructor(
    private client: lark.Client,
    private logger: Logger,
  ) {}

  /**
   * [本地私改·patch I] 以回复形式发消息，用于把输出锚定进话题（thread）。
   * 回复话题内的消息即落话题；inThread 时显式带 reply_in_thread。
   * 失败（锚点消息被撤回/过期等）返回 undefined，由调用方回退普通 create 保底。
   */
  private async replyMessage(replyTo: ReplyTarget, content: string, msgType: string): Promise<string | undefined> {
    try {
      const resp = await this.client.im.v1.message.reply({
        path: { message_id: replyTo.messageId },
        data: {
          content,
          msg_type: msgType,
          ...(replyTo.inThread ? { reply_in_thread: true } : {}),
        },
      });
      const messageId = resp?.data?.message_id;
      if (!messageId) {
        this.logger.warn({ resp, replyTo, msgType }, 'Reply send returned no message_id, falling back to create');
      }
      return messageId;
    } catch (err) {
      this.logger.warn({ err, replyTo, msgType }, 'Reply send failed, falling back to create');
      return undefined;
    }
  }

  async sendCard(chatId: string, cardContent: string, replyTo?: ReplyTarget): Promise<string | undefined> {
    const safeContent = redactSensitive(cardContent); // [本地私改·patch G] 出站脱敏
    // [本地私改·patch I] 话题内触发的任务：卡片以回复形式创建，落回话题；失败回退主聊天
    if (replyTo) {
      const messageId = await this.replyMessage(replyTo, safeContent, 'interactive');
      if (messageId) return messageId;
    }
    try {
      const resp = await this.client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          content: safeContent,
          msg_type: 'interactive',
        },
      });

      const messageId = resp?.data?.message_id;
      if (!messageId) {
        this.logger.error({ resp }, 'Failed to get message_id from send response');
      }
      return messageId;
    } catch (err) {
      this.logger.error({ err, chatId }, 'Failed to send card');
      return undefined;
    }
  }

  async updateCard(messageId: string, cardContent: string): Promise<boolean> {
    const safeContent = redactSensitive(cardContent); // [本地私改·patch G] 出站脱敏
    try {
      await this.client.im.v1.message.patch({
        path: { message_id: messageId },
        data: { content: safeContent },
      });
      return true;
    } catch (err) {
      this.logger.error({ err, messageId }, 'Failed to update card');
      return false;
    }
  }

  async downloadImage(messageId: string, imageKey: string, savePath: string): Promise<boolean> {
    try {
      const resp = await this.client.im.v1.messageResource.get({
        path: { message_id: messageId, file_key: imageKey },
        params: { type: 'image' },
      });

      if (resp) {
        await (resp as any).writeFile(savePath);
        this.logger.info({ messageId, imageKey, savePath }, 'Image downloaded');
        return true;
      }
      this.logger.error({ messageId, imageKey }, 'Empty response when downloading image');
      return false;
    } catch (err) {
      this.logger.error({ err, messageId, imageKey }, 'Failed to download image');
      return false;
    }
  }

  async downloadFile(messageId: string, fileKey: string, savePath: string): Promise<boolean> {
    try {
      const resp = await this.client.im.v1.messageResource.get({
        path: { message_id: messageId, file_key: fileKey },
        params: { type: 'file' },
      });

      if (resp) {
        await (resp as any).writeFile(savePath);
        this.logger.info({ messageId, fileKey, savePath }, 'File downloaded');
        return true;
      }
      this.logger.error({ messageId, fileKey }, 'Empty response when downloading file');
      return false;
    } catch (err) {
      this.logger.error({ err, messageId, fileKey }, 'Failed to download file');
      return false;
    }
  }

  async uploadImage(filePath: string): Promise<string | undefined> {
    // [本地私改·patch K] 同 uploadFile：单次超时 + transient 退避重试。
    for (let attempt = 1; attempt <= UPLOAD_MAX_ATTEMPTS; attempt++) {
      try {
        const resp = await withUploadTimeout(this.client.im.v1.image.create({
          data: {
            image_type: 'message',
            image: fs.createReadStream(filePath),
          },
        }), 'image upload');
        const imageKey = resp?.image_key;
        if (imageKey) {
          this.logger.info({ filePath, imageKey, attempt }, 'Image uploaded to Feishu');
          return imageKey;
        }
        this.logger.error({ filePath, attempt }, 'Image upload returned no image_key');
        return undefined;
      } catch (err) {
        if (isTransientUploadError(err) && attempt < UPLOAD_MAX_ATTEMPTS) {
          const delay = UPLOAD_BASE_DELAY_MS * 2 ** (attempt - 1);
          this.logger.warn({ err, filePath, attempt, delay }, 'Image upload failed (transient), retrying');
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        this.logger.error({ err, filePath, attempts: attempt }, 'Failed to upload image');
        return undefined;
      }
    }
    return undefined;
  }

  async sendImage(chatId: string, imageKey: string, replyTo?: ReplyTarget): Promise<boolean> {
    const content = JSON.stringify({ image_key: imageKey });
    if (replyTo && await this.replyMessage(replyTo, content, 'image')) return true; // [本地私改·patch I]
    try {
      await this.client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          content,
          msg_type: 'image',
        },
      });
      return true;
    } catch (err) {
      this.logger.error({ err, chatId, imageKey }, 'Failed to send image');
      return false;
    }
  }

  async sendImageFile(chatId: string, filePath: string, replyTo?: ReplyTarget): Promise<boolean> {
    const imageKey = await this.uploadImage(filePath);
    if (!imageKey) return false;
    return this.sendImage(chatId, imageKey, replyTo);
  }

  async uploadFile(filePath: string, fileName: string, fileType: string): Promise<string | undefined> {
    // [本地私改·patch K] 单次超时 + transient 错(5xx/超时/网络)指数退避重试；每次都新建 read stream。
    for (let attempt = 1; attempt <= UPLOAD_MAX_ATTEMPTS; attempt++) {
      try {
        const resp = await withUploadTimeout(this.client.im.v1.file.create({
          data: {
            file_type: fileType as any,
            file_name: fileName,
            file: fs.createReadStream(filePath),
          },
        }), 'file upload');
        const fileKey = resp?.file_key;
        if (fileKey) {
          this.logger.info({ filePath, fileKey, fileType, attempt }, 'File uploaded to Feishu');
          return fileKey;
        }
        this.logger.error({ filePath, fileType, attempt }, 'File upload returned no file_key');
        return undefined; // 非异常但没拿到 key：不重试
      } catch (err) {
        if (isTransientUploadError(err) && attempt < UPLOAD_MAX_ATTEMPTS) {
          const delay = UPLOAD_BASE_DELAY_MS * 2 ** (attempt - 1);
          this.logger.warn({ err, filePath, fileType, attempt, delay }, 'File upload failed (transient), retrying');
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        this.logger.error({ err, filePath, fileType, attempts: attempt }, 'Failed to upload file');
        return undefined;
      }
    }
    return undefined;
  }

  async sendFile(chatId: string, fileKey: string, replyTo?: ReplyTarget): Promise<boolean> {
    const content = JSON.stringify({ file_key: fileKey });
    if (replyTo && await this.replyMessage(replyTo, content, 'file')) return true; // [本地私改·patch I]
    try {
      await this.client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          content,
          msg_type: 'file',
        },
      });
      return true;
    } catch (err) {
      this.logger.error({ err, chatId, fileKey }, 'Failed to send file');
      return false;
    }
  }

  async sendLocalFile(chatId: string, filePath: string, fileName: string, fileType: string, replyTo?: ReplyTarget): Promise<boolean> {
    const fileKey = await this.uploadFile(filePath, fileName, fileType);
    if (!fileKey) return false;
    return this.sendFile(chatId, fileKey, replyTo);
  }

  async sendAudio(chatId: string, fileKey: string, replyTo?: ReplyTarget): Promise<boolean> {
    const content = JSON.stringify({ file_key: fileKey });
    if (replyTo && await this.replyMessage(replyTo, content, 'audio')) return true; // [本地私改·patch I]
    try {
      await this.client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          content,
          msg_type: 'audio',
        },
      });
      return true;
    } catch (err) {
      this.logger.error({ err, chatId, fileKey }, 'Failed to send audio');
      return false;
    }
  }

  async sendAudioFile(chatId: string, filePath: string, fileName: string, replyTo?: ReplyTarget): Promise<boolean> {
    const fileKey = await this.uploadFile(filePath, fileName, 'opus');
    if (!fileKey) return false;
    return this.sendAudio(chatId, fileKey, replyTo);
  }

  async getChatMemberCount(chatId: string): Promise<number | undefined> {
    try {
      const resp: any = await this.client.im.v1.chat.get({
        path: { chat_id: chatId },
      });
      const userCount = parseInt(resp?.data?.user_count, 10) || 0;
      const botCount = parseInt(resp?.data?.bot_count, 10) || 0;
      return userCount + botCount;
    } catch (err) {
      this.logger.error({ err, chatId }, 'Failed to get chat member count');
      return undefined;
    }
  }

  async sendText(chatId: string, text: string, replyToMessageId?: string): Promise<void> {
    const safeText = redactSensitive(text); // [本地私改·patch G] 出站脱敏
    // [本地私改] 传了 replyToMessageId 就用 im.message.reply 引用回复(触发提问人的飞书通知);
    // reply 失败(原消息被撤回/过期/权限等)则回退普通 create,保证通知即使引用失败也照发。
    if (replyToMessageId) {
      try {
        await this.client.im.v1.message.reply({
          path: { message_id: replyToMessageId },
          data: { content: JSON.stringify({ text: safeText }), msg_type: 'text' },
        });
        return;
      } catch (err) {
        this.logger.warn({ err, replyToMessageId }, 'Failed to reply-quote text, falling back to plain send');
      }
    }
    try {
      await this.client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          content: JSON.stringify({ text: safeText }),
          msg_type: 'text',
        },
      });
    } catch (err) {
      this.logger.error({ err, chatId }, 'Failed to send text');
    }
  }
}
