/**
 * The closing form as a document: letterhead, legal text, fields, signatures.
 *
 * One component renders both the editable form and the printable one, switched by
 * `readOnly`. Two layouts would drift, and these are signed documents — what is printed
 * has to be what was agreed to on screen.
 *
 * Print styling lives in `styles/index.css` under `@media print`, keyed off
 * `data-print-document`. The legacy version opened a new window and rebuilt the whole
 * document as an HTML string, which meant the printed copy and the on-screen copy were
 * two separate implementations of the same legal text.
 */
import { Input } from "@/components/form";
import { cn } from "@/lib/cn";
import {
  fieldValue,
  LETTERHEAD,
  PHOTO_KEY,
  SIGNATORY_KEY,
  type ClosingFormData,
  type ClosingFormDefinition,
  type FormField,
} from "./closingForms";

export function ClosingFormDocument({
  form,
  data,
  readOnly,
  photoUrl,
  onChange,
  onPickPhoto,
  uploading,
}: {
  form: ClosingFormDefinition;
  data: ClosingFormData;
  readOnly: boolean;
  /** Signed URL for an already-uploaded photo, or a local preview while choosing. */
  photoUrl?: string | null;
  onChange?: (key: string, value: string) => void;
  onPickPhoto?: (file: File) => void;
  uploading?: boolean;
}) {
  const set = (key: string) => (event: { target: { value: string } }) =>
    onChange?.(key, event.target.value);

  return (
    // A light island: `data-theme="light"` re-declares the palette variables for this
    // subtree (see `src/styles/index.css`), so the form renders and prints as the
    // black-on-white legal document it is even while the rest of the app is dark. Nothing
    // in here may use a `dark:` utility — the variant matches by ancestor and would still
    // fire inside the island.
    <div
      data-theme="light"
      data-print-document
      className="mx-auto bg-white p-8 text-gray-900"
      style={{ maxWidth: 720 }}
    >
      <header className="mb-6 flex items-start justify-between gap-6 border-b-2 border-gray-800 pb-4">
        <div>
          <p className="font-display text-xl font-bold">{LETTERHEAD.name}</p>
        </div>
        <div className="text-right text-[11px] leading-relaxed text-gray-700">
          <p>{LETTERHEAD.formerly}</p>
          <p>{LETTERHEAD.address}</p>
          <p>{LETTERHEAD.phone}</p>
          <p>{LETTERHEAD.email}</p>
          <p>{LETTERHEAD.licence}</p>
        </div>
      </header>

      <div className="mb-6 text-center">
        <h2 className="text-xl font-bold tracking-wide text-warning-600">{form.title}</h2>
        {form.subtitle && (
          <p className="text-sm font-medium text-warning-600 italic">{form.subtitle}</p>
        )}
      </div>

      <section className="mb-6 flex flex-col gap-3 text-[13px] leading-relaxed text-gray-700">
        {form.preamble.map((paragraph, index) => (
          <Paragraph
            key={index}
            text={paragraph}
            data={data}
            readOnly={readOnly}
            onChange={onChange}
          />
        ))}
      </section>

      {form.fields.length > 0 && (
        <div className="mb-6 grid gap-4 app-sm:grid-cols-2">
          {form.fields.map((field) => (
            <div key={field.key}>
              <p className="text-[10px] font-semibold tracking-wider text-gray-500 uppercase">
                {field.label}
              </p>
              <FieldValue
                field={field}
                data={data}
                readOnly={readOnly}
                onChange={set(field.key)}
              />
            </div>
          ))}
        </div>
      )}

      {form.terms.length > 0 && (
        <section className="mb-6 flex flex-col gap-3 text-[13px] leading-relaxed text-gray-700">
          {form.terms.map((paragraph, index) => (
            <p key={index}>{paragraph}</p>
          ))}
        </section>
      )}

      <div className="flex items-end justify-between gap-6 border-t border-gray-200 pt-4">
        <div className="grid flex-1 gap-4 app-sm:grid-cols-2">
          {form.signatures.map((field) => (
            <div key={field.key}>
              <FieldValue
                field={field}
                data={data}
                readOnly={readOnly}
                onChange={set(field.key)}
              />
              <p className="mt-1 border-t border-gray-800 pt-1 text-[10px] font-semibold tracking-wider text-gray-500 uppercase">
                {field.label}
              </p>
            </div>
          ))}
        </div>

        {form.hasPhoto && (
          <div className="w-40 shrink-0 text-center">
            <p className="mb-2 text-[10px] font-bold tracking-wider text-gray-400 uppercase">
              Material Photo
            </p>

            {photoUrl ? (
              <img
                src={photoUrl}
                alt="Material"
                className="h-28 w-40 rounded-md object-cover ring-1 ring-gray-200"
              />
            ) : (
              <div className="flex h-28 w-40 items-center justify-center rounded-md border-2 border-dashed border-gray-300 bg-gray-50 text-xs text-gray-400">
                {readOnly ? "No photo" : uploading ? "Uploading…" : "No photo yet"}
              </div>
            )}

            {!readOnly && (
              <label className="mt-2 inline-block cursor-pointer text-[11px] text-brand-700 underline print:hidden">
                <input
                  type="file"
                  accept="image/*"
                  className="sr-only"
                  aria-label="Material photo"
                  disabled={uploading}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) onPickPhoto?.(file);
                    // Reset so choosing the same file twice fires onChange again.
                    event.target.value = "";
                  }}
                />
                {photoUrl ? "Change photo" : "Add a photo"}
              </label>
            )}
            {/* The path is what gets stored; the preview above is only a rendering. */}
            <input type="hidden" value={fieldValue(data, PHOTO_KEY)} readOnly />
          </div>
        )}
      </div>

      <footer className="mt-6 border-t border-gray-200 pt-4 text-center text-[11px] text-gray-400">
        {LETTERHEAD.name} · {LETTERHEAD.phone} · {LETTERHEAD.licence}
      </footer>
    </div>
  );
}

