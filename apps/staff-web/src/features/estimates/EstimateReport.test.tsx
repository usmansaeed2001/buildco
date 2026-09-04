/**
 * The printable report, with the photos that used to be missing from it.
 *
 * `attachments` was fetched by the editor for the line-item thumbnails and simply never
 * passed through to this component, so every PDF the team has generated has been
 * text-only. These cover the wiring and the two cases where a photo deliberately does
 * not appear.
 */
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EstimateReport } from "./EstimateReport";
import { makeAttachment } from "@/test/factories";
import type { EstimateDetails, RoomDoc } from "./document";

const details: EstimateDetails = {
  project_name: "Storm damage",
  client_name: "Acme Insurance",
  insurance_carrier: "Acme",
  pm_name: "Casey Owner",
  notes: "",
};

const rooms: readonly RoomDoc[] = [
  {
    name: "Roof",
    items: [
      { name: "Shingles", category: "other", unit: "SF", quantity: "20", unitCost: "12.50", isCustom: false, notes: "", catalogueId: null },
      { name: "Underlay", category: "other", unit: "SF", quantity: "20", unitCost: "3.00", isCustom: false, notes: "", catalogueId: null },
    ],
  },
];

function renderReport(attachments: ReturnType<typeof makeAttachment>[] = []) {
  return render(
    <EstimateReport
      identifier="CLM-1"
      status="active"
      details={details}
      rooms={rooms}
      attachments={attachments}
      preparedOn="1 Mar 2026"
    />,
  );
}

describe("EstimateReport", () => {
  it("renders no photo section when there are no attachments", () => {
    renderReport();

    expect(screen.queryAllByRole("img")).toHaveLength(0);
  });

  it("puts a line item's photo in the report", () => {
    renderReport([makeAttachment({ url: "https://storage.test/roof.jpg" })]);

    expect(screen.getByRole("img")).toHaveAttribute("src", "https://storage.test/roof.jpg");
  });

  it("files each photo under the line item it belongs to", () => {
    renderReport([
      makeAttachment({ id: "a", item_index: 0, url: "https://storage.test/one.jpg" }),
      makeAttachment({ id: "b", item_index: 1, url: "https://storage.test/two.jpg" }),
    ]);

    const first = screen.getByText(/Shingles — 1 photo/).closest("td")!;
    expect(within(first).getByRole("img")).toHaveAttribute("src", "https://storage.test/one.jpg");
    const second = screen.getByText(/Underlay — 1 photo/).closest("td")!;
    expect(within(second).getByRole("img")).toHaveAttribute("src", "https://storage.test/two.jpg");
  });

  it("groups several photos under one item", () => {
    renderReport([
      makeAttachment({ id: "a", url: "https://storage.test/one.jpg" }),
      makeAttachment({ id: "b", url: "https://storage.test/two.jpg" }),
    ]);

    expect(screen.getByText(/Shingles — 2 photos/)).toBeVisible();
    expect(screen.getAllByRole("img")).toHaveLength(2);
  });

  it("lists a video by name rather than trying to render it", () => {
    renderReport([makeAttachment({ is_video: true, file_name: "walkthrough.mp4" })]);

    expect(screen.queryAllByRole("img")).toHaveLength(0);
    expect(screen.getByText("Attachments not shown")).toBeVisible();
    expect(screen.getByText(/walkthrough\.mp4 \(video\)/)).toBeVisible();
  });

  it("says so when a signed URL could not be minted, rather than showing a blank box", () => {
    // `create_download_url` returns None rather than raising, so the row arrives with a
    // null URL and no error. Silently dropping it would leave the reader wondering where
    // the photo went — this is `DEPLOY_CHECKLIST.md` §1.2 territory in production.
    renderReport([makeAttachment({ url: null, file_name: "roof.jpg" })]);

    expect(screen.queryAllByRole("img")).toHaveLength(0);
    expect(screen.getByText(/roof\.jpg \(unavailable\)/)).toBeVisible();
  });
});
