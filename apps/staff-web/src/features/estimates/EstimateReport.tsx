/**
 * The printable estimate report.
 *
 * Rendered on screen inside a modal so it can be checked before download, and the same
 * node is what `downloadNodeAsPdf` rasterises — so what is previewed is exactly what is
 * saved. The legacy version built a separate HTML string for the PDF, which drifted
 * from the preview whenever either changed.
 *
 * Deliberately plain: fixed widths in pixels, no Tailwind responsive utilities, black on
 * white. html2canvas-pro rasterises at whatever size the node happens to be, so a layout
 * that reflows with the viewport produces a different PDF on a laptop than on a
 * desktop.
 */
import { forwardRef } from "react";
import { computeTotals, roomTotal } from "@/domain/estimateTotals";
import { formatMoney, lineTotal } from "@/domain/money";
import { ESTIMATE_STATUS_LABELS, type EstimateStatus } from "@/domain/enums";
import { formatDate } from "@/lib/format";
import type { AttachmentOut } from "@/api/types";
import type { EstimateDetails, RoomDoc } from "./document";

export interface ReportProps {
  identifier: string;
  status: EstimateStatus;
  details: EstimateDetails;
  rooms: readonly RoomDoc[];
  attachments?: readonly AttachmentOut[];
  preparedOn?: string;
}

/**
 * Photos for one line item, keyed by position.
 *
 * Position, not identity, because that is how the API addresses attachments —
 * `room_index` and `item_index` are plain integers, not foreign keys. Reordering or
 * deleting a room does not move its photos, so a report generated after an edit can show
 * a photo under the wrong line. That is `BACKLOG.md` §14, it predates this component, and
 * putting the photos in the PDF makes it visible and printable rather than causing it.
 */
function photosByPosition(
  attachments: readonly AttachmentOut[],
): Map<string, AttachmentOut[]> {
  const byPosition = new Map<string, AttachmentOut[]>();
  for (const attachment of attachments) {
    // A video cannot be rasterised into a page, and a null URL means the signed link
    // could not be minted — `create_download_url` returns None rather than raising, so
    // the row exists with nothing to show. Both are skipped here and counted below, so
    // the reader is told rather than left wondering what happened to the photo.
    if (attachment.is_video || !attachment.url) continue;
    const key = `${attachment.room_index}:${attachment.item_index}`;
    const bucket = byPosition.get(key);
    if (bucket) bucket.push(attachment);
    else byPosition.set(key, [attachment]);
  }
  return byPosition;
}

