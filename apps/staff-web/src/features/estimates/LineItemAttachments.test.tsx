import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test/utils";
import { makeAttachment } from "@/test/factories";
import { server } from "@/test/msw/server";
import { apiError, url } from "@/test/msw/handlers";
import type { AttachmentOut } from "@/api/types";
import { LineItemAttachments } from "./LineItemAttachments";

const ESTIMATE_ID = "est-1";
/** A signed URL carries its signature in the query string. MSW matches on the path, so
 *  the handler is registered without it — the two constants are the same object key. */
const SIGNED_PATH = "https://storage.googleapis.com/bucket/est-1/0_0_123.png";
const SIGNED_URL = `${SIGNED_PATH}?X-Goog-Signature=x`;

const png = () => new File(["bytes"], "damage.png", { type: "image/png" });

/** The three-step upload, with every request recorded. */
function serveUpload({ putStatus = 200 }: { putStatus?: number } = {}) {
  const calls = {
    ticket: [] as Record<string, unknown>[],
    put: [] as { headers: Record<string, string>; auth: string | null }[],
    record: [] as Record<string, unknown>[],
  };

  server.use(
    http.post(url(`/estimates/${ESTIMATE_ID}/attachments/upload-url`), async ({ request }) => {
      calls.ticket.push((await request.json()) as Record<string, unknown>);
      return HttpResponse.json({
        upload_url: SIGNED_URL,
        storage_path: "est-1/0_0_123.png",
        required_headers: { "Content-Type": "image/png" },
        expires_in: 900,
      });
    }),
    http.put(SIGNED_PATH, ({ request }) => {
      calls.put.push({
        headers: Object.fromEntries(request.headers.entries()),
        auth: request.headers.get("Authorization"),
      });
      return new HttpResponse(null, { status: putStatus });
    }),
    http.post(url(`/estimates/${ESTIMATE_ID}/attachments`), async ({ request }) => {
      calls.record.push((await request.json()) as Record<string, unknown>);
      return HttpResponse.json(makeAttachment({ file_name: "damage.png" }));
    }),
  );

  return calls;
}

function renderPanel(attachments: AttachmentOut[] = [], readOnly = false) {
  return renderWithProviders(
    <LineItemAttachments
      estimateId={ESTIMATE_ID}
      roomIndex={0}
      itemIndex={0}
      attachments={attachments}
      readOnly={readOnly}
      label="Drywall"
    />,
  );
}

const picker = () => screen.getByLabelText("Add a photo or video to Drywall");

