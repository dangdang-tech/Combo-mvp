// 聊天流：按 seq 渲染落库消息（MessageView，content 为 pi 原生块数组——
// 文本块渲染 markdown，其余块类型显示占位），末尾追加流式打字机文本。
import { useEffect, useMemo, useRef } from 'react';
import type { MessageView } from '@cb/shared';
import { renderMarkdown } from '../lib/markdown.js';

const BLOCK_PLACEHOLDER: Record<string, string> = {
  toolCall: '正在使用工具…',
  toolResult: '工具结果',
  thinking: '思考过程',
  image: '图片',
};

interface ContentParts {
  text: string;
  placeholders: string[];
}

/** pi 原生块数组 → 可渲染文本 + 非文本块占位标签。 */
export function splitContentBlocks(content: unknown[]): ContentParts {
  const texts: string[] = [];
  const placeholders: string[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== 'object') continue;
    const block = raw as { type?: unknown; text?: unknown };
    if (block.type === 'text' && typeof block.text === 'string') {
      texts.push(block.text);
      continue;
    }
    if (typeof block.type === 'string') {
      placeholders.push(BLOCK_PLACEHOLDER[block.type] ?? `${block.type} 内容`);
    }
  }
  return { text: texts.join('\n\n'), placeholders };
}

export interface ChatThreadProps {
  messages: MessageView[];
  /** 流式中的助手正文（未落库前的实时打字机）；null = 无进行中文本。 */
  streamingText: string | null;
}

export function ChatThread({ messages, streamingText }: ChatThreadProps) {
  const endRef = useRef<HTMLDivElement>(null);
  const ordered = useMemo(() => [...messages].sort((a, b) => a.seq - b.seq), [messages]);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [ordered, streamingText]);

  return (
    <div className="rt-thread">
      {ordered.map((m) => (
        <MessageBubble key={m.id} message={m} />
      ))}
      {streamingText !== null && (
        <div className="rt-msg rt-msg--assistant">
          <div className="rt-msg__role">能力</div>
          <AssistantBody text={streamingText} streaming />
        </div>
      )}
      <div ref={endRef} />
    </div>
  );
}

function MessageBubble({ message }: { message: MessageView }) {
  const parts = splitContentBlocks(message.content);

  if (message.role === 'user') {
    return (
      <div className="rt-msg rt-msg--user">
        <div className="rt-msg__bubble">{parts.text}</div>
      </div>
    );
  }

  // tool 角色（工具结果整条消息）：一行淡占位，不进正文流。
  if (message.role === 'tool') {
    return <div className="rt-msg rt-msg--assistant rt-msg__placeholder">⚙ 工具结果</div>;
  }

  return (
    <div className="rt-msg rt-msg--assistant">
      <div className="rt-msg__role">能力</div>
      {message.status === 'failed' && !parts.text ? (
        <div className="rt-msg__body rt-error rt-error--inline">这轮回复失败了。</div>
      ) : (
        <AssistantBody text={parts.text} failed={message.status === 'failed'} />
      )}
      {parts.placeholders.map((label, i) => (
        <div key={i} className="rt-msg__placeholder">
          ⚙ {label}
        </div>
      ))}
    </div>
  );
}

function AssistantBody({
  text,
  streaming,
  failed,
}: {
  text: string;
  streaming?: boolean;
  failed?: boolean;
}) {
  const html = useMemo(() => (text ? renderMarkdown(text) : ''), [text]);
  return (
    <div className={`rt-msg__body rt-md${failed ? ' rt-msg__body--failed' : ''}`}>
      {text ? (
        <div dangerouslySetInnerHTML={{ __html: html }} />
      ) : streaming ? (
        <span className="rt-typing">
          <span></span>
          <span></span>
          <span></span>
        </span>
      ) : null}
      {streaming && text && <span className="rt-caret" />}
    </div>
  );
}
