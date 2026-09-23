import { type ChangeEvent } from "react";

/**
 * Accessible labeled form field: connected `<label>`, the input, and either a
 * hint or an inline error. Errors mark the input `aria-invalid` and are
 * referenced via `aria-describedby`.
 */
export interface FormFieldProps {
  id: string;
  label: string;
  type?: "text" | "email" | "password";
  value: string;
  onChange: (value: string) => void;
  error?: string;
  hint?: string;
  autoComplete?: string;
  maxLength?: number;
  required?: boolean;
}

export function FormField({
  id,
  label,
  type = "text",
  value,
  onChange,
  error,
  hint,
  autoComplete,
  maxLength,
  required,
}: FormFieldProps) {
  const describedBy =
    error !== undefined ? `${id}-error` : hint !== undefined ? `${id}-hint` : undefined;

  return (
    <div className="form-field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        name={id}
        type={type}
        value={value}
        maxLength={maxLength}
        autoComplete={autoComplete}
        required={required}
        className={error !== undefined ? "has-error" : undefined}
        aria-invalid={error !== undefined ? true : undefined}
        aria-describedby={describedBy}
        onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value)}
      />
      {error === undefined && hint !== undefined ? (
        <p id={`${id}-hint`} className="field-hint">
          {hint}
        </p>
      ) : null}
      {error !== undefined ? (
        <p id={`${id}-error`} className="field-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}