describe("LineItemAttachments", () => {
  describe("uploading", () => {
    it("mints a ticket, PUTs the bytes, then records the row", async () => {
      const calls = serveUpload();
      const { user } = renderPanel();

      await user.upload(picker(), png());

      await waitFor(() => expect(calls.record).toHaveLength(1));
      expect(calls.ticket[0]).toEqual({
        file_name: "damage.png",
        content_type: "image/png",
        room_index: 0,
        item_index: 0,
      });
      expect(calls.record[0]).toEqual({
        storage_path: "est-1/0_0_123.png",
        file_name: "damage.png",
        content_type: "image/png",
        room_index: 0,
        item_index: 0,
      });
    });

    it("sends no Authorization header to Cloud Storage", async () => {
      // The signed URL is a Google origin and the signature covers the request. An
      // Authorization header there is both wrong and a credential leak to a third party.
      const calls = serveUpload();
      const { user } = renderPanel();

      await user.upload(picker(), png());

      await waitFor(() => expect(calls.put).toHaveLength(1));
      expect(calls.put[0]!.auth).toBeNull();
    });

    it("sends exactly the Content-Type the signature was minted for", async () => {
      // The content type is baked into the V4 signature. Sending a different one — or
      // letting the browser choose — is a 403 from Google that explains nothing.
      const calls = serveUpload();
      const { user } = renderPanel();

      await user.upload(picker(), png());

      await waitFor(() => expect(calls.put).toHaveLength(1));
      expect(calls.put[0]!.headers["content-type"]).toBe("image/png");
    });

    it("falls back to octet-stream for a file with no detected type", async () => {
      // Only reachable by dropping: the picker carries `accept="image/*,video/*"`, so
      // a file the browser could not type is filtered out before it ever arrives.
      // A drop bypasses that filter, and the API requires a non-empty content type.
      const calls = serveUpload();
      renderPanel();

      fireEvent.drop(picker().closest("label")!, {
        dataTransfer: { files: [new File(["x"], "scan", { type: "" })] },
      });

      await waitFor(() => expect(calls.ticket).toHaveLength(1));
      expect(calls.ticket[0]!.content_type).toBe("application/octet-stream");
    });

    it("reports a rejected upload link rather than failing silently", async () => {
      serveUpload({ putStatus: 403 });
      const { user } = renderPanel();

      await user.upload(picker(), png());

      expect(await screen.findByText(/upload link was rejected/)).toBeVisible();
    });

    it("explains an unconfigured storage backend in its own terms", async () => {
      server.use(
        http.post(url(`/estimates/${ESTIMATE_ID}/attachments/upload-url`), () =>
          apiError(503, "integration_unavailable", "Cloud Storage is not configured."),
        ),
      );
      const { user } = renderPanel();

      await user.upload(picker(), png());

      expect(await screen.findByText(/File storage is not configured/)).toBeVisible();
      // The rest of the estimate is unaffected, and the message says so.
      expect(screen.getByText(/rest of the estimate is unaffected/)).toBeVisible();
    });

    it("stops after the first failure instead of firing the rest at a broken backend", async () => {
      const calls = serveUpload({ putStatus: 500 });
      const { user } = renderPanel();

      await user.upload(picker(), [png(), png(), png()]);

      await waitFor(() => expect(screen.getByRole("alert")).toBeVisible());
      expect(calls.put).toHaveLength(1);
    });
  });

  describe("showing what is attached", () => {
    it("renders a thumbnail for an image", async () => {
      renderPanel([makeAttachment({ file_name: "damage.png", url: SIGNED_URL })]);

      const thumb = await screen.findByRole("button", { name: "View damage.png" });
      expect(thumb.querySelector("img")).toHaveAttribute("src", SIGNED_URL);
    });

    it("opens an image in a viewer", async () => {
      const { user } = renderPanel([makeAttachment({ file_name: "damage.png", url: SIGNED_URL })]);

      await user.click(screen.getByRole("button", { name: "View damage.png" }));

      expect(screen.getByRole("heading", { name: "damage.png" })).toBeVisible();
      expect(screen.getByAltText("damage.png")).toBeVisible();
    });

    it("plays a video rather than showing it as a broken image", async () => {
      const { user } = renderPanel([
        makeAttachment({ file_name: "walkthrough.mp4", is_video: true, url: SIGNED_URL }),
      ]);

      await user.click(screen.getByRole("button", { name: "View walkthrough.mp4" }));

      const video = document.querySelector("video");
      expect(video).toHaveAttribute("src", SIGNED_URL);
      expect(video).toHaveAttribute("controls");
    });

    it("says the link is missing rather than showing a broken image", async () => {
      // This is the visible symptom of BACKLOG §2: the row and the file both exist,
      // but `create_download_url` caught a signing error and returned null. Rendering
      // an <img> with src={null} would look like a corrupt upload instead.
      const { user } = renderPanel([makeAttachment({ file_name: "damage.png", url: null })]);

      await user.click(screen.getByRole("button", { name: "View damage.png" }));

      expect(screen.getByText(/no download link/)).toBeVisible();
      expect(screen.queryByAltText("damage.png")).not.toBeInTheDocument();
    });
  });

  describe("deleting", () => {
    it("confirms first, then removes", async () => {
      let deleted: string | null = null;
      const attachment = makeAttachment({ file_name: "damage.png", url: SIGNED_URL });
      server.use(
        http.delete(url(`/attachments/${attachment.id}`), () => {
          deleted = attachment.id;
          return new HttpResponse(null, { status: 204 });
        }),
        http.get(url(`/estimates/${ESTIMATE_ID}/attachments`), () => HttpResponse.json([])),
      );

      const { user } = renderPanel([attachment]);

      await user.click(screen.getByRole("button", { name: "Delete damage.png" }));
      expect(deleted).toBeNull();

      await user.click(screen.getByRole("button", { name: /^Delete$/ }));
      await waitFor(() => expect(deleted).toBe(attachment.id));
    });
  });

  describe("read-only", () => {
    it("offers no picker and no delete", () => {
      renderPanel([makeAttachment({ file_name: "damage.png", url: SIGNED_URL })], true);

      expect(
        screen.queryByLabelText("Add a photo or video to Drywall"),
      ).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Delete damage.png" })).not.toBeInTheDocument();
      // Viewing is still allowed.
      expect(screen.getByRole("button", { name: "View damage.png" })).toBeVisible();
    });
  });
});
