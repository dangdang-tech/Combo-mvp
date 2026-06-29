// STEP① 浏览器内导入卡（B-20 直传）——选文件/目录 + 拖拽区。
//
// 路径定位（命令行优先方案）：命令行/本机直读是主入口（ImportEmptyState 主卡）；本卡降为「不想开终端时」的折叠兜底。
//   走 B-20 直传：用户在浏览器选文件/目录或拖拽 → 交给 useBrowserImport 编排上传 → 建 Job。
// 永不裸转圈：选完进上传中态（BrowserUploadProgress 进度条）；本卡只负责「选/拖」入口，不直接转圈。
// 文案口径（导入-04/05/29）：「完整上传到云端、云端解析去敏」，绝不出现「数据不出本机/仅上传精简/本机解析」。
import { useCallback, useRef, useState, type DragEvent, type ReactElement } from 'react';
import './browser-import.css';

export interface BrowserImportCardProps {
  /** 选了文件/目录或拖拽落区后回调（上层交 useBrowserImport.start 编排）。 */
  onFiles: (files: File[]) => void;
  /** 编排在途时禁用入口（防重复触发；上层 busy）。 */
  disabled?: boolean;
}

/** 从 DataTransfer 收集文件（拖拽落区；目录拖拽在多数浏览器只给顶层文件，足够主路径用）。 */
function filesFromDrop(dt: DataTransfer): File[] {
  return Array.from(dt.files ?? []);
}

export function BrowserImportCard({ onFiles, disabled = false }: BrowserImportCardProps): ReactElement {
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const dirInputRef = useRef<HTMLInputElement | null>(null);

  const handleDrop = useCallback(
    (e: DragEvent<HTMLDivElement>): void => {
      e.preventDefault();
      setDragOver(false);
      if (disabled) return;
      const files = filesFromDrop(e.dataTransfer);
      if (files.length > 0) onFiles(files);
    },
    [onFiles, disabled],
  );

  const handleDragOver = useCallback(
    (e: DragEvent<HTMLDivElement>): void => {
      e.preventDefault();
      if (!disabled) setDragOver(true);
    },
    [disabled],
  );

  const handleDragLeave = useCallback((e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    setDragOver(false);
  }, []);

  const handlePicked = useCallback(
    (input: HTMLInputElement | null): void => {
      if (!input?.files) return;
      const files = Array.from(input.files);
      // 重置 value，使再次选同一文件/目录仍触发 change（续传/重选）。
      input.value = '';
      if (files.length > 0) onFiles(files);
    },
    [onFiles],
  );

  return (
    <article className="cb-bimport" aria-label="从浏览器导入">
      <h3 className="cb-bimport__title">从浏览器导入</h3>
      <p className="cb-bimport__desc">
        直接选中或拖入你的对话历史文件/文件夹，浏览器会把原文完整上传到云端，由云端解析、去敏后用于后续步骤。
      </p>

      <div
        className={`cb-bimport__drop${dragOver ? ' cb-bimport__drop--over' : ''}`}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        role="group"
        aria-label="拖拽文件或文件夹到这里导入"
      >
        <p className="cb-bimport__drop-hint">把文件或文件夹拖到这里，或</p>

        {/* 选文件（multiple）。 */}
        <input
          ref={fileInputRef}
          className="cb-bimport__file-input"
          type="file"
          multiple
          aria-label="选择文件导入"
          disabled={disabled}
          onChange={() => handlePicked(fileInputRef.current)}
        />
        {/* 选目录（webkitdirectory）。注：webkitdirectory 不是标准 TS 属性，需透传到 DOM。 */}
        <input
          ref={dirInputRef}
          className="cb-bimport__file-input"
          type="file"
          aria-label="选择文件夹导入"
          disabled={disabled}
          onChange={() => handlePicked(dirInputRef.current)}
          {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
        />

        <div className="cb-bimport__pickers">
          <button
            type="button"
            className="cb-btn cb-btn--primary"
            onClick={() => fileInputRef.current?.click()}
            disabled={disabled}
          >
            选择文件
          </button>
          <button
            type="button"
            className="cb-btn"
            onClick={() => dirInputRef.current?.click()}
            disabled={disabled}
          >
            选择文件夹
          </button>
        </div>
      </div>
    </article>
  );
}
