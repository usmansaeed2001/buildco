/**
 * Preview the report, then save it as a PDF.
 *
 * The previewed node is the one that gets rasterised, so there is no second layout to
 * drift. It is scaled down visually with a CSS transform so the fixed 794px page fits
 * the modal; `downloadNodeAsPdf` lifts that transform for the duration of the capture,
 * because rasterising through it corrupts the text (see `suspendScaling`).
 */
import { useRef, useState } from "react";
import { Button } from "@/components/Button";
import { Modal } from "@/components/Modal";
import { Alert } from "@/components/feedback";
import { useToast } from "@/components/Toast";
import { downloadNodeAsPdf, reportFileName } from "@/lib/pdf";
import { EstimateReport, type ReportProps } from "./EstimateReport";

export function ReportModal({
  open,
  onClose,
  report,
}: {
  open: boolean;
  onClose: () => void;
  report: ReportProps;
}) {
  const toast = useToast();
  const node = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function download() {
    if (!node.current) return;
    setBusy(true);
    setFailure(null);

    try {
      const { pageCount, imagesOmitted } = await downloadNodeAsPdf(
        node.current,
        reportFileName(report.identifier),
      );
      const pages = `${pageCount} ${pageCount === 1 ? "page" : "pages"}`;

      if (imagesOmitted > 0) {
        // Not a success toast. The preview above showed these photos, so a plain
        // "saved" would leave the reader to discover the empty boxes themselves.
        setFailure(
          `Report saved — ${pages} — but ${imagesOmitted} ${
            imagesOmitted === 1 ? "photo could" : "photos could"
          } not be embedded and ${imagesOmitted === 1 ? "is" : "are"} blank in the PDF. ` +
            "The signed links may have expired; reopen the estimate and try again.",
        );
        return;
      }

      toast.success(`Report saved — ${pages}.`);
      onClose();
    } catch (caught) {
      // The legacy version caught nothing, so a rasterisation failure left the button
      // reading "Generating PDF…" indefinitely with no way to tell what happened.
      setFailure(
        caught instanceof Error
          ? `The PDF could not be generated: ${caught.message}`
          : "The PDF could not be generated.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Estimate report"
      description="This is exactly what the PDF will contain."
      size="xl"
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Close
          </Button>
          <Button variant="primary" busy={busy} onClick={() => void download()}>
            Download PDF
          </Button>
        </>
      }
    >
      {failure && (
        <div className="mb-3">
          <Alert tone="danger">{failure}</Alert>
        </div>
      )}

      <div className="overflow-x-auto bg-gray-100 p-3">
        {/* The report is a fixed 794px wide, so it is scaled to fit the modal. The
            capture lifts this transform rather than measuring through it. */}
        <div className="origin-top-left scale-[0.72]" style={{ width: 794, height: "auto" }}>
          <EstimateReport ref={node} {...report} />
        </div>
      </div>
    </Modal>
  );
}
