// STEP① 配对命令框（F-10，开工总纲 §5.1）——铸码后展示一行命令 + 轮询配对/上传状态。
//
// 状态（对齐 PairPhase，导入-25）：
//   - waiting：已铸码，等终端跑命令。显示可复制命令 + 「等待你在终端运行…」会话状态。
//   - uploading：助手已开始直传。显示「正在上传你的对话历史…」+ 已传分片量化（uploadedParts/totalParts）。
//   - job_created：已建 Job（上层据此转 SSE，不在本件渲染）。
//   - expired：配对码过期（态非错误，导入-25）。给「重新生成」引导。
// 永不裸转圈：每个阶段都有人话会话状态 + 进度量化，绝不空转。
import type { ReactElement } from 'react';
import type { PairResult, PairStatusView } from '@cb/shared';

export interface CommandBoxProps {
  /** 铸码结果（command 一行命令 + curlOneLiner 验收口径串 + expiresAt）。 */
  pair: PairResult;
  /** 轮询到的最新状态（未轮询到时按 waiting 处理）。 */
  status: PairStatusView | undefined;
  /** 点「复制命令」（上层接剪贴板 + toast；本件只回调，不直接碰 navigator 以便测试）。 */
  onCopy: () => void;
  /** 是否已复制（按钮显「已复制」短反馈）。 */
  copied?: boolean;
  /** 配对码过期 → 点「重新生成」重新铸码。 */
  onRegenerate: () => void;
}

/** 把 phase 翻成人话会话状态行（导入-25 逐行会话状态）。 */
function phasePhrase(status: PairStatusView | undefined): string {
  const phase = status?.phase ?? 'waiting';
  switch (phase) {
    case 'uploading': {
      const done = status?.uploadedParts;
      const total = status?.totalParts;
      if (typeof done === 'number' && typeof total === 'number' && total > 0) {
        return `正在上传你的对话历史…（已传 ${done} / ${total} 片）`;
      }
      return '正在上传你的对话历史…';
    }
    case 'job_created':
      return '上传完成，正在进入处理…';
    case 'expired':
      return '这条配对码已经过期了。';
    case 'waiting':
    default:
      return '等待你在终端运行上面的命令…';
  }
}

export function CommandBox({
  pair,
  status,
  onCopy,
  copied = false,
  onRegenerate,
}: CommandBoxProps): ReactElement {
  const phase = status?.phase ?? 'waiting';
  const expired = phase === 'expired';

  return (
    <section className="cb-cmdbox" aria-label="连接本机并运行命令">
      <h2 className="cb-cmdbox__title">在你电脑的终端里运行这行命令</h2>
      <p className="cb-cmdbox__lead">
        助手会扫描本机的对话历史并安全上传；完成后这一页会自动接上，你不用回到终端。
      </p>

      {/* 一行可复制命令（带专属配对码）。展示与复制同为真命令 pair.command（不再用占位 curlOneLiner）。 */}
      <div className="cb-cmdbox__command">
        <code className="cb-cmdbox__command-text">{pair.command}</code>
        <button
          type="button"
          className="cb-btn cb-cmdbox__copy"
          onClick={onCopy}
          disabled={expired}
        >
          {copied ? '已复制' : '复制命令'}
        </button>
      </div>

      {/* 会话状态（逐行，永不裸转圈）。 */}
      <p className="cb-cmdbox__phase" data-phase={phase} role="status" aria-live="polite">
        {phasePhrase(status)}
      </p>

      {/* 过期引导（态非错误，导入-25）。 */}
      {expired && (
        <button
          type="button"
          className="cb-btn cb-btn--primary cb-cmdbox__regen"
          onClick={onRegenerate}
        >
          重新生成命令
        </button>
      )}
    </section>
  );
}
