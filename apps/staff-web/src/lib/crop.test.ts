import { describe, expect, it } from "vitest";
import { MIN_CROP, initialCrop, moveCrop, resizeCrop } from "./crop";

describe("initialCrop", () => {
  it("is the largest centred square of a landscape photo", () => {
    expect(initialCrop(400, 200)).toEqual({ x: 100, y: 0, size: 200 });
  });

  it("is the largest centred square of a portrait photo", () => {
    expect(initialCrop(200, 400)).toEqual({ x: 0, y: 100, size: 200 });
  });

  it("is the whole of a square photo", () => {
    expect(initialCrop(300, 300)).toEqual({ x: 0, y: 0, size: 300 });
  });
});

describe("moveCrop", () => {
  const start = { x: 100, y: 100, size: 100 };

  it("moves by the distance dragged", () => {
    expect(moveCrop(start, 20, -30, 400, 400)).toEqual({ x: 120, y: 70, size: 100 });
  });

  it("stops at the left and top edges", () => {
    expect(moveCrop(start, -500, -500, 400, 400)).toEqual({ x: 0, y: 0, size: 100 });
  });

  it("stops at the right and bottom edges", () => {
    expect(moveCrop(start, 500, 500, 400, 400)).toEqual({ x: 300, y: 300, size: 100 });
  });

  it("never changes the size", () => {
    expect(moveCrop(start, 37, 11, 400, 400).size).toBe(100);
  });
});

describe("resizeCrop", () => {
  const start = { x: 100, y: 100, size: 100 };

  it("grows from the south-east corner with the north-west fixed", () => {
    expect(resizeCrop(start, "se", 40, 40, 400, 400)).toEqual({ x: 100, y: 100, size: 140 });
  });

  it("grows from the north-west corner with the south-east fixed", () => {
    expect(resizeCrop(start, "nw", -40, -40, 400, 400)).toEqual({ x: 60, y: 60, size: 140 });
  });

  it("grows from the north-east corner with the south-west fixed", () => {
    expect(resizeCrop(start, "ne", 40, -40, 400, 400)).toEqual({ x: 100, y: 60, size: 140 });
  });

  it("grows from the south-west corner with the north-east fixed", () => {
    expect(resizeCrop(start, "sw", -40, 40, 400, 400)).toEqual({ x: 60, y: 100, size: 140 });
  });

  it("shrinks when a corner is dragged inward", () => {
    expect(resizeCrop(start, "se", -30, -30, 400, 400)).toEqual({ x: 100, y: 100, size: 70 });
  });

  it("averages the two axes, so the square stays square", () => {
    expect(resizeCrop(start, "se", 60, 0, 400, 400).size).toBe(130);
  });

  it("stops growing at the nearest edge it would cross", () => {
    // From (100,100) there is 300px to the right but only 150px down.
    expect(resizeCrop(start, "se", 400, 400, 400, 250)).toEqual({ x: 100, y: 100, size: 150 });
    expect(resizeCrop(start, "nw", -400, -400, 400, 400)).toEqual({ x: 0, y: 0, size: 200 });
  });

  it("does not shrink below the minimum", () => {
    expect(resizeCrop(start, "se", -500, -500, 400, 400).size).toBe(MIN_CROP);
    expect(resizeCrop(start, "nw", 500, 500, 400, 400)).toEqual({
      x: 200 - MIN_CROP,
      y: 200 - MIN_CROP,
      size: MIN_CROP,
    });
  });

  it("allows a tiny image smaller than the minimum to be cropped whole", () => {
    expect(resizeCrop({ x: 0, y: 0, size: 20 }, "se", 10, 10, 20, 20)).toEqual({
      x: 0,
      y: 0,
      size: 20,
    });
  });
});
