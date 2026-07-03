// STEP① 导入空态引导（命令行优先方案）——主路径「命令行 / 本机直读」+ 折叠的浏览器兜底。
//
// 主路径：命令行/本机直读。网页铸一次性配对码 → 终端跑一行命令 → 助手扫本机 ~/.claude / ~/.codex 全量原文
//   凭码直传 → 自动建 Job。点「开始导入 →」铸码并进配对态（CommandBox 展示真命令，导入-02/25）。
//   理由：纯网页受浏览器沙箱限制，无法自动定位隐藏目录直接传；命令行能自动扫目录全量上传，最省事、不会漏。
// 兜底（折叠，保留不删）：不想开终端的人，用浏览器选文件/目录上传（BrowserImportCard，走 B-20 直传）。
// 底部「导入说明」常驻（隐私口径：完整上传到云端、云端解析去敏，导入-04/17/30）。
import { useState, type ReactElement } from 'react';
import './browser-import.css';
import { BrowserImportCard } from './BrowserImportCard.js';

export interface ImportEmptyStateProps {
  /** 浏览器导入（折叠兜底）：选了文件/目录或拖拽落区（上层交 useBrowserImport 编排）。 */
  onFiles: (files: File[]) => void;
  /** 浏览器编排在途时禁用浏览器入口（防重复触发）。 */
  uploading?: boolean;
  /** 点「开始导入 →」（主路径：铸配对码并进配对态）。 */
  onStart: () => void;
  /** 铸码请求是否在途（防重复点；按钮显「准备中…」，永不裸转圈）。 */
  starting?: boolean;
}

export function ImportEmptyState({
  onFiles,
  uploading = false,
  onStart,
  starting = false,
}: ImportEmptyStateProps): ReactElement {
  // 浏览器导入默认折叠（主路径是命令行；浏览器选文件是「不想开终端时」的兜底）。
  const [browserOpen, setBrowserOpen] = useState(false);

  return (
    <section className="cb-import-empty" aria-label="导入你的对话历史">
      <h2 className="cb-import-empty__title">把对话历史，变成可发布的能力</h2>

      <div className="cb-import-empty__cards">
        {/* 主卡：命令行 / 本机直读（命令行优先方案，标推荐）。 */}
        <article className="cb-import-empty__card" aria-label="命令行导入">
          <span className="cb-bimport__badge">推荐 · 最省事</span>
          <h3 className="cb-import-empty__card-title">命令行导入（本机直读）</h3>
          <p className="cb-import-empty__card-desc">
            一行命令，自动扫描这台机器上全部 ~/.claude、~/.codex
            并完整上传到云端，跑完这一页自动接上。无需手动选文件夹，不会漏。
          </p>
          <button
            type="button"
            className="cb-btn cb-btn--primary cb-import-empty__start"
            onClick={onStart}
            disabled={starting}
          >
            {starting ? '准备中…' : '开始导入 →'}
          </button>
        </article>
      </div>

      {/* 兜底（折叠，保留不删）：不想开终端 → 用浏览器选文件上传。 */}
      <div className="cb-import-empty__advanced">
        <button
          type="button"
          className="cb-link cb-import-empty__advanced-toggle"
          aria-expanded={browserOpen}
          onClick={() => setBrowserOpen((v) => !v)}
        >
          {browserOpen ? '收起浏览器导入' : '不想开终端？用浏览器选文件上传'}
        </button>

        {browserOpen && (
          <div className="cb-import-empty__cards" data-advanced="true">
            <BrowserImportCard onFiles={onFiles} disabled={uploading} />
          </div>
        )}
      </div>

      {/* 底部导入说明常驻（隐私口径，导入-04/29：完整上传到云端、云端解析去敏）。 */}
      <footer className="cb-import-empty__notes">
        <p className="cb-import-empty__notes-title">导入说明</p>
        <p className="cb-import-empty__notes-text">
          导入会把你选择的对话历史完整上传到云端，由云端解析、去敏后再用于后续步骤。
        </p>
      </footer>
    </section>
  );
}
