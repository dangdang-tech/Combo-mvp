import { describe, expect, it } from 'vitest';
import { appendTurnMessage, createSession, getMessages } from '../modules/session/repo.js';
import { createTurn, finishTurnCas } from '../modules/agent/turn-repo.js';
import { FakeDb } from './fakes.js';

async function setup() {
  const db = new FakeDb();
  const cap = db.seedCapability({ owner_user_id: 'me' });
  const session = await createSession(db, { capabilityId: cap.id, ownerUserId: 'me' });
  return { db, session };
}

describe('按轮消息仓库', () => {
  it('按轮内位置写入并派生连续对外序号', async () => {
    const { db, session } = await setup();
    await createTurn(db, { id: 'turn-1', sessionId: session.id });
    await appendTurnMessage(db, {
      sessionId: session.id,
      turnId: 'turn-1',
      idx: 0,
      role: 'user',
      content: [{ type: 'text', text: '问题' }],
    });
    await appendTurnMessage(db, {
      sessionId: session.id,
      turnId: 'turn-1',
      idx: 1,
      role: 'assistant',
      content: [{ type: 'text', text: '回答' }],
    });
    await finishTurnCas(db, { id: 'turn-1', status: 'completed' });
    const messages = await getMessages(db, session.id);
    expect(messages.map((message) => [message.seq, message.turnId, message.turnStatus])).toEqual([
      [1, 'turn-1', 'completed'],
      [2, 'turn-1', 'completed'],
    ]);
  });

  it('拒绝不符合角色内容协议的消息', async () => {
    const { db, session } = await setup();
    await createTurn(db, { id: 'turn-1', sessionId: session.id });
    await expect(
      appendTurnMessage(db, {
        sessionId: session.id,
        turnId: 'turn-1',
        idx: 0,
        role: 'user',
        content: [{ type: 'bogus' }],
      }),
    ).rejects.toThrow();
  });

  it('首条用户消息派生标题', async () => {
    const { db, session } = await setup();
    await createTurn(db, { id: 'turn-1', sessionId: session.id });
    await appendTurnMessage(db, {
      sessionId: session.id,
      turnId: 'turn-1',
      idx: 0,
      role: 'user',
      content: [{ type: 'text', text: '这是会话标题' }],
    });
    expect(db.sessions.get(session.id)?.title).toBe('这是会话标题');
  });
});
