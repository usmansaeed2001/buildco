import { describe, expect, it } from "vitest";
import {
  allowedKeys,
  fieldValue,
  FORM_1,
  FORM_2,
  isComplete,
  isSubmitted,
  PHOTO_KEY,
  SIGNATORY_KEY,
  toWireData,
} from "./closingForms";

describe("form definitions", () => {
  it("keeps the legacy field keys, so forms the old app saved still render", () => {
    expect(FORM_1.fields.map((f) => f.key)).toEqual([
      "cf1_material_type",
      "cf1_brand",
      "cf1_color",
      "cf1_sku",
    ]);
    expect(FORM_2.fields.map((f) => f.key)).toEqual(["cf2_address", "cf2_claim"]);
    expect(FORM_2.signatures.map((f) => f.key)).toEqual([
      "cf2_owner_sig",
      "cf2_owner_date",
      "cf2_contractor_sig",
      "cf2_contractor_date",
    ]);
  });

  it("reproduces the legal wording verbatim", () => {
    // These are signed documents. A form whose text differs from the one that was
    // signed is worse than no form at all.
    expect(FORM_2.terms[0]).toContain("no less than $250 per day");
    expect(FORM_2.terms[0]).toContain("within 7 days of signing");
    expect(FORM_2.terms[1]).toBe(
      "Work outside of the original contract will require a new contract/ scope of work.",
    );
    expect(FORM_1.preamble[1]).toContain("re-stocking fee charged by the supplier");
  });

  it("only form 1 takes a photo", () => {
    expect(FORM_1.hasPhoto).toBe(true);
    expect(FORM_2.hasPhoto).toBe(false);
  });
});

describe("allowedKeys", () => {
  it("includes the signatory blank and the photo path for form 1", () => {
    expect(allowedKeys(FORM_1)).toContain(SIGNATORY_KEY);
    expect(allowedKeys(FORM_1)).toContain(PHOTO_KEY);
  });

  it("does not offer them on form 2", () => {
    expect(allowedKeys(FORM_2)).not.toContain(SIGNATORY_KEY);
    expect(allowedKeys(FORM_2)).not.toContain(PHOTO_KEY);
  });
});

describe("toWireData", () => {
  it("keeps only the keys the form defines", () => {
    // `data` is opaque to the API, so a stray key is stored rather than rejected —
    // and would then be invisible in every rendering.
    const wire = toWireData(FORM_1, {
      cf1_brand: "Mohawk",
      cf1_signature: "Jordan",
      somethingElse: "should not survive",
      cf2_address: "wrong form",
    });

    expect(wire).toEqual({ cf1_brand: "Mohawk", cf1_signature: "Jordan" });
  });

  it("drops blank fields rather than storing empty strings", () => {
    const wire = toWireData(FORM_1, { cf1_brand: "", cf1_color: "   ", cf1_sku: "X1" });
    expect(wire).toEqual({ cf1_sku: "X1" });
  });

  it("trims what it keeps", () => {
    expect(toWireData(FORM_1, { cf1_brand: "  Mohawk  " })).toEqual({ cf1_brand: "Mohawk" });
  });

  it("carries the photo path through untouched", () => {
    const path = "projects/p1/closing-forms/1_123.png";
    expect(toWireData(FORM_1, { [PHOTO_KEY]: path })).toEqual({ [PHOTO_KEY]: path });
  });

  it("produces an empty object for an untouched form", () => {
    // Which the submit button must refuse — see isComplete.
    expect(toWireData(FORM_1, {})).toEqual({});
  });
});

describe("isComplete", () => {
  it("requires a signature on form 1", () => {
    expect(isComplete(FORM_1, { cf1_brand: "Mohawk" })).toBe(false);
    expect(isComplete(FORM_1, { cf1_signature: "Jordan Homeowner" })).toBe(true);
  });

  it("requires both signatures on form 2", () => {
    expect(isComplete(FORM_2, { cf2_owner_sig: "Jordan" })).toBe(false);
    expect(isComplete(FORM_2, { cf2_owner_sig: "Jordan", cf2_contractor_sig: "Casey" })).toBe(
      true,
    );
  });

  it("does not accept whitespace as a signature", () => {
    expect(isComplete(FORM_1, { cf1_signature: "   " })).toBe(false);
  });

  it("does not treat a date as a signature", () => {
    expect(isComplete(FORM_1, { cf1_date: "2026-03-01" })).toBe(false);
  });
});

describe("isSubmitted", () => {
  it("matches the backend's own truthiness check", () => {
    // `bool(project.closing_form_1)` server-side: an empty object is NOT submitted, so
    // a form saved with every field blank would leave the project stuck waiting for a
    // document that appears to have been filled in.
    expect(isSubmitted(null)).toBe(false);
    expect(isSubmitted(undefined)).toBe(false);
    expect(isSubmitted({})).toBe(false);
    expect(isSubmitted({ cf1_signature: "Jordan" })).toBe(true);
  });
});

describe("fieldValue", () => {
  it("returns a string for anything, so a legacy row cannot break rendering", () => {
    expect(fieldValue({ a: "x" }, "a")).toBe("x");
    expect(fieldValue({ a: 42 }, "a")).toBe("");
    expect(fieldValue(null, "a")).toBe("");
    expect(fieldValue({}, "missing")).toBe("");
  });
});
