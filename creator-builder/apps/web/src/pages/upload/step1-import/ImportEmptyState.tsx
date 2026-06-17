// STEP① 导入空态引导（F-10，开工总纲 §5.1.1）——未开始导入时的两种导入方式 + 底部说明常驻。
//
// 文案真源（开工总纲 §5.1.1，逐字对齐；验收 导入-01/02/03/04 同口径）：
//   大标题「把对话历史，变成可发布的能力」（导入-01）。
//   两种方式（§5.1.1）：
//     1. 一键导入（本机直读）·角标「推荐 · 最全」：网页铸一次性配对码 → 终端跑一行命令 → 助手扫本机
//        ~/.claude / ~/.codex 全量原文凭码直传 → 自动建 Job。点「开始导入 →」铸码并进配对态（CommandBox，导入-02）。
//     2. CURL 命令导入（一键复制一行）：展示验收口径固定串（curlOneLiner，导入-03/24），供高级用户先复制后续接。
//   底部「导入说明」常驻（隐私口径：完整上传到云端、云端解析去敏，导入-04/17/30）。
import type { ReactElement } from 'react';

export interface ImportEmptyStateProps {
  /** 点「开始导入 →」（铸配对码并进配对态）。 */
  onStart: () => void;
  /** 铸码请求是否在途（防重复点；按钮显「准备中…」，永不裸转圈）。 */
  starting?: boolean;
}

export function ImportEmptyState({
  onStart,
  starting = false,
}: ImportEmptyStateProps): ReactElement {
  return (
    <section className="cb-import-empty" aria-label="导入你的对话历史">
      <h2 className="cb-import-empty__title">把对话历史，变成可发布的能力</h2>

      <div className="cb-import-empty__cards">
        {/* 卡 1：一键导入（本机直读）·角标「推荐 · 最全」。 */}
        <article className="cb-import-empty__card cb-import-empty__card--primary">
          <span className="cb-import-empty__badge">推荐 · 最全</span>
          <h3 className="cb-import-empty__card-title">一键导入（本机直读）</h3>
          <p className="cb-import-empty__card-desc">
            直接扫描这台机器上全部 ~/.claude、~/.codex —— 全自动，无需选文件夹，不会漏。
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

        {/* 卡 2：CURL 命令导入（一键复制一行）。 */}
        <article className="cb-import-empty__card">
          <h3 className="cb-import-empty__card-title">CURL 命令导入</h3>
          <p className="cb-import-empty__card-desc">
            复制一行命令到终端运行，程序化全量扫描你本机全部历史并上传。一个文件夹都不用选。
          </p>
          <pre className="cb-import-empty__curl-preview" aria-label="导入命令示例">
            <code>curl -fsSL agora.app/import | sh</code>
          </pre>
        </article>
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
