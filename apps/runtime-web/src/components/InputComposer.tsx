import { useState, type KeyboardEvent } from 'react';
import type { InputField, PublicCapabilityView } from '@cb/shared';

export interface InputComposerProps {
  capability: PublicCapabilityView;
  /** 首条消息：展示结构化输入表单 + 引导提示。 */
  isFirst: boolean;
  disabled: boolean;
  onSend: (text: string, inputs?: Record<string, string>) => void;
  onInterrupt?: () => void;
}

export function InputComposer({
  capability,
  isFirst,
  disabled,
  onSend,
  onInterrupt,
}: InputComposerProps) {
  const [text, setText] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    const inputs = isFirst ? collectInputs(capability.inputs.fields, values) : undefined;
    onSend(trimmed, inputs);
    setText('');
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="rt-composer">
      {isFirst && capability.inputs.fields.length > 0 && (
        <div className="rt-inputs">
          {capability.inputs.fields.map((f) => (
            <FieldControl
              key={f.key}
              field={f}
              value={values[f.key] ?? ''}
              onChange={(v) => setValues((s) => ({ ...s, [f.key]: v }))}
            />
          ))}
        </div>
      )}

      {isFirst && capability.starterPrompts.length > 0 && (
        <div className="rt-starters">
          {capability.starterPrompts.map((p, i) => (
            <button
              key={i}
              type="button"
              className="rt-starter"
              disabled={disabled}
              onClick={() => setText(p)}
            >
              {p}
            </button>
          ))}
        </div>
      )}

      <div className="rt-composer__row">
        <textarea
          className="rt-composer__input"
          placeholder={isFirst ? '描述你想要的产出，按 Enter 发送…' : '继续对话（Enter 发送，Shift+Enter 换行）'}
          value={text}
          disabled={disabled}
          rows={2}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <button
          type="button"
          className="rt-btn rt-btn--accent rt-composer__send"
          disabled={disabled || text.trim().length === 0}
          onClick={submit}
        >
          {disabled ? '生成中…' : '发送'}
        </button>
        {disabled && onInterrupt && (
          <button
            type="button"
            className="rt-btn rt-composer__send"
            onClick={onInterrupt}
          >
            打断
          </button>
        )}
      </div>
    </div>
  );
}

function collectInputs(
  fields: InputField[],
  values: Record<string, string>,
): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const f of fields) {
    const v = values[f.key];
    if (v && v.trim()) out[f.key] = v.trim();
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function FieldControl({
  field,
  value,
  onChange,
}: {
  field: InputField;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="rt-field">
      <span className="rt-field__label">
        {field.label}
        {field.required && <span className="rt-field__req">*</span>}
      </span>
      {field.type === 'text' ? (
        <textarea
          className="rt-field__control"
          rows={2}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : field.type === 'enum' ? (
        <select
          className="rt-field__control"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">请选择…</option>
          {(field.options ?? []).map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      ) : (
        <input
          className="rt-field__control"
          type={field.type === 'number' ? 'number' : 'text'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </label>
  );
}
