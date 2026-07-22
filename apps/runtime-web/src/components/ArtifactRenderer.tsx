import { useEffect, useMemo, useRef } from 'react';
import type { ArtifactVersion } from '@cb/shared';
import { renderMarkdown } from '../lib/markdown.js';

export interface ComboRunRequest {
  prompt: string;
}

export interface ComboElementSelection {
  key: string;
  label: string;
  role: string | null;
  text: string;
  tagName: string;
  path?: string;
  stableKey?: boolean;
}

export interface ArtifactRendererProps {
  artifact: ArtifactVersion;
  onRunRequest?: (request: ComboRunRequest) => void;
  inspectionEnabled?: boolean;
  selectedElementKey?: string | null;
  onElementSelect?: (element: ComboElementSelection) => void;
  onElementManifest?: (elements: ComboElementSelection[]) => void;
}

const MAX_COMBO_RUN_PROMPT_LENGTH = 12_000;
const MAX_COMBO_ELEMENT_KEY_LENGTH = 120;
const MAX_COMBO_ELEMENT_LABEL_LENGTH = 160;
const MAX_COMBO_ELEMENT_TEXT_LENGTH = 240;
const MAX_COMBO_ELEMENT_PATH_LENGTH = 240;
const MAX_COMBO_ELEMENT_MANIFEST_LENGTH = 80;

