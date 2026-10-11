/**
 * Form primitives.
 *
 * Every input is label-associated via a generated id, so clicking the label focuses the
 * field and screen readers announce it. The legacy app used bare `<input>` with a
 * sibling `<div>` acting as a label, which neither of those things is true of.
 */
import { useId, type ComponentPropsWithRef, type InputHTMLAttributes, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { useStaged } from "./stagedContext";

const CONTROL =
  "w-full rounded-md border-0 bg-surface px-3 py-1.5 text-sm text-gray-900 ring-1 ring-inset " +
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
        {required && <span className="ml-0.5 text-danger-600 dark:text-danger-400">*</span>}
      </label>
      {children({
        id,
        "aria-invalid": Boolean(error),
        ...(describedBy ? { "aria-describedby": describedBy } : {}),
      })}
      {error ? (
        <p id={`${id}-error`} className="text-xs text-danger-600 dark:text-danger-400">
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

/**
 * On a form the assistant is showing (`staged.tsx`), a control it filled in is marked and
 * reads at full strength, and no control shows a placeholder: example text on a
 * read-only form is indistinguishable from a value. Outside one, none of this applies.
 */
const STAGED_FILLED = "bg-transparent! text-gray-900! opacity-100!";

function hasValue(value: unknown): boolean {
  return value !== undefined && value !== null && String(value) !== "";
}

function Marked({ filled, children }: { filled: boolean; children: ReactNode }) {
  if (!filled) return <>{children}</>;
  return (
    <span data-staged-fill className="ast-field">
      {children}
    </span>
  );
}

/** `ComponentPropsWithRef` rather than `InputHTMLAttributes`, so callers can hold a ref
 *  — the inline room rename needs one to select the existing text on open. React 19
 *  passes `ref` through as an ordinary prop, so no `forwardRef` is involved. */
export function Input({ className, placeholder, ...rest }: ComponentPropsWithRef<"input">) {
  const staged = useStaged();
  const filled = staged && hasValue(rest.value ?? rest.defaultValue);
  return (
    <Marked filled={filled}>
      <input
        className={cn(CONTROL, filled && STAGED_FILLED, className)}
        {...(staged ? {} : { placeholder })}
        {...rest}
      />
    </Marked>
  );
}

export function Textarea({ className, placeholder, ...rest }: ComponentPropsWithRef<"textarea">) {
  const staged = useStaged();
  const filled = staged && hasValue(rest.value ?? rest.defaultValue);
  return (
    <Marked filled={filled}>
      <textarea
        className={cn(CONTROL, "resize-y", filled && STAGED_FILLED, className)}
        {...(staged ? {} : { placeholder })}
        {...rest}
      />
    </Marked>
  );
}

export function Select({ className, children, ...rest }: ComponentPropsWithRef<"select">) {
  const staged = useStaged();
  const filled = staged && hasValue(rest.value ?? rest.defaultValue);
  return (
    <Marked filled={filled}>
      <select className={cn(CONTROL, "pr-8", filled && STAGED_FILLED, className)} {...rest}>
        {children}
      </select>
    </Marked>
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
