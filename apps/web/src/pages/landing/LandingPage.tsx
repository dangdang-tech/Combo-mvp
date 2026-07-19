import type { ReactElement, ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useDocumentTitle } from '../../shell/useDocumentTitle.js';

const workflowSteps = [
  {
    number: '01',
    label: '导入真实工作',
    title: '从你已经做过的事开始',
    description: '连接本地 AI 工作会话。Combo 只分析你选择上传的记录，把重复出现的专业工作找出来。',
    detail: '工作会话 · 决策过程 · 交付结果',
  },
  {
    number: '02',
    label: '提炼可复用能力',
    title: '把经验变成有结构的产品',
    description: '自动归纳输入、步骤、判断标准与使用边界，再由你试用、修改和决定是否发布。',
    detail: '输入契约 · 工作流 · 使用边界',
  },
  {
    number: '03',
    label: '发布并持续交付',
    title: '让别人直接获得你的方法',
    description: '发布成可试用、可分享的 AI 能力。你保留作者身份，也保留最终的发布控制权。',
    detail: '公开主页 · 能力页面 · 持续迭代',
  },
] as const;

const capabilityParts = [
  ['知道需要什么', '明确用户要提供的材料，减少来回沟通。'],
  ['知道如何开始', '把最常见的需求变成可直接使用的起手问题。'],
  ['知道做到什么程度', '保留你的判断标准，而不只是模仿表达方式。'],
  ['知道什么时候停下', '公开使用边界，不替创作者做越界承诺。'],
] as const;

function ArrowIcon(): ReactElement {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M4 10h11M11 6l4 4-4 4" />
    </svg>
  );
}

function LandingButton({
  to,
  children,
  variant = 'primary',
}: {
  to: string;
  children: ReactNode;
  variant?: 'primary' | 'secondary' | 'light';
}): ReactElement {
  return (
    <Link className={`cb-landing-button cb-landing-button--${variant}`} to={to}>
      <span>{children}</span>
      <ArrowIcon />
    </Link>
  );
}

function ProductPreview(): ReactElement {
  return (
    <div
      className="cb-landing-preview"
      role="img"
      aria-label="Combo 把真实工作编译成能力的产品流程示意"
    >
      <div className="cb-landing-preview__bar">
        <span>RAW WORK → METHOD → CAPABILITY</span>
        <span className="cb-landing-preview__live">
          <i aria-hidden="true" /> 提炼完成
        </span>
      </div>

      <div className="cb-landing-compiler">
        <svg
          className="cb-landing-compiler__paths"
          viewBox="0 0 720 360"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <path d="M150 78 C252 78 248 169 342 169" />
          <path d="M150 171 C248 171 258 180 342 180" />
          <path d="M150 264 C252 264 248 191 342 191" />
          <path className="cb-landing-compiler__path-out" d="M420 180 C474 180 492 180 548 180" />
        </svg>

        <div className="cb-landing-compiler__source">
          <p className="cb-landing-compiler__label">01 / 工作记录</p>
          <div className="cb-landing-session-card">
            <span>01</span>
            <div>
              <strong>品牌刷新评审</strong>
              <small>结构与行为保留</small>
            </div>
          </div>
          <div className="cb-landing-session-card">
            <span>02</span>
            <div>
              <strong>前端验收闭环</strong>
              <small>真实页面与回归证据</small>
            </div>
          </div>
          <div className="cb-landing-session-card">
            <span>03</span>
            <div>
              <strong>设计系统落地</strong>
              <small>颜色职责与主题适配</small>
            </div>
          </div>
        </div>

        <div className="cb-landing-compiler__core" aria-hidden="true">
          <p className="cb-landing-compiler__label">02 / 共同方法</p>
          <div className="cb-landing-compiler__ring">
            <span>提炼</span>
            <strong>方法</strong>
            <small>3 个共同模式</small>
          </div>
          <ul>
            <li>判断标准</li>
            <li>交付步骤</li>
            <li>使用边界</li>
          </ul>
        </div>

        <div className="cb-landing-compiler__output">
          <p className="cb-landing-compiler__label">03 / 能力产品</p>
          <div className="cb-landing-output-stack">
            <article className="cb-landing-output-card">
              <div className="cb-landing-output-card__status">
                <span>可试用能力</span>
                <b>待发布</b>
              </div>
              <h2>Figma 到前端的品牌刷新</h2>
              <p>把品牌规范落进真实产品，同时保留结构、状态与交互。</p>
              <div className="cb-landing-output-card__meta">
                <span>输入契约</span>
                <span>交付结果</span>
                <span>使用边界</span>
              </div>
            </article>
          </div>
        </div>
      </div>

      <div className="cb-landing-preview__foot">
        <span>多段真实工作进入</span>
        <strong>结构化能力出来</strong>
      </div>
    </div>
  );
}