const STUDIO_INSPECTION_BRIDGE = `
<style id="combo-studio-inspection-style">
  [data-combo-key].combo-studio-hovered,
  [data-combo-inspection-key].combo-studio-hovered {
    outline: 2px dashed #b8563f !important;
    outline-offset: 3px !important;
  }
  [data-combo-key].combo-studio-selected,
  [data-combo-inspection-key].combo-studio-selected {
    outline: 2px solid #b8563f !important;
    outline-offset: 3px !important;
    box-shadow: 0 0 0 5px rgba(184, 86, 63, 0.14) !important;
  }
  html.combo-studio-inspection-enabled,
  html.combo-studio-inspection-enabled [data-combo-key],
  html.combo-studio-inspection-enabled [data-combo-inspection-key] {
    cursor: crosshair !important;
  }
</style>
<script>
(() => {
  if (window.__comboStudioInspectionV1) return;
  Object.defineProperty(window, '__comboStudioInspectionV1', { value: true });

  let enabled = false;
  let selectedKey = null;
  let hoveredElement = null;
  let manifestFrame = null;
  let generatedKeyCount = 0;
  let suppressClickTarget = null;
  const MAX_ELEMENTS = 80;
  const INSPECTION_TARGET_SELECTOR = '[data-combo-key], [data-combo-inspection-key]';
  const FALLBACK_TARGET_SELECTOR = [
    'main',
    'header',
    'footer',
    'nav',
    'section',
    'article',
    'aside',
    'form',
    'fieldset',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'p',
    'button',
    'a[href]',
    'input',
    'textarea',
    'select',
    'label',
    '[role]',
    '[id]',
    '[class]',
  ].join(',');
  const IGNORED_TAGS = new Set(['html', 'body', 'head', 'script', 'style', 'link', 'meta', 'br']);

  const clean = (value, maxLength) =>
    String(value == null ? '' : value).replace(/\\s+/g, ' ').trim().slice(0, maxLength);

  const roleFor = (element) => {
    const explicitRole = clean(element.getAttribute('role'), 60);
    if (explicitRole) return explicitRole;
    const tagName = element.tagName.toLowerCase();
    if (tagName === 'button') return 'button';
    if (tagName === 'a') return 'link';
    if (tagName === 'input' || tagName === 'textarea' || tagName === 'select') return 'input';
    if (/^h[1-6]$/.test(tagName)) return 'heading';
    if (tagName === 'form') return 'form';
    if (tagName === 'nav') return 'navigation';
    if (['main', 'section', 'article', 'aside', 'header', 'footer'].includes(tagName)) {
      return 'region';
    }
    return null;
  };

  const canInspect = (element) =>
    element instanceof Element && !IGNORED_TAGS.has(element.tagName.toLowerCase());

  const pathFor = (element) => {
    const parts = [];
    let current = element;
    while (current && current !== document.body && parts.length < 7) {
      const tagName = current.tagName.toLowerCase();
      const siblings = current.parentElement
        ? Array.from(current.parentElement.children).filter(
            (sibling) => sibling.tagName === current.tagName,
          )
        : [];
      const index = Math.max(0, siblings.indexOf(current)) + 1;
      parts.unshift(tagName + ':nth-of-type(' + index + ')');
      current = current.parentElement;
    }
    return clean(['body', ...parts].join(' > '), 240);
  };

  const ensureInspectionKey = (element) => {
    const authoredKey = clean(element.getAttribute('data-combo-key'), 120);
    if (authoredKey) return authoredKey;
    const currentKey = clean(element.getAttribute('data-combo-inspection-key'), 120);
    if (currentKey) return currentKey;
    generatedKeyCount += 1;
    const key = 'auto-' + generatedKeyCount.toString(36);
    element.setAttribute('data-combo-inspection-key', key);
    return key;
  };

  const prepareFallbackTargets = () => {
    document.querySelectorAll(FALLBACK_TARGET_SELECTOR).forEach((element) => {
      if (!canInspect(element)) return;
      ensureInspectionKey(element);
    });
  };

  const resolveCandidate = (target) => {
    const authored = target.closest('[data-combo-key]');
    if (authored && canInspect(authored)) return authored;
    const prepared = target.closest('[data-combo-inspection-key]');
    if (prepared && canInspect(prepared)) return prepared;
    const fallback = target.closest(FALLBACK_TARGET_SELECTOR);
    if (fallback && canInspect(fallback)) {
      ensureInspectionKey(fallback);
      return fallback;
    }
    if (!canInspect(target)) return null;
    ensureInspectionKey(target);
    return target;
  };

  const describe = (element) => {
    const authoredKey = clean(element.getAttribute('data-combo-key'), 120);
    const key = authoredKey || ensureInspectionKey(element);
    if (!key) return null;
    const text = clean(element.innerText || element.textContent, 240);
    const controlLabel = element.labels
      ? clean(Array.from(element.labels).map((label) => label.textContent || '').join(' '), 160)
      : '';
    const label = clean(
      element.getAttribute('data-combo-label') ||
        element.getAttribute('aria-label') ||
        element.getAttribute('title') ||
        controlLabel ||
        element.getAttribute('placeholder') ||
        text ||
        key,
      160,
    );
    return {
      key,
      label: label || key,
      role: roleFor(element),
      text,
      tagName: element.tagName.toLowerCase().slice(0, 32),
      path: pathFor(element),
      stableKey: Boolean(authoredKey),
    };
  };

  const post = (payload) => window.parent.postMessage(payload, '*');

  const publishManifest = () => {
    prepareFallbackTargets();
    const candidates = Array.from(document.querySelectorAll(INSPECTION_TARGET_SELECTOR));
    const selected = selectedKey
      ? candidates.find(
          (element) =>
            element.getAttribute('data-combo-key') === selectedKey ||
            element.getAttribute('data-combo-inspection-key') === selectedKey,
        )
      : null;
    const manifestCandidates = selected
      ? [selected, ...candidates.filter((item) => item !== selected)]
      : candidates;
    const elements = manifestCandidates
      .slice(0, MAX_ELEMENTS)
      .map(describe)
      .filter(Boolean);
    post({ type: 'combo:element-manifest', version: 1, elements });
  };

  const scheduleManifest = () => {
    if (manifestFrame !== null) return;
    manifestFrame = window.requestAnimationFrame(() => {
      manifestFrame = null;
      publishManifest();
      syncSelectedElement();
    });
  };

  const syncSelectedElement = () => {
    document.querySelectorAll('.combo-studio-selected').forEach((element) => {
      element.classList.remove('combo-studio-selected');
    });
    if (!selectedKey) return;
    Array.from(document.querySelectorAll(INSPECTION_TARGET_SELECTOR)).find(
      (element) =>
        element.getAttribute('data-combo-key') === selectedKey ||
        element.getAttribute('data-combo-inspection-key') === selectedKey,
    )?.classList.add('combo-studio-selected');
  };

  const clearHover = () => {
    hoveredElement?.classList.remove('combo-studio-hovered');
    hoveredElement = null;
  };

  window.addEventListener('message', (event) => {
    if (event.source !== window.parent || !event.data || typeof event.data !== 'object') return;
    if (event.data.type !== 'combo:inspection-state' || event.data.version !== 1) return;
    enabled = event.data.enabled === true;
    selectedKey =
      typeof event.data.selectedElementKey === 'string'
        ? clean(event.data.selectedElementKey, 120)
        : null;
    document.documentElement.classList.toggle('combo-studio-inspection-enabled', enabled);
    if (!enabled) clearHover();
    syncSelectedElement();
    publishManifest();
  });

  document.addEventListener(
    'pointerover',
    (event) => {
      if (!enabled || !(event.target instanceof Element)) return;
      const candidate = resolveCandidate(event.target);
      if (!candidate || candidate === hoveredElement) return;
      clearHover();
      hoveredElement = candidate;
      hoveredElement.classList.add('combo-studio-hovered');
    },
    true,
  );

  document.addEventListener(
    'pointerout',
    (event) => {
      if (!enabled || !(event.target instanceof Element)) return;
      const candidate = resolveCandidate(event.target);
      if (candidate && candidate === hoveredElement) clearHover();
    },
    true,
  );

  const stopEvent = (event) => {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  };

  const selectCandidate = (candidate) => {
    const element = describe(candidate);
    if (!element) return false;
    selectedKey = element.key;
    syncSelectedElement();
    post({ type: 'combo:element-select', version: 1, element });
    return true;
  };

  document.addEventListener(
    'pointerdown',
    (event) => {
      suppressClickTarget = null;
      if (!enabled || !(event.target instanceof Element)) return;
      const candidate = resolveCandidate(event.target);
      if (!candidate) return;
      stopEvent(event);
      if (selectCandidate(candidate)) suppressClickTarget = candidate;
    },
    true,
  );

  document.addEventListener(
    'click',
    (event) => {
      if (!(event.target instanceof Element)) return;
      if (
        suppressClickTarget &&
        (suppressClickTarget === event.target || suppressClickTarget.contains(event.target))
      ) {
        stopEvent(event);
        suppressClickTarget = null;
        return;
      }
      suppressClickTarget = null;
      if (!enabled) return;
      const candidate = resolveCandidate(event.target);
      if (!candidate) return;
      stopEvent(event);
      selectCandidate(candidate);
    },
    true,
  );

  const ready = () => {
    publishManifest();
    post({ type: 'combo:inspection-ready', version: 1 });
    if (document.body) {
      new MutationObserver(scheduleManifest).observe(document.body, {
        childList: true,
        subtree: true,
      });
    }
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ready, { once: true });
  } else {
    ready();
  }
})();
</script>
`;

