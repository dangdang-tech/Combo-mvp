// STEP① 浏览器直传上传中态（BUG-013）——进度条 + 量化文案 + 退路（永不裸转圈）。
//
// 三原则：
//   - 永不裸转圈：preparing/uploading/creating 都给量化进度（percent + 已传 X/Y 片 + 字节），不空转。
//   - 绝不裸露错误码：error 态由上层切 ErrorState（本件只渲染进行中态）。
//   - 已生成内容不丢：上传中断后上层 retry 续传（已传片不重传）；本件「取消」回退到可重选态。
import type { ReactElement } from 'react';
import './browser-import.css';
import type { BrowserImportProgress } from './useBrowserImport.js';

export interface BrowserUploadProgressProps {
  progress: BrowserImportProgress;
  /** 取消上传（回到可重新选择/重选导入方式的态）。 */
  onCancel: () => void;
}

/** 人类可读字节（进度量化文案）。 */
function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** 阶段 → 人话短语（永不裸转圈，逐阶段量化）。 */
function phrase(p: BrowserImportProgress): string {
  switch (p.phase) {
    case 'preparing':
      return '正在准备上传…';
    case 'creating':
      return '上传完成，正在进入处理…';
    case 'uploading':
    default:
      return `正在上传你的对话历史…（${p.percent}% · 已传 ${p.partsDone} / ${p.partsTotal} 片 · ${humanBytes(
        p.bytesSent,
      )} / ${humanBytes(p.bytesTotal)}）`;
  }
}

export function BrowserUploadProgress({
  progress,
  onCancel,
}: BrowserUploadProgressProps): ReactElement {
  return (
    <section className="cb-bimport-progress" aria-label="正在上传你的对话历史">
      <h2 className="cb-bimport-progress__title">正在上传你的对话历史</h2>

      <div
        className="cb-bimport-progress__track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress.percent}
      >
        <div className="cb-bimport-progress__fill" style={{ width: `${progress.percent}%` }} />
      </div>

      <p className="cb-bimport-progress__phrase" role="status" aria-live="polite">
        {phrase(progress)}
      </p>

      <footer className="cb-bimport-progress__foot">
        <button type="button" className="cb-link" onClick={onCancel}>
          取消上传
        </button>
      </footer>
    </section>
  );
}
