/**
 * The two closing forms: their fields, their legal text, and how they are stored.
 *
 * These are signed legal documents, so the wording is reproduced **verbatim** from the
 * legacy `projects.html`. Do not paraphrase it — someone has agreed to these exact
 * sentences, and a form whose text differs from the one that was signed is worse than
 * no form at all.
 *
 * `ClosingFormSubmit.data` is deliberately free-form server-side: the API treats the
 * contents as an opaque record and cares only *whether* each form is present, which is
 * what drives the work-status transition. That freedom lives here instead — the field
 * list is the schema, and it is pure data so it can be tested and rendered by both the
 * editable form and the print layout.
 *
 * One consequence of the backend's `bool(project.closing_form_1)` check is worth
 * knowing: **an empty object does not count as submitted.** A form saved with every
 * field blank would leave the project stuck, so `isComplete` gates the submit button.
 */

/** The letterhead, verbatim. Reproduced on screen and in print. */
export const LETTERHEAD = {
  name: "BUILDCO",
  formerly: "FKA: L A Handy Construction",
  address: "3125 Granville Ave. Los Angeles, CA 90066",
  phone: "Phone: 1-844-51BUILD",
  email: "Info@Lahandyconstruction.com",
  licence: "Lic. # 942121",
} as const;

export type FormNumber = 1 | 2;

export interface FormField {
  /** The key inside `closing_form_N`. Matches the legacy ids exactly, so a form
   *  submitted by the old app still renders here. */
  key: string;
  label: string;
  type: "text" | "date";
  /** Signatures are typed names, shown in italic — as they were in the legacy form. */
  signature?: boolean;
}

export interface ClosingFormDefinition {
  number: FormNumber;
  title: string;
  subtitle?: string;
  /** Paragraphs shown before the fields. `{signatory}` marks the inline name blank. */
  preamble: string[];
  fields: FormField[];
  /** Shown after the fields, before the signature block. */
  terms: string[];
  signatures: FormField[];
  hasPhoto: boolean;
}

export const FORM_1: ClosingFormDefinition = {
  number: 1,
  title: "MATERIAL SIGN-OFF",
  subtitle: "Authorization of Memorandum",
  preamble: [
    "I, {signatory}, have carefully reviewed and approved the specifications of the selected material and hereby authorize BUILDCO to proceed with the order, delivery, and purchase of said material.",
    "I understand that once an order has been placed, any changes to the approved material will result in a re-stocking fee charged by the supplier and an additional delivery or handling fee for re-delivery of the new material.",
  ],
  fields: [
    { key: "cf1_material_type", label: "Material Type", type: "text" },
    { key: "cf1_brand", label: "Brand", type: "text" },
    { key: "cf1_color", label: "Color", type: "text" },
    { key: "cf1_sku", label: "SKU", type: "text" },
  ],
  terms: [],
  signatures: [
    { key: "cf1_signature", label: "Signature", type: "text", signature: true },
    { key: "cf1_date", label: "Date", type: "date" },
  ],
  hasPhoto: true,
};

export const FORM_2: ClosingFormDefinition = {
  number: 2,
  title: "PROJECT SIGN-OFF",
  preamble: ["I have carefully assessed the specifications and deliverables for the repairs completed at:"],
  fields: [
    { key: "cf2_address", label: "Address", type: "text" },
    { key: "cf2_claim", label: "Claim Number", type: "text" },
  ],
  terms: [
    "By signing this document, I agree that the full scope of work has been completed to my satisfaction. Any return visits to address incomplete work will be billed at an extra cost of no less than $250 per day and be requested within 7 days of signing of this document. Return visits will ONLY be to complete work that was included in the original scope of work as detailed by the contract.",
    "Work outside of the original contract will require a new contract/ scope of work.",
  ],
  signatures: [
    { key: "cf2_owner_sig", label: "Home Owner Signature", type: "text", signature: true },
    { key: "cf2_owner_date", label: "Date", type: "date" },
    { key: "cf2_contractor_sig", label: "Contractor Signature", type: "text", signature: true },
    { key: "cf2_contractor_date", label: "Date", type: "date" },
  ],
  hasPhoto: false,
};

export const FORMS: Record<FormNumber, ClosingFormDefinition> = { 1: FORM_1, 2: FORM_2 };

/** The signatory's name is a blank inside form 1's first sentence, not a labelled field. */
export const SIGNATORY_KEY = "cf1_signatory";

/** Where the uploaded photo's object key is stored. The API validates its prefix. */
export const PHOTO_KEY = "material_photo_path";

/** Any stored form, as it comes back from the API. */
export type ClosingFormData = Record<string, unknown>;

export function fieldValue(data: ClosingFormData | null | undefined, key: string): string {
  const value = data?.[key];
  return typeof value === "string" ? value : "";
}

/** Every key a form may write, so nothing outside the definition is ever sent. */
export function allowedKeys(form: ClosingFormDefinition): string[] {
  const keys = [
    ...form.fields.map((field) => field.key),
    ...form.signatures.map((field) => field.key),
  ];
  if (form.number === 1) keys.push(SIGNATORY_KEY, PHOTO_KEY);
  return keys;
}

/**
 * Strip a draft down to the keys this form defines.
 *
 * `data` is opaque to the API, which means a typo in a key is stored rather than
 * rejected — and would then be invisible in every rendering. Filtering here is what
 * keeps the stored document and the definition in step.
 */
export function toWireData(
  form: ClosingFormDefinition,
  draft: ClosingFormData,
): ClosingFormData {
  const allowed = new Set(allowedKeys(form));
  const out: ClosingFormData = {};

  for (const [key, value] of Object.entries(draft)) {
    if (!allowed.has(key)) continue;
    if (typeof value === "string" && value.trim() === "") continue;
    out[key] = typeof value === "string" ? value.trim() : value;
  }

  return out;
}

/**
 * Whether a form carries enough to submit.
 *
 * A signature is the point of both documents, so it is the requirement. And the
 * backend's `bool(closing_form_1)` check means an object with nothing in it does not
 * count as submitted at all — the project would sit waiting for a form that had, as far
 * as anyone could tell, already been filled in.
 */
export function isComplete(form: ClosingFormDefinition, draft: ClosingFormData): boolean {
  const signatures = form.signatures.filter((field) => field.signature);
  return signatures.every((field) => fieldValue(draft, field.key).trim().length > 0);
}

/** Whether a stored form counts as submitted, matching the backend's own truthiness. */
export function isSubmitted(data: ClosingFormData | null | undefined): boolean {
  return data !== null && data !== undefined && Object.keys(data).length > 0;
}
