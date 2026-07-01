import { useEffect, useState } from 'react';
import type { RuntimeArtifact } from '@cb/shared';
import { ArtifactRenderer } from './ArtifactRenderer.js';

const KIND_LABEL: Record<string, string> = {
  html: '网页',
  markdown: '文档',
  code: '代码',
  structured: '结构化',
};

export interface ArtifactPanelProps {
  /** 当前展示的产物（active）。 */
  artifact: RuntimeArtifact;
  /** 本会话全部产物（共享状态里的），用于在多产物间切换。 */
  artifacts: RuntimeArtifact[];
  onSelectArtifact: (artifactKey: string) => void;
  onClose: () => void;
}

export function ArtifactPanel({ artifact, artifacts, onSelectArtifact, onClose }: ArtifactPanelProps) {
  const [selectedVersion, setSelectedVersion] = useState<number>(artifact.latestVersion);
  const [copied, setCopied] = useState(false);

  // 切换到另一个产物时，版本重置为其最新版。
  useEffect(() => {
    setSelectedVersion(artifact.latestVersion);
  }, [artifact.artifactKey, artifact.latestVersion]);

  const version =
    artifact.versions.find((v) => v.version === selectedVersion) ??
    artifact.versions[artifact.versions.length - 1];

  const copy = async () => {
    if (!version) return;
    try {
      await navigator.clipboard.writeText(version.content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard 不可用时静默 */
    }
  };

  return (
    <aside className="rt-artifact">
      <header className="rt-artifact__bar">
        <div className="rt-artifact__meta">
          <span className="rt-artifact__kind">{KIND_LABEL[artifact.kind] ?? artifact.kind}</span>
          {artifacts.length > 1 ? (
            <select
              className="rt-artifact__versions"
              value={artifact.artifactKey}
              onChange={(e) => onSelectArtifact(e.target.value)}
            >
              {artifacts.map((a) => (
                <option key={a.artifactKey} value={a.artifactKey}>
                  {a.title}
                </option>
              ))}
            </select>
          ) : (
            <span className="rt-artifact__title">{artifact.title}</span>
          )}
        </div>
        <div className="rt-artifact__actions">
          {artifact.versions.length > 1 && (
            <select
              className="rt-artifact__versions"
              value={version?.version ?? artifact.latestVersion}
              onChange={(e) => setSelectedVersion(Number(e.target.value))}
            >
              {artifact.versions.map((v) => (
                <option key={v.version} value={v.version}>
                  v{v.version}
                </option>
              ))}
            </select>
          )}
          <button type="button" className="rt-icon-btn" onClick={copy} title="复制内容">
            {copied ? '已复制' : '复制'}
          </button>
          <button type="button" className="rt-icon-btn" onClick={onClose} title="收起面板">
            ✕
          </button>
        </div>
      </header>
      <div className="rt-artifact__body">
        {version ? <ArtifactRenderer artifact={version} /> : <div className="rt-empty">暂无内容</div>}
      </div>
    </aside>
  );
}
