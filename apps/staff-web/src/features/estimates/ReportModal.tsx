/**
 * Preview the report, then save it as a PDF.
 *
 * The previewed node is the one that gets rasterised, so there is no second layout to
 * drift. It is scaled down visually with a CSS transform — which html2canvas-pro ignores,
 * because it reads geometry from the element's own box rather than from its rendered
 * appearance.
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
      const { pageCount } = await downloadNodeAsPdf(
        node.current,
        reportFileName(report.identifier),
      );
      toast.success(`Report saved — ${pageCount} ${pageCount === 1 ? "page" : "pages"}.`);
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
        {/* The report is a fixed 794px wide. Scaling it visually keeps it inside the
            modal without changing the geometry html2canvas-pro measures. */}
        <div className="origin-top-left scale-[0.72]" style={{ width: 794, height: "auto" }}>
          <EstimateReport ref={node} {...report} />
        </div>
      </div>
    </Modal>
  );
}
