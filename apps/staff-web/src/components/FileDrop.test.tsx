import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FileDrop } from "./FileDrop";

const png = () => new File(["x"], "photo.png", { type: "image/png" });
const mp4 = () => new File(["y"], "clip.mp4", { type: "video/mp4" });

/** The label is the accessible name of the file input inside it. */
const input = () => screen.getByLabelText("Add a photo") as HTMLInputElement;

describe("FileDrop", () => {
  it("reports the file chosen through the picker", async () => {
    const onFiles = vi.fn();
    const user = userEvent.setup();
    render(<FileDrop label="Add a photo" onFiles={onFiles} />);

    await user.upload(input(), png());

    expect(onFiles).toHaveBeenCalledTimes(1);
    expect(onFiles.mock.calls[0]![0]).toHaveLength(1);
    expect(onFiles.mock.calls[0]![0][0].name).toBe("photo.png");
  });

  it("keeps only the first file unless multiple is set", async () => {
    const onFiles = vi.fn();
    const user = userEvent.setup();
    render(<FileDrop label="Add a photo" onFiles={onFiles} />);

    await user.upload(input(), [png(), mp4()]);

    expect(onFiles.mock.calls[0]![0]).toHaveLength(1);
  });

  it("passes every file through when multiple is set", async () => {
    const onFiles = vi.fn();
    const user = userEvent.setup();
    render(<FileDrop label="Add a photo" multiple onFiles={onFiles} />);

    await user.upload(input(), [png(), mp4()]);

    expect(onFiles.mock.calls[0]![0]).toHaveLength(2);
  });

  it("clears the input so the same file can be picked again after a failed upload", async () => {
    const user = userEvent.setup();
    render(<FileDrop label="Add a photo" onFiles={() => {}} />);

    await user.upload(input(), png());

    expect(input().value).toBe("");
  });

  it("accepts a dropped file", () => {
    const onFiles = vi.fn();
    render(<FileDrop label="Add a photo" onFiles={onFiles} />);

    fireEvent.drop(input().closest("label")!, { dataTransfer: { files: [png()] } });

    expect(onFiles).toHaveBeenCalledTimes(1);
    expect(onFiles.mock.calls[0]![0][0].name).toBe("photo.png");
  });

  it("ignores a drop with no files, rather than reporting an empty selection", () => {
    const onFiles = vi.fn();
    render(<FileDrop label="Add a photo" onFiles={onFiles} />);

    fireEvent.drop(input().closest("label")!, { dataTransfer: { files: [] } });

    expect(onFiles).not.toHaveBeenCalled();
  });

  it("ignores a drop while disabled", () => {
    const onFiles = vi.fn();
    render(<FileDrop label="Add a photo" disabled onFiles={onFiles} />);

    fireEvent.drop(input().closest("label")!, { dataTransfer: { files: [png()] } });

    expect(onFiles).not.toHaveBeenCalled();
    expect(input()).toBeDisabled();
  });

  it("forwards accept to the input so the picker filters", () => {
    render(<FileDrop label="Add a photo" accept="image/*,video/*" onFiles={() => {}} />);
    expect(input()).toHaveAttribute("accept", "image/*,video/*");
  });

  it("renders the hint alongside the label", () => {
    render(<FileDrop label="Add a photo" hint="PNG or MP4, up to 25 MB" onFiles={() => {}} />);
    expect(screen.getByText("PNG or MP4, up to 25 MB")).toBeInTheDocument();
  });
});
