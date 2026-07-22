import type { CardState } from '../types.js';

/**
 * [本地私改·patch I] Reply anchor for thread/topic routing.
 *
 * When present, the message is created as a REPLY to `messageId` instead of a
 * plain chat message. On Feishu, replying to a message that lives inside a
 * 话题 (topic/thread) lands the reply inside that thread — this is the only
 * way to route bot output into the thread the user @-ed from (message.create
 * only targets the main chat). `inThread: true` additionally sets Feishu's
 * `reply_in_thread`, which is a no-op when the target is already threaded.
 * Platforms without a reply/thread concept ignore the whole argument.
 */
export interface ReplyTarget {
  /** The message to anchor the reply to (normally the user's triggering message). */
  messageId: string;
  /** Reply as a thread/topic message (Feishu reply_in_thread). */
  inThread?: boolean;
}

/**
 * Platform-agnostic message sender interface.
 * Implemented by each IM platform (Feishu, Telegram, etc.).
 */
export interface IMessageSender {
  /**
   * Send a new streaming card/message for a CardState. Returns messageId for subsequent updates.
   * `replyTo` ([本地私改·patch I]): optional thread anchor, see ReplyTarget.
   */
  sendCard(chatId: string, state: CardState, replyTo?: ReplyTarget): Promise<string | undefined>;

  /** Update an existing streaming card/message with new CardState. Returns false on failure. */
  updateCard(messageId: string, state: CardState): Promise<boolean>;

  /**
   * Send a dedicated interactive question card for an AskUserQuestion call.
   * The state's `pendingQuestion` field carries the options/buttons.
   *
   * Why a separate method (not just sendCard with pendingQuestion):
   *   - On Feishu, Card Schema 2.0 has a mobile-App render bug — `tag: action`
   *     button blocks are silently dropped on iOS/Android, so AskUserQuestion
   *     options become invisible. The Feishu adapter forces Schema 1.0 for
   *     question cards (v1 buttons are verified working on mobile).
   *   - On Telegram (and future platforms), this is the natural hook for
   *     inline-keyboard rendering — also conceptually distinct from a
   *     streaming "thinking" card.
   *
   * Optional: platforms without a special path may omit; bridge falls back
   * to sendCard / updateCard.
   *
   * See memory: bug-feishu-v2-mobile-action-buttons.
   */
  sendQuestionCard?(chatId: string, state: CardState, replyTo?: ReplyTarget): Promise<string | undefined>;

  /** Update an existing question card with new CardState (e.g., mark answered). */
  updateQuestionCard?(messageId: string, state: CardState): Promise<boolean>;

  /** Send a simple notice message (for command responses: /help, /reset, /stop, etc.). */
  sendTextNotice(chatId: string, title: string, content: string, color?: string, replyTo?: ReplyTarget): Promise<void>;

  /**
   * Send a plain text message.
   *
   * `replyToMessageId` (optional, [本地私改]): when set, the text is sent as a
   * quote-reply to that message so the person who triggered it gets a reply
   * notification. Used by the task-completion notice so the ping lands when the
   * answer is ready (not when the bot starts thinking). Platforms without a
   * reply concept ignore the arg and send normally.
   */
  sendText(chatId: string, text: string, replyToMessageId?: string): Promise<void>;

  /** Send a local image file to the chat. */
  sendImageFile(chatId: string, filePath: string, replyTo?: ReplyTarget): Promise<boolean>;

  /** Send a local file to the chat. */
  sendLocalFile(chatId: string, filePath: string, fileName: string, replyTo?: ReplyTarget): Promise<boolean>;

  /** Send a local audio file as a native voice/audio message, when supported. */
  sendAudioFile?(chatId: string, filePath: string, fileName?: string, replyTo?: ReplyTarget): Promise<boolean>;

  /** Download a user-sent image to a local path. */
  downloadImage(messageId: string, imageKey: string, savePath: string): Promise<boolean>;

  /** Download a user-sent file to a local path. */
  downloadFile(messageId: string, fileKey: string, savePath: string): Promise<boolean>;

  /** If true, the bridge will not send a separate "Task completed" text after the card update. */
  skipCompletionNotice?: boolean;
}
