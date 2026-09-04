/**
 * Which page numbers the pager offers.
 *
 * Tested as a pure function rather than through the DOM: the interesting cases are the
 * boundaries — a two-page list, the current page sitting at either end, a single missing
 * page — and reaching each of those by clicking through a rendered list would be slow and
 * would obscure what is actually being asserted.
 */
import { describe, expect, it } from "vitest";
import { pageRange } from "./Pagination";

describe("pageRange", () => {
  it("lists every page when they all fit", () => {
    expect(pageRange(1, 3)).toEqual([1, 2, 3]);
  });

  it("handles a two-page list", () => {
    expect(pageRange(2, 2)).toEqual([1, 2]);
  });

  it("always offers the first and last page", () => {
    // However long the list, both ends stay one click away.
    const range = pageRange(10, 20);
    expect(range[0]).toBe(1);
    expect(range.at(-1)).toBe(20);
  });

  it("keeps the current page and its neighbours", () => {
    expect(pageRange(10, 20)).toContain(9);
    expect(pageRange(10, 20)).toContain(10);
    expect(pageRange(10, 20)).toContain(11);
  });

  it("collapses the middle rather than growing a row of twenty buttons", () => {
    expect(pageRange(10, 20)).toEqual([1, null, 9, 10, 11, null, 20]);
  });

  it("draws a lone missing page instead of eliding it", () => {
    // An ellipsis would be no narrower than the number and would cost a click.
    expect(pageRange(3, 5)).toEqual([1, 2, 3, 4, 5]);
  });

  it("does not open a gap at the start when the current page is near it", () => {
    expect(pageRange(2, 10)).toEqual([1, 2, 3, null, 10]);
  });

  it("does not open a gap at the end when the current page is near it", () => {
    expect(pageRange(9, 10)).toEqual([1, null, 8, 9, 10]);
  });

  it("never repeats a page", () => {
    const range = pageRange(1, 10).filter((page): page is number => page !== null);
    expect(new Set(range).size).toBe(range.length);
  });
});
