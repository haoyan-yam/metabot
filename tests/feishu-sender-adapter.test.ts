import { describe, it, expect, vi } from 'vitest';
import { FeishuSenderAdapter } from '../src/feishu/feishu-sender-adapter.js';
import type { CardState } from '../src/types.js';

/**
 * Feishu sender adapter — verifies that AskUserQuestion cards always go
 * through Card Schema 1.0, even when v2 is the global default.
 *
 * Why this matters:
 *   Feishu mobile App silently drops `tag: action` button blocks under
 *   Schema 2.0, so question buttons become invisible on iOS/Android. v1
 *   button rendering is verified working on mobile (PR #199). The bridge
 *   sends questions on a SEPARATE card (Feishu refuses to patch a v2 card
 *   with v1 content — ErrCode 200830 schemaV2 can not change schemaV1),
 *   so the v1 question card coexists alongside the v2 streaming card.
 *
 * Don't relax this: removing the v1 hardwire here AskUserQuestion stops
 * working on the Feishu mobile App, regardless of `CARD_SCHEMA_V2`.
 *
 * See memory: bug-feishu-v2-mobile-action-buttons.
 */
describe('FeishuSenderAdapter.sendQuestionCard / updateQuestionCard', () => {
  function makeAdapter() {
    const sendCard = vi.fn().mockResolvedValue('msg_123');
    const updateCard = vi.fn().mockResolvedValue(true);
    const fakeSender = {
      sendCard,
      updateCard,
      sendText: vi.fn(),
      sendImageFile: vi.fn(),
      sendLocalFile: vi.fn(),
      sendAudioFile: vi.fn(),
      downloadImage: vi.fn(),
      downloadFile: vi.fn(),
    } as any;
    return { adapter: new FeishuSenderAdapter(fakeSender), sendCard, updateCard, fakeSender };
  }

  const questionState: CardState = {
    status: 'waiting_for_input',
    userPrompt: 'Question',
    responseText: '',
    toolCalls: [],
    pendingQuestion: {
      toolUseId: 'toolu_test',
      questions: [{
        question: '今晚吃什么？',
        header: '今晚晚餐',
        options: [
          { label: '吃鸡', description: '炸鸡' },
          { label: '吃鸭', description: '烤鸭' },
        ],
        multiSelect: false,
      }],
    },
  };

  it('sendQuestionCard always builds a v1 card (no schema:"2.0")', async () => {
    const { adapter, sendCard } = makeAdapter();
    await adapter.sendQuestionCard('oc_test', questionState);
    expect(sendCard).toHaveBeenCalledOnce();
    const cardJson = sendCard.mock.calls[0][1] as string;
    expect(cardJson).not.toContain('"schema":"2.0"');
    expect(cardJson).toContain('吃鸡');
    expect(cardJson).toContain('吃鸭');
  });

  it('question cards render text-only — no `tag: action` button block, no `answer_question` callback', () => {
    // Buttons were removed because mobile Feishu has unfixable click
    // problems on both schemas (v2 doesn't render, v1 returns code 200340).
    // The typed-answer path works reliably; don't reintroduce buttons
    // without first verifying the underlying mobile-render / v1-callback
    // bugs are fixed Feishu-side.
    const { adapter, sendCard } = makeAdapter();
    void adapter.sendQuestionCard('oc_test', questionState);
    const cardJson = sendCard.mock.calls[0][1] as string;
    expect(cardJson).not.toContain('"tag":"action"');
    expect(cardJson).not.toContain('answer_question');
    // Numbered options + typed-reply prompt must still be present so users
    // know HOW to answer without buttons.
    expect(cardJson).toContain('**1.** 吃鸡');
    expect(cardJson).toContain('**2.** 吃鸭');
    expect(cardJson).toContain('请回复数字');
  });

  it('updateQuestionCard always builds a v1 card', async () => {
    const { adapter, updateCard } = makeAdapter();
    await adapter.updateQuestionCard('msg_test', questionState);
    expect(updateCard).toHaveBeenCalledOnce();
    const cardJson = updateCard.mock.calls[0][1] as string;
    expect(cardJson).not.toContain('"schema":"2.0"');
  });

  it('regular sendCard still uses v2 default (sanity)', async () => {
    const { adapter, sendCard } = makeAdapter();
    await adapter.sendCard('oc_test', {
      status: 'running',
      userPrompt: 'a thing',
      responseText: 'working',
      toolCalls: [],
    });
    const cardJson = sendCard.mock.calls[0][1] as string;
    expect(cardJson).toContain('"schema":"2.0"');
  });

  it('sendQuestionCard returns the underlying messageId from sender.sendCard', async () => {
    const { adapter, sendCard } = makeAdapter();
    sendCard.mockResolvedValueOnce('msg_specific');
    const id = await adapter.sendQuestionCard('oc_test', questionState);
    expect(id).toBe('msg_specific');
  });

  it('sendAudioFile forwards native audio sends to the Feishu sender', async () => {
    const { adapter, fakeSender } = makeAdapter();
    fakeSender.sendAudioFile.mockResolvedValueOnce(true);
    await expect(adapter.sendAudioFile('oc_test', '/tmp/reply.opus')).resolves.toBe(true);
    expect(fakeSender.sendAudioFile).toHaveBeenCalledWith('oc_test', '/tmp/reply.opus', 'reply.opus', undefined);
  });

  // [本地私改·patch I] 话题锚点透传：adapter 不解释 replyTo，只负责原样带给底层 sender。
  it('forwards replyTo through sendCard / sendQuestionCard / sendTextNotice (patch I)', async () => {
    const { adapter, sendCard } = makeAdapter();
    const replyTo = { messageId: 'om_trigger', inThread: true };
    await adapter.sendCard('oc_test', { status: 'running', userPrompt: 'p', responseText: '', toolCalls: [] }, replyTo);
    await adapter.sendQuestionCard('oc_test', questionState, replyTo);
    await adapter.sendTextNotice('oc_test', 'T', 'body', 'blue', replyTo);
    expect(sendCard).toHaveBeenCalledTimes(3);
    for (const call of sendCard.mock.calls) {
      expect(call[2]).toEqual(replyTo);
    }
  });

  it('forwards replyTo through sendImageFile / sendLocalFile / sendAudioFile (patch I)', async () => {
    const { adapter, fakeSender } = makeAdapter();
    const replyTo = { messageId: 'om_trigger', inThread: true };
    await adapter.sendImageFile('oc_test', '/tmp/a.png', replyTo);
    await adapter.sendLocalFile('oc_test', '/tmp/a.pdf', 'a.pdf', replyTo);
    await adapter.sendAudioFile('oc_test', '/tmp/a.opus', 'a.opus', replyTo);
    expect(fakeSender.sendImageFile).toHaveBeenCalledWith('oc_test', '/tmp/a.png', replyTo);
    expect(fakeSender.sendLocalFile).toHaveBeenCalledWith('oc_test', '/tmp/a.pdf', 'a.pdf', 'pdf', replyTo);
    expect(fakeSender.sendAudioFile).toHaveBeenCalledWith('oc_test', '/tmp/a.opus', 'a.opus', replyTo);
  });
});