/** 按 kind 渲染一个 artifact 版本。html 走【沙箱 iframe】（allow-scripts、无 same-origin，隔离父页）。 */
export function ArtifactRenderer(props: ArtifactRendererProps) {
  const { artifact } = props;
  switch (artifact.kind) {
    case 'html':
      return <HtmlView {...props} />;
    case 'markdown':
      return <MarkdownView content={artifact.content} />;
    case 'code':
      return <CodeView content={artifact.content} language={artifact.language} />;
    case 'structured':
      return <StructuredView content={artifact.content} />;
    default:
      return <pre className="rt-artifact__raw">{artifact.content}</pre>;
  }
}

function HtmlView({
  artifact,
  onRunRequest,
  inspectionEnabled = false,
  selectedElementKey = null,
  onElementSelect,
  onElementManifest,
}: ArtifactRendererProps) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const bridgeEnabled = Boolean(onElementSelect || onElementManifest);
  const srcDoc = useMemo(
    () => (bridgeEnabled ? injectStudioInspectionBridge(artifact.content) : artifact.content),
    [artifact.content, bridgeEnabled],
  );

  const syncInspectionState = (): void => {
    if (!bridgeEnabled) return;
    frameRef.current?.contentWindow?.postMessage(
      {
        type: 'combo:inspection-state',
        version: 1,
        enabled: inspectionEnabled,
        selectedElementKey,
      },
      '*',
    );
  };

  useEffect(() => {
    if (!onRunRequest && !onElementSelect && !onElementManifest) return;

    const handleMessage = (event: MessageEvent<unknown>): void => {
      if (event.source !== frameRef.current?.contentWindow) return;
      if (onRunRequest && isComboRunMessage(event.data)) {
        const prompt = event.data.prompt.trim();
        if (!prompt || prompt.length > MAX_COMBO_RUN_PROMPT_LENGTH) return;
        onRunRequest({ prompt });
        return;
      }
      if (isComboInspectionReadyMessage(event.data)) {
        syncInspectionState();
        return;
      }
      if (onElementSelect && isComboElementSelectMessage(event.data)) {
        onElementSelect(event.data.element);
        return;
      }
      if (onElementManifest && isComboElementManifestMessage(event.data)) {
        onElementManifest(event.data.elements);
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [inspectionEnabled, onElementManifest, onElementSelect, onRunRequest, selectedElementKey]);

  useEffect(() => {
    syncInspectionState();
  }, [bridgeEnabled, inspectionEnabled, selectedElementKey]);

  return (
    <iframe
      ref={frameRef}
      className="rt-artifact__frame"
      title={artifact.title}
      sandbox="allow-scripts allow-popups allow-forms"
      srcDoc={srcDoc}
      onLoad={syncInspectionState}
    />
  );
}

function injectStudioInspectionBridge(content: string): string {
  const closingBody = content.match(/<\/body\s*>/i);
  if (!closingBody || closingBody.index === undefined)
    return `${content}${STUDIO_INSPECTION_BRIDGE}`;
  const index = closingBody.index;
  return `${content.slice(0, index)}${STUDIO_INSPECTION_BRIDGE}${content.slice(index)}`;
}

function isComboRunMessage(
  value: unknown,
): value is { type: 'combo:run'; version: 1; prompt: string } {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { type?: unknown; version?: unknown; prompt?: unknown };
  return (
    candidate.type === 'combo:run' &&
    candidate.version === 1 &&
    typeof candidate.prompt === 'string'
  );
}

function isComboInspectionReadyMessage(
  value: unknown,
): value is { type: 'combo:inspection-ready'; version: 1 } {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { type?: unknown; version?: unknown };
  return candidate.type === 'combo:inspection-ready' && candidate.version === 1;
}

function isComboElementSelection(value: unknown): value is ComboElementSelection {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.key === 'string' &&
    candidate.key.trim().length > 0 &&
    candidate.key.length <= MAX_COMBO_ELEMENT_KEY_LENGTH &&
    typeof candidate.label === 'string' &&
    candidate.label.trim().length > 0 &&
    candidate.label.length <= MAX_COMBO_ELEMENT_LABEL_LENGTH &&
    (candidate.role === null ||
      (typeof candidate.role === 'string' && candidate.role.length <= 60)) &&
    typeof candidate.text === 'string' &&
    candidate.text.length <= MAX_COMBO_ELEMENT_TEXT_LENGTH &&
    typeof candidate.tagName === 'string' &&
    candidate.tagName.length > 0 &&
    candidate.tagName.length <= 32 &&
    (candidate.path === undefined ||
      (typeof candidate.path === 'string' &&
        candidate.path.length > 0 &&
        candidate.path.length <= MAX_COMBO_ELEMENT_PATH_LENGTH)) &&
    (candidate.stableKey === undefined || typeof candidate.stableKey === 'boolean')
  );
}

function isComboElementSelectMessage(
  value: unknown,
): value is { type: 'combo:element-select'; version: 1; element: ComboElementSelection } {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { type?: unknown; version?: unknown; element?: unknown };
  return (
    candidate.type === 'combo:element-select' &&
    candidate.version === 1 &&
    isComboElementSelection(candidate.element)
  );
}

function isComboElementManifestMessage(value: unknown): value is {
  type: 'combo:element-manifest';
  version: 1;
  elements: ComboElementSelection[];
} {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { type?: unknown; version?: unknown; elements?: unknown };
  return (
    candidate.type === 'combo:element-manifest' &&
    candidate.version === 1 &&
    Array.isArray(candidate.elements) &&
    candidate.elements.length <= MAX_COMBO_ELEMENT_MANIFEST_LENGTH &&
    candidate.elements.every(isComboElementSelection)
  );
}

function MarkdownView({ content }: { content: string }) {
  const html = useMemo(() => renderMarkdown(content), [content]);
  return <div className="rt-md rt-artifact__md" dangerouslySetInnerHTML={{ __html: html }} />;
}

function CodeView({ content, language }: { content: string; language: string | null }) {
  return (
    <pre className="rt-artifact__code">
      {language && <span className="rt-artifact__code-lang">{language}</span>}
      <code>{content}</code>
    </pre>
  );
}

function StructuredView({ content }: { content: string }) {
  const data = useMemo<JsonValue | null>(() => {
    try {
      return JSON.parse(content) as JsonValue;
    } catch {
      return null;
    }
  }, [content]);

  if (data === null) {
    return (
      <section className="rt-structured rt-structured--invalid">
        <div className="rt-structured__header">
          <div>
            <div className="rt-structured__eyebrow">结构化结果</div>
            <h2>结果格式还没有准备好</h2>
          </div>
        </div>
        <p className="rt-structured__notice">
          这次运行返回的内容不完整，暂时无法转换成可读页面。你可以继续对话让 Agent 重新生成。
        </p>
        <details className="rt-structured__raw-details">
          <summary>查看原始内容</summary>
          <pre>{content}</pre>
        </details>
      </section>
    );
  }

  if (isRecord(data) && Array.isArray(data.checks)) {
    return <ChecklistView data={data} />;
  }

  return (
    <section className="rt-structured">
      <StructuredHeader data={data} />
      <div className="rt-structured__body">
        <JsonNode value={data} depth={0} />
      </div>
    </section>
  );
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

function isRecord(value: JsonValue | undefined): value is { [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function textValue(value: JsonValue | undefined): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

function displayKey(key: string): string {
  const labels: Record<string, string> = {
    id: '编号',
    item: '核查项',
    note: '说明',
    status: '状态',
    score: '评分',
    summary: '摘要',
    result: '结果',
    checks: '核查结果',
    generatedAt: '生成时间',
    cardVersion: '版本',
    evidenceNote: '证据说明',
    runtimeEvidenceNotice: '运行说明',
  };
  return labels[key] ?? key.replaceAll('_', ' ');
}

function statusTone(status: string): 'pass' | 'warning' | 'fail' | 'neutral' {
  const normalized = status.toLowerCase();
  if (/通过|完成|成功|pass|done|true|✅/.test(normalized)) return 'pass';
  if (/警告|待|部分|warning|pending|⚠/.test(normalized)) return 'warning';
  if (/失败|错误|不通过|fail|false|error|❌/.test(normalized)) return 'fail';
  return 'neutral';
}

function ChecklistView({ data }: { data: { [key: string]: JsonValue } }) {
  const meta = isRecord(data.meta) ? data.meta : {};
  const checks = (data.checks as JsonValue[]).filter(isRecord);
  const passed = checks.filter(
    (check) => statusTone(textValue(check.status) ?? '') === 'pass',
  ).length;
  const title = textValue(meta.cardTitle) ?? textValue(data.title) ?? '核查结果';
  const version = textValue(meta.cardVersion);
  const generatedAt = textValue(meta.generatedAt);
  const notice = textValue(meta.runtimeEvidenceNotice) ?? textValue(meta.evidenceNote);

  return (
    <section className="rt-structured rt-structured--checklist">
      <div className="rt-structured__header">
        <div>
          <div className="rt-structured__eyebrow">结构化核查</div>
          <h2>{title}</h2>
          {(version || generatedAt) && (
            <p className="rt-structured__meta">
              {[version, generatedAt].filter(Boolean).join(' · ')}
            </p>
          )}
        </div>
        <div className="rt-structured__progress" aria-label={`${passed} / ${checks.length} 项通过`}>
          <strong>{passed}</strong>
          <span>/ {checks.length} 项通过</span>
        </div>
      </div>

      {notice && <p className="rt-structured__notice">{notice}</p>}

      <ol className="rt-checklist">
        {checks.map((check, index) => {
          const status = textValue(check.status) ?? '待确认';
          const tone = statusTone(status);
          return (
            <li
              className={`rt-checklist__item rt-checklist__item--${tone}`}
              key={textValue(check.id) ?? index}
            >
              <span className="rt-checklist__mark" aria-hidden="true">
                {tone === 'pass' ? '✓' : tone === 'fail' ? '×' : tone === 'warning' ? '!' : '·'}
              </span>
              <div className="rt-checklist__content">
                <div className="rt-checklist__title-row">
                  <strong>{textValue(check.item) ?? `核查项 ${index + 1}`}</strong>
                  <span>{status}</span>
                </div>
                {textValue(check.note) && <p>{textValue(check.note)}</p>}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function StructuredHeader({ data }: { data: JsonValue }) {
  const record = isRecord(data) ? data : null;
  const meta = record && isRecord(record.meta) ? record.meta : null;
  const title =
    (meta && (textValue(meta.cardTitle) ?? textValue(meta.title))) ??
    (record && (textValue(record.title) ?? textValue(record.name))) ??
    '结构化结果';

  return (
    <div className="rt-structured__header">
      <div>
        <div className="rt-structured__eyebrow">Agent 结果</div>
        <h2>{title}</h2>
      </div>
    </div>
  );
}

function JsonNode({ value, depth }: { value: JsonValue; depth: number }) {
  if (value === null) return <span className="rt-structured__empty">暂无</span>;
  if (typeof value === 'boolean') return <span>{value ? '是' : '否'}</span>;
  if (typeof value === 'string' || typeof value === 'number') return <span>{String(value)}</span>;

  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="rt-structured__empty">暂无内容</span>;
    return (
      <ol className="rt-structured__list">
        {value.map((item, index) => (
          <li key={index}>
            <JsonNode value={item} depth={depth + 1} />
          </li>
        ))}
      </ol>
    );
  }

  const entries = Object.entries(value).filter(
    ([key]) => !(depth === 0 && ['meta', 'title', 'name'].includes(key)),
  );
  if (entries.length === 0) return <span className="rt-structured__empty">暂无内容</span>;

  return (
    <dl className={`rt-structured__fields${depth > 0 ? ' rt-structured__fields--nested' : ''}`}>
      {entries.map(([key, item]) => (
        <div className="rt-structured__field" key={key}>
          <dt>{displayKey(key)}</dt>
          <dd>
            <JsonNode value={item} depth={depth + 1} />
          </dd>
        </div>
      ))}
    </dl>
  );
}
