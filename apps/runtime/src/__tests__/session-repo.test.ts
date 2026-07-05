// appendMessage：seq 分配、content schema 严格校验（坏块拒写）、标题派生、事务收口。
import { describe, expect, it } from 'vitest';
import { appendMessage, createSession, getMessages } from '../modules/session/repo.js';
import { InvalidMessageContentError } from '../modules/session/message-content.js';
import { FakeDb } from './fakes.js';

const ME = 'user-me';

async function seedSession(db: FakeDb): Promise<string> {
  const cap = db.seedCapability({ owner_user_id: ME });
  const session = await createSession(db, { capabilityId: cap.id, ownerUserId: ME });
  return session.id;
}

describe('appendMessage seq 分配', () => {
  it('按 max(seq)+1 连续分配（user → assistant → tool）', async () => {
    const db = new FakeDb();
    const sessionId = await seedSession(db);

    const m1 = await appendMessage(db, {
      sessionId,
      role: 'user',
      content: [{ type: 'text', text: '帮我写周报' }],
    });
    const m2 = await appendMessage(db, {
      sessionId,
      role: 'assistant',
      content: [{ type: 'text', text: '好的' }],
    });
    const m3 = await appendMessage(db, {
      sessionId,
      role: 'tool',
      content: [
        {
          type: 'toolResult',
          toolCallId: 'tc-1',
          toolName: 'upsert_artifact',
          content: [{ type: 'text', text: 'ok' }],
          isError: false,
        },
      ],
    });
    expect([m1.seq, m2.seq, m3.seq]).toEqual([1, 2, 3]);

    const all = await getMessages(db, sessionId);
    expect(all.map((m) => m.seq)).toEqual([1, 2, 3]);
    // 事务收口：每次 append 一对 BEGIN/COMMIT，无 ROLLBACK。
    expect(db.txLog.filter((t) => t === 'ROLLBACK')).toHaveLength(0);
    expect(db.txLog.filter((t) => t === 'BEGIN')).toHaveLength(3);
  });

  it('不同会话 seq 互不影响', async () => {
    const db = new FakeDb();
    const a = await seedSession(db);
    const b = await seedSession(db);
    await appendMessage(db, { sessionId: a, role: 'user', content: [{ type: 'text', text: 'x' }] });
    const mb = await appendMessage(db, {
      sessionId: b,
      role: 'user',
      content: [{ type: 'text', text: 'y' }],
    });
    expect(mb.seq).toBe(1);
  });

  it('首条用户消息自动派生会话标题（前 30 字）', async () => {
    const db = new FakeDb();
    const sessionId = await seedSession(db);
    await appendMessage(db, {
      sessionId,
      role: 'user',
      content: [{ type: 'text', text: '把这份速记整理成会议纪要，重点标出待办' }],
    });
    expect(db.sessions.get(sessionId)?.title).toBe('把这份速记整理成会议纪要，重点标出待办');
  });
});

describe('appendMessage content schema 校验', () => {
  it('坏块（未知 type）拒写', async () => {
    const db = new FakeDb();
    const sessionId = await seedSession(db);
    await expect(
      appendMessage(db, { sessionId, role: 'user', content: [{ type: 'bogus' }] }),
    ).rejects.toBeInstanceOf(InvalidMessageContentError);
    expect(db.messages).toHaveLength(0); // 校验在事务前，绝不落半条
  });

  it('空 content 拒写', async () => {
    const db = new FakeDb();
    const sessionId = await seedSession(db);
    await expect(
      appendMessage(db, { sessionId, role: 'user', content: [] }),
    ).rejects.toBeInstanceOf(InvalidMessageContentError);
  });

  it('角色与块类型不匹配拒写：user 不接受 toolCall 块', async () => {
    const db = new FakeDb();
    const sessionId = await seedSession(db);
    await expect(
      appendMessage(db, {
        sessionId,
        role: 'user',
        content: [{ type: 'toolCall', id: 'tc-1', name: 't', arguments: {} }],
      }),
    ).rejects.toBeInstanceOf(InvalidMessageContentError);
  });

  it('tool 行的 toolResult 块缺 toolCallId 拒写（配对信息不可丢）', async () => {
    const db = new FakeDb();
    const sessionId = await seedSession(db);
    await expect(
      appendMessage(db, {
        sessionId,
        role: 'tool',
        content: [
          {
            type: 'toolResult',
            toolName: 't',
            content: [{ type: 'text', text: 'ok' }],
            isError: false,
          },
        ],
      }),
    ).rejects.toBeInstanceOf(InvalidMessageContentError);
  });

  it('assistant 接受 text/thinking/toolCall 混合块', async () => {
    const db = new FakeDb();
    const sessionId = await seedSession(db);
    const m = await appendMessage(db, {
      sessionId,
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '先列结构' },
        { type: 'text', text: '我来整理' },
        { type: 'toolCall', id: 'tc-1', name: 'upsert_artifact', arguments: { title: 'x' } },
      ],
    });
    expect(m.content).toHaveLength(3);
  });
});