/**
 * A paragraph with `{signatory}` replaced by an inline blank.
 *
 * Form 1's first sentence reads "I, ______, have carefully reviewed…" — the name is
 * part of the sentence, not a labelled field beside it, and moving it would change the
 * document.
 */
function Paragraph({
  text,
  data,
  readOnly,
  onChange,
}: {
  text: string;
  data: ClosingFormData;
  readOnly: boolean;
  onChange?: ((key: string, value: string) => void) | undefined;
}) {
  if (!text.includes("{signatory}")) return <p>{text}</p>;

  const [before, after] = text.split("{signatory}");
  const value = fieldValue(data, SIGNATORY_KEY);

  return (
    <p className="flex flex-wrap items-baseline gap-1">
      <span>{before}</span>
      {readOnly ? (
        <span className="min-w-40 border-b border-gray-800 px-1 font-medium">
          {value || " "}
        </span>
      ) : (
        <input
          value={value}
          aria-label="Signatory name"
          onChange={(event) => onChange?.(SIGNATORY_KEY, event.target.value)}
          className="min-w-40 flex-1 border-0 border-b border-gray-800 bg-transparent px-1 py-0.5 focus:ring-0 focus:outline-none"
        />
      )}
      <span>{after}</span>
    </p>
  );
}

function FieldValue({
  field,
  data,
  readOnly,
  onChange,
}: {
  field: FormField;
  data: ClosingFormData;
  readOnly: boolean;
  onChange: (event: { target: { value: string } }) => void;
}) {
  const value = fieldValue(data, field.key);

  if (readOnly) {
    return (
      <p
        className={cn(
          "min-h-6 border-b border-gray-300 py-1 text-sm",
          field.signature && "font-medium italic",
        )}
      >
        {value || " "}
      </p>
    );
  }

  return (
    <Input
      type={field.type}
      value={value}
      aria-label={field.label}
      placeholder={field.signature ? "Type full name as signature" : undefined}
      className={field.signature ? "italic" : undefined}
      onChange={onChange}
    />
  );
}