export function LandingPage(): ReactElement {
  useDocumentTitle('把经验变成可交付的 AI 产品 · Combo');

  return (
    <article className="cb-landing">
      <section className="cb-landing-hero" aria-labelledby="cb-landing-title">
        <div className="cb-landing-container cb-landing-hero__grid">
          <div className="cb-landing-hero__copy">
            <p className="cb-landing-eyebrow">
              <span aria-hidden="true">✦</span> 为专业创作者而生
            </p>
            <h1 id="cb-landing-title">
              <span>把你反复提供的</span>
              <span>专业服务，变成</span>
              <span>
                <em>可持续交付</em>的
              </span>
              <span>AI 产品。</span>
            </h1>
            <p className="cb-landing-hero__lead">
              Combo 从真实工作记录里找到你的方法，帮你提炼、试用并发布成别人可以直接使用的能力。
              不是重新写一套提示词，而是让已经被验证的经验继续工作。
            </p>
            <div className="cb-landing-hero__actions">
              <LandingButton to="/tasks">用我的工作记录开始</LandingButton>
              <LandingButton to="/a/cap-wskatc" variant="secondary">
                查看一个能力示例
              </LandingButton>
            </div>
            <ul className="cb-landing-hero__notes" aria-label="产品原则">
              <li>从真实工作出发</li>
              <li>由创作者确认后发布</li>
              <li>保留方法与使用边界</li>
            </ul>
          </div>
          <ProductPreview />
        </div>
      </section>

      <section className="cb-landing-thesis" aria-label="Combo 的产品主张">
        <ol className="cb-landing-container cb-landing-thesis__signals" aria-label="能力形成过程">
          <li>
            <span>01</span> 真实工作
          </li>
          <li>
            <span>02</span> 支撑证据
          </li>
          <li>
            <span>03</span> 判断方法
          </li>
          <li>
            <span>04</span> 使用边界
          </li>
          <li>
            <span>05</span> 可运行能力
          </li>
        </ol>
        <div className="cb-landing-container cb-landing-thesis__grid">
          <p>你不缺另一个 AI 助手。</p>
          <blockquote>
            你缺的是一种方法，让已经反复做对的事情，成为别人可以使用和持续复用的产品。
          </blockquote>
        </div>
      </section>

      <section
        className="cb-landing-section cb-landing-workflow"
        id="how-it-works"
        aria-labelledby="cb-landing-workflow-title"
      >
        <div className="cb-landing-container">
          <div className="cb-landing-section__head">
            <p className="cb-landing-kicker">如何工作</p>
            <h2 id="cb-landing-workflow-title">从一段工作记录，到一个可以交付的能力。</h2>
            <p>Combo 把复杂的产品化过程收敛成三步，但每一步都由你保留最终判断。</p>
          </div>
          <ol className="cb-landing-workflow__grid">
            {workflowSteps.map((step) => (
              <li key={step.number} className="cb-landing-workflow__card">
                <div className="cb-landing-workflow__meta">
                  <span>{step.number}</span>
                  <small>{step.label}</small>
                </div>
                <h3>{step.title}</h3>
                <p>{step.description}</p>
                <strong>{step.detail}</strong>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section
        className="cb-landing-section cb-landing-product"
        id="product"
        aria-labelledby="cb-landing-product-title"
      >
        <div className="cb-landing-container cb-landing-product__grid">
          <div className="cb-landing-product__copy">
            <p className="cb-landing-kicker">能力，不是提示词</p>
            <h2 id="cb-landing-product-title">把你的判断方式，一起放进产品里。</h2>
            <p className="cb-landing-product__lead">
              真正的专业服务不只是一条答案。Combo
              把输入、过程、交付标准和边界组织成同一个可运行单元。
            </p>
            <ul className="cb-landing-product__parts">
              {capabilityParts.map(([title, description]) => (
                <li key={title}>
                  <span aria-hidden="true">✦</span>
                  <div>
                    <h3>{title}</h3>
                    <p>{description}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>

          <div className="cb-landing-capability-card">
            <div className="cb-landing-capability-card__top">
              <span>能力页面示例</span>
              <span>由创作者确认后发布</span>
            </div>
            <h3>真实长会话能力提取评审</h3>
            <p>把一段真实工作会话变成可复用、可试用的能力项。</p>
            <div className="cb-landing-capability-card__prompt">
              <small>可以这样开始</small>
              <strong>“帮我评审这个候选能力是否值得发布。”</strong>
            </div>
            <dl>
              <div>
                <dt>输入</dt>
                <dd>候选能力 + 支撑材料</dd>
              </div>
              <div>
                <dt>边界</dt>
                <dd>只基于提供的证据评审</dd>
              </div>
            </dl>
            <LandingButton to="/a/cap-wskatc" variant="secondary">
              打开能力页面
            </LandingButton>
          </div>
        </div>
      </section>

      <section className="cb-landing-section cb-landing-creator" aria-labelledby="cb-creator-title">
        <div className="cb-landing-container cb-landing-creator__grid">
          <div>
            <p className="cb-landing-kicker">让经验产生复利</p>
            <h2 id="cb-creator-title">你继续解决新的问题。重复的部分，交给已经产品化的能力。</h2>
          </div>
          <div className="cb-landing-creator__path" aria-label="创作者价值路径">
            <div>
              <span>现在</span>
              <strong>每次服务都从头再来</strong>
              <p>经验留在对话里，下一位客户仍然需要你重复解释。</p>
            </div>
            <i aria-hidden="true">→</i>
            <div>
              <span>使用 Combo 后</span>
              <strong>一次方法，持续交付</strong>
              <p>能力可以被试用、分享和迭代，你的名字与方法一起留下。</p>
            </div>
          </div>
        </div>
      </section>

      <section className="cb-landing-cta" aria-labelledby="cb-landing-cta-title">
        <div className="cb-landing-container cb-landing-cta__inner">
          <div>
            <p>你的下一款 AI 产品，可能已经存在于一次工作记录里。</p>
            <h2 id="cb-landing-cta-title">让 Combo 帮你把它找出来。</h2>
          </div>
          <LandingButton to="/tasks" variant="light">
            开始提炼我的能力
          </LandingButton>
        </div>
      </section>

      <footer className="cb-landing-footer">
        <div className="cb-landing-container cb-landing-footer__inner">
          <div>
            <strong>Combo.</strong>
            <p>把反复验证过的专业经验，变成可以持续交付的 AI 产品。</p>
          </div>
          <nav aria-label="页尾导航">
            <a href="#how-it-works">如何工作</a>
            <a href="#product">能力是什么</a>
            <Link to="/login">创作者登录</Link>
          </nav>
          <small>© 2026 Combo</small>
        </div>
      </footer>
    </article>
  );
}
