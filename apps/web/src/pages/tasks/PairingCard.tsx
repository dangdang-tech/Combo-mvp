// 建任务成功后的配对引导卡：配对码明文只在这里出现一次（库里只存哈希），提示用户复制；
// 附本机助手一条命令（GET /connect/script?code=<配对码> 下发脚本，`| sh` 直跑）。
import type { ReactElement } from 'react';
import { Link } from 'react-router-dom';
import type { CreateTaskResult } from '@cb/shared';
import { connectCommand } from '../../api/index.js';
import { CopyButton } from '../../components/CopyButton.js';
import { formatTime } from './taskPresent.js';

export interface PairingCardProps {
  created: CreateTaskResult;
  onDismiss: () => void;
}

export function PairingCard({ created, onDismiss }: PairingCardProps): ReactElement {
  const command = connectCommand(created.pairingCode);
  return (
    <section className="cb-pairing" aria-labelledby="cb-pairing-title">
      <h3 className="cb-pairing__title" id="cb-pairing-title">
        任务已创建，用配对码连接本机助手
      </h3>
      <p className="cb-pairing__warn">
        配对码明文只显示这一次（有效期至 {formatTime(created.task.upload.pairingExpiresAt)}
        ），请立即复制；关闭后无法再查看，只能重新建任务。
      </p>

      <div className="cb-pairing__code-row">
        <code className="cb-pairing__code">{created.pairingCode}</code>
        <CopyButton text={created.pairingCode} label="复制配对码" />
      </div>

      <div className="cb-cmdbox">
        <p className="cb-cmdbox__lead">
          在你自己的电脑上打开终端，粘贴运行下面这条命令。它会读取本机的对话历史（~/.claude 与
          ~/.codex），把原文完整上传到云端；云端解析并抹掉手机号、密钥等隐私信息后用于能力提取。
        </p>
        <div className="cb-cmdbox__command">
          <code className="cb-cmdbox__command-text">{command}</code>
          <CopyButton text={command} label="复制命令" className="cb-cmdbox__copy" />
        </div>
        <p className="cb-cmdbox__phase">
          命令跑完后回到任务页，上传与提取进度会实时显示；中断了重跑同一条命令即可续传。
        </p>
      </div>

      <div className="cb-pairing__actions">
        <Link className="cb-pairing__detail" to={`/tasks/${created.task.id}`}>
          查看任务进度
        </Link>
        <button type="button" className="cb-pairing__dismiss" onClick={onDismiss}>
          我已复制，关闭
        </button>
      </div>
    </section>
  );
}
