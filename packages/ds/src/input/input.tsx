import { useId, type ChangeEvent } from 'react';
import './input.css';

export interface InputProps {
  /** 输入框类型，search 会在左侧渲染一个放大镜图标。默认 text。 */
  type?: 'text' | 'search' | 'password';
  /** 受控值。只传 value 不传 onChange 时输入框按只读渲染，保证纯 JSON props 也能正确显示。 */
  value?: string;
  /** 非受控初始值。与 value 同传时以 value 为准，defaultValue 被忽略。 */
  defaultValue?: string;
  /** 可选的行为增强：值变化时以当前字符串回调。 */
  onChange?: (v: string) => void;
  placeholder?: string;
  disabled?: boolean;
  /** 校验失败态：危险色描边，聚焦时使用危险色焦点环。 */
  invalid?: boolean;
  /** 传入时渲染与输入框关联的 label 元素。 */
  label?: string;
  /** 输入框元素 id。不传时用 useId 自动生成，保证 label 关联始终成立。 */
  id?: string;
}

export function Input({
  type = 'text',
  value,
  defaultValue,
  onChange,
  placeholder,
  disabled = false,
  invalid = false,
  label,
  id,
}: InputProps) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const handleChange =
    onChange === undefined
      ? undefined
      : (e: ChangeEvent<HTMLInputElement>) => {
          onChange(e.target.value);
        };
  const boxClassName = type === 'search' ? 'cb-input-box cb-input-search' : 'cb-input-box';

  return (
    <div className="cb-input">
      {label !== undefined && (
        <label className="cb-input-label" htmlFor={inputId}>
          {label}
        </label>
      )}
      <div className={boxClassName}>
        {type === 'search' && (
          <svg
            className="cb-input-icon"
            viewBox="0 0 16 16"
            fill="none"
            aria-hidden="true"
            focusable="false"
          >
            <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.5" />
            <path
              d="M10.5 10.5L13.5 13.5"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        )}
        <input
          id={inputId}
          className="cb-input-control"
          type={type}
          value={value}
          defaultValue={value === undefined ? defaultValue : undefined}
          onChange={handleChange}
          readOnly={value !== undefined && onChange === undefined}
          placeholder={placeholder}
          disabled={disabled}
          aria-invalid={invalid || undefined}
        />
      </div>
    </div>
  );
}
