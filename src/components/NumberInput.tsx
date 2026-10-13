import { useEffect, useState, type ChangeEvent, type FocusEvent } from 'react';
import { formatNum, roundMm } from '../core/format';

interface Props {
  value: number;
  onChange: (value: number) => void;
  step?: number | string;
  min?: number;
  max?: number;
  className?: string;
  disabled?: boolean;
  title?: string;
}

/**
 * Number field that does not reformat on every keystroke (avoids cursor jumping
 * to the end). Formats to 3 decimals only when blurred / unfocused.
 */
export function NumberInput({
  value,
  onChange,
  step = 0.001,
  min,
  max,
  className,
  disabled,
  title,
}: Props) {
  const [focused, setFocused] = useState(false);
  const [text, setText] = useState(() => formatNum(value));

  useEffect(() => {
    if (!focused) setText(formatNum(value));
  }, [value, focused]);

  const commit = (raw: string) => {
    const parsed = parseFloat(raw);
    let next = Number.isFinite(parsed) ? roundMm(parsed) : 0;
    if (min != null) next = Math.max(min, next);
    if (max != null) next = Math.min(max, next);
    onChange(next);
    setText(formatNum(next));
  };

  const onFocus = () => {
    setFocused(true);
    // Editable text without re-forcing "0.100" on every key — keeps caret stable
    setText(Number.isFinite(value) ? String(roundMm(value)) : '');
  };

  const onBlur = (e: FocusEvent<HTMLInputElement>) => {
    setFocused(false);
    commit(e.target.value);
  };

  const onInput = (e: ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    // Allow intermediate strings: "", "-", ".", "0.", "12.3"
    if (raw === '' || /^-?\d*\.?\d*$/.test(raw)) {
      setText(raw);
      const parsed = parseFloat(raw);
      if (Number.isFinite(parsed)) {
        let next = parsed;
        if (min != null) next = Math.max(min, next);
        if (max != null) next = Math.min(max, next);
        onChange(next);
      }
    }
  };

  return (
    <input
      type="text"
      inputMode="decimal"
      className={className}
      disabled={disabled}
      title={title}
      step={step}
      min={min}
      max={max}
      value={focused ? text : formatNum(value)}
      onFocus={onFocus}
      onBlur={onBlur}
      onChange={onInput}
    />
  );
}