export const EstimateReport = forwardRef<HTMLDivElement, ReportProps>(function EstimateReport(
  { identifier, status, details, rooms, attachments = [], preparedOn },
  ref,
) {
  const totals = computeTotals(rooms);
  const photos = photosByPosition(attachments);
  const omitted = attachments.filter((a) => a.is_video || !a.url);

  return (
    <div
      ref={ref}
      // 794px is A4 at 96dpi. Fixing it means the rasterised bitmap has the same aspect
      // ratio as the page it is about to be sliced into, whatever the window is doing.
      style={{ width: 794, background: "#ffffff", color: "#111827", padding: 32 }}
      className="font-sans text-sm"
    >
      <header
        style={{ borderBottom: "2px solid #111827", paddingBottom: 16, marginBottom: 20 }}
        className="flex items-start justify-between"
      >
        <div>
          <p className="font-display text-2xl font-bold">BuildCo</p>
          <p className="text-xs text-gray-500">LA Handy Construction</p>
        </div>
        <div className="text-right text-xs text-gray-600">
          <p className="font-mono text-sm text-gray-900">{identifier}</p>
          <p>{ESTIMATE_STATUS_LABELS[status]}</p>
          <p>Prepared {preparedOn ?? formatDate(new Date().toISOString())}</p>
        </div>
      </header>

      <h1 className="text-xl font-semibold">{details.project_name || "Untitled estimate"}</h1>

      <dl className="mt-4 grid grid-cols-2 gap-x-8 gap-y-2 text-xs">
        <Row term="Client" value={details.client_name} />
        <Row term="Insurance carrier" value={details.insurance_carrier} />
        <Row term="Project manager" value={details.pm_name} />
        <Row term="Claim ID" value={identifier} />
      </dl>

      {details.notes.trim() && (
        <section style={{ marginTop: 20 }}>
          <h2 className="text-xs font-semibold tracking-wide text-gray-500 uppercase">Notes</h2>
          <p className="mt-1 whitespace-pre-wrap text-xs text-gray-700">{details.notes}</p>
        </section>
      )}

      <section style={{ marginTop: 24 }} className="flex flex-col gap-5">
        {rooms.length === 0 && (
          <p className="text-xs text-gray-500">This estimate has no rooms.</p>
        )}

        {rooms.map((room, index) => (
          // `break-inside: avoid` does nothing for html2canvas-pro — it rasterises one
          // bitmap and the slicing is purely geometric. A room can and will be split
          // across a page boundary; that is a known limitation of this approach.
          <div key={index}>
            <h2 className="text-sm font-semibold">{room.name || "Untitled room"}</h2>
            <table style={{ width: "100%", marginTop: 6, borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid #d1d5db" }}>
                  <Th style={{ width: "40%" }}>Item</Th>
                  <Th style={{ width: "12%" }}>Unit</Th>
                  <Th style={{ width: "12%" }} numeric>
                    Qty
                  </Th>
                  <Th style={{ width: "18%" }} numeric>
                    Unit cost
                  </Th>
                  <Th style={{ width: "18%" }} numeric>
                    Total
                  </Th>
                </tr>
              </thead>
              <tbody>
                {room.items.map((item, itemIndex) => (
                  <tr key={itemIndex} style={{ borderBottom: "1px solid #f3f4f6" }}>
                    <Td>
                      {item.name || "Untitled item"}
                      {item.notes.trim() && (
                        <span className="block text-[10px] text-gray-500">{item.notes}</span>
                      )}
                    </Td>
                    <Td>{item.unit}</Td>
                    <Td numeric>{item.quantity}</Td>
                    <Td numeric>{formatMoney(item.unitCost)}</Td>
                    <Td numeric>{formatMoney(lineTotal(item.quantity, item.unitCost))}</Td>
                  </tr>
                ))}
                {room.items.map((item, itemIndex) => {
                  const shots = photos.get(`${index}:${itemIndex}`);
                  if (!shots?.length) return null;
                  return (
                    <tr key={`photos-${itemIndex}`}>
                      <Td colSpan={5}>
                        <span className="mb-1 block text-[10px] text-gray-500">
                          {item.name || "Untitled item"} — {shots.length}{" "}
                          {shots.length === 1 ? "photo" : "photos"}
                        </span>
                        <span className="flex flex-wrap gap-2">
                          {shots.map((shot) => (
                            <img
                              key={shot.id}
                              src={shot.url ?? ""}
                              // Real alt text, not `alt=""`. The PDF is a bitmap so it
                              // gains nothing there, but this same node is the on-screen
                              // preview, and these photos are evidence for a line item —
                              // content, not decoration.
                              alt={`${item.name || "Untitled item"} — ${shot.file_name}`}
                              // Sized in pixels for the same reason the page is: the
                              // rasteriser measures the box, so a responsive width would
                              // put a different photo size in the PDF on every screen.
                              style={{
                                width: 150,
                                height: 110,
                                objectFit: "cover",
                                border: "1px solid #e5e7eb",
                              }}
                            />
                          ))}
                        </span>
                      </Td>
                    </tr>
                  );
                })}
                {room.items.length === 0 && (
                  <tr>
                    <Td colSpan={5}>
                      <span className="text-gray-400">No line items</span>
                    </Td>
                  </tr>
                )}
              </tbody>
              <tfoot>
                <tr>
                  <Td colSpan={4} numeric>
                    <span className="text-gray-500">Subtotal</span>
                  </Td>
                  <Td numeric>
                    <span className="font-semibold">{formatMoney(roomTotal(room))}</span>
                  </Td>
                </tr>
              </tfoot>
            </table>
          </div>
        ))}
      </section>

      <div
        style={{ marginTop: 28, borderTop: "2px solid #111827", paddingTop: 12 }}
        className="flex items-baseline justify-between"
      >
        <span className="text-sm text-gray-600">
          {totals.roomCount} {totals.roomCount === 1 ? "room" : "rooms"} · {totals.itemCount}{" "}
          {totals.itemCount === 1 ? "item" : "items"}
        </span>
        <span className="text-xl font-bold">{formatMoney(totals.total)}</span>
      </div>

      {omitted.length > 0 && (
        <section style={{ marginTop: 16 }}>
          <h2 className="text-[10px] font-semibold tracking-wide text-gray-500 uppercase">
            Attachments not shown
          </h2>
          <ul className="mt-1 text-[10px] text-gray-500">
            {omitted.map((attachment) => (
              <li key={attachment.id}>
                {attachment.file_name}
                {attachment.is_video ? " (video)" : " (unavailable)"}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
});

function Row({ term, value }: { term: string; value: string }) {
  return (
    <div>
      <dt className="text-gray-500">{term}</dt>
      <dd className="text-gray-900">{value || "—"}</dd>
    </div>
  );
}

function Th({
  children,
  numeric,
  style,
}: {
  children: React.ReactNode;
  numeric?: boolean;
  style?: React.CSSProperties;
}) {
  return (
    <th
      style={{ padding: "4px 6px", textAlign: numeric ? "right" : "left", ...style }}
      className="text-[10px] font-semibold tracking-wide text-gray-500 uppercase"
    >
      {children}
    </th>
  );
}

function Td({
  children,
  numeric,
  colSpan,
}: {
  children: React.ReactNode;
  numeric?: boolean;
  colSpan?: number;
}) {
  return (
    <td
      colSpan={colSpan}
      style={{ padding: "4px 6px", textAlign: numeric ? "right" : "left" }}
      className="text-xs"
    >
      {children}
    </td>
  );
}
