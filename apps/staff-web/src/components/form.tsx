/**
 * Form primitives.
 *
 * Every input is label-associated via a generated id, so clicking the label focuses the
 * field and screen readers announce it. The legacy app used bare `<input>` with a
 * sibling `<div>` acting as a label, which neither of those things is true of.
 */
import { useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

const CONTROL =
  "w-full rounded-md border-0 bg-white px-3 py-1.5 text-sm text-gray-900 ring-1 ring-inset " +
  "ring-gray-300 placeholder:text-gray-400 focus:ring-2 focus:ring-inset focus:ring-brand-500 " +
  "disabled:bg-gray-50 disabled:text-gray-500 aria-[invalid=true]:ring-danger-500";

export function Field({
  label,
  hint,
  error,
  required,
  children,
}: {
  label: string;
  hint?: string;
  error?: string | undefined;
  required?: boolean;
  /** Receives the id to attach to the control. */
  children: (props: { id: string; "aria-invalid": boolean; "aria-describedby"?: string }) => ReactNode;
}) {
  const id = useId();
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-gray-700">
        {label}
        {required && <span className="ml-0.5 text-danger-600">*</span>}
      </label>
      {children({
        id,
        "aria-invalid": Boolean(error),
        ...(describedBy ? { "aria-describedby": describedBy } : {}),
      })}
      {error ? (
        <p id={`${id}-error`} className="text-xs text-danger-600">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-xs text-gray-500">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(CONTROL, className)} {...rest} />;
}

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(CONTROL, "resize-y", className)} {...rest} />;
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cn(CONTROL, "pr-8", className)} {...rest}>
      {children}
    </select>
  );
}

/** A labelled field in one call, for the common case of a plain text input. */
export function TextField({
  label,
  hint,
  error,
  required,
  ...rest
}: {
  label: string;
  hint?: string;
  error?: string | undefined;
  required?: boolean;
} & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <Field label={label} {...(hint ? { hint } : {})} error={error} {...(required ? { required } : {})}>
      {(props) => <Input {...props} {...(required ? { required: true } : {})} {...rest} />}
    </Field>
  );
}
