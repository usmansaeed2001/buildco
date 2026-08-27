import { afterEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test/utils";
import { server } from "@/test/msw/server";
import { apiError, url } from "@/test/msw/handlers";
import type { ParsedEstimate } from "@/api/types";
import { ParseNotesDrawer } from "./ParseNotesDrawer";
import type { RoomDoc } from "./document";

const PARSED: ParsedEstimate = {
  project_name: "Water damage",
  client_name: "Jordan",
  pm_name: "",
  insurance_carrier: "",
  notes: "",
  rooms: [
    {
      name: "Kitchen",
      items: [
        {
          name: "Drywall",
          category: "drywall",
          unit: "SF",
          quantity: "200",
          unitCost: "2.50",
          isCustom: true,
          catalogueId: null,
          notes: "",
        },
      ],
    },
  ],
};

function serveParse(body: ParsedEstimate = PARSED) {
  const requests: { notes: string }[] = [];
  server.use(
    http.post(url("/ai/parse-estimate"), async ({ request }) => {
      requests.push((await request.json()) as { notes: string });
      return HttpResponse.json(body);
    }),
  );
  return requests;
}

function renderDrawer({ hasExistingRooms = false } = {}) {
  const onApply = vi.fn<(rooms: RoomDoc[], mode: "append" | "replace") => void>();
  const onClose = vi.fn();
  const view = renderWithProviders(
    <ParseNotesDrawer
      open
      hasExistingRooms={hasExistingRooms}
      onApply={onApply}
      onClose={onClose}
    />,
  );
  return { ...view, onApply, onClose };
}

/** jsdom implements no speech API, so the mic is hidden unless one is installed. */
function installSpeech() {
  class FakeRecognition {
    static latest: FakeRecognition | null = null;
    lang = "";
    continuous = false;
    interimResults = false;
    stopped = false;
    onresult: ((event: unknown) => void) | null = null;
    onerror: ((event: { error: string }) => void) | null = null;
    onend: (() => void) | null = null;
    constructor() {
      FakeRecognition.latest = this;
    }
    start() {}
    stop() {
      this.stopped = true;
      this.onend?.();
    }
    abort() {}
    say(transcript: string) {
      this.onresult?.({
        resultIndex: 0,
        results: Object.assign([Object.assign([{ transcript }], { isFinal: true })], {
          length: 1,
        }),
      });
    }
  }
  (window as unknown as Record<string, unknown>).SpeechRecognition = FakeRecognition;
  return FakeRecognition;
}

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).SpeechRecognition;
});

describe("ParseNotesDrawer", () => {
  describe("parsing", () => {
    it("will not send empty notes", async () => {
      renderDrawer();
      expect(screen.getByRole("button", { name: "Parse notes" })).toBeDisabled();
    });

    it("sends the notes and previews what came back", async () => {
      const requests = serveParse();
      const { user } = renderDrawer();

      await user.type(screen.getByLabelText(/Site notes/), "Kitchen, 200 sf of drywall");
      await user.click(screen.getByRole("button", { name: "Parse notes" }));

      await waitFor(() => expect(requests).toHaveLength(1));
      expect(requests[0]!.notes).toBe("Kitchen, 200 sf of drywall");
      expect(await screen.findByText("Kitchen")).toBeVisible();
      expect(screen.getByText("Drywall")).toBeVisible();
      expect(screen.getByLabelText("Draft total")).toHaveTextContent("$500.00");
    });

    it("does not touch the estimate until the result is accepted", async () => {
      // The legacy drawer loaded the model's output straight into the editor, so
      // trying the parser destroyed whatever had already been priced.
      serveParse();
      const { user, onApply } = renderDrawer();

      await user.type(screen.getByLabelText(/Site notes/), "Kitchen");
      await user.click(screen.getByRole("button", { name: "Parse notes" }));
      await screen.findByText("Kitchen");

      expect(onApply).not.toHaveBeenCalled();
    });

    it("appends to an estimate that already has rooms", async () => {
      serveParse();
      const { user, onApply, onClose } = renderDrawer({ hasExistingRooms: true });

      await user.type(screen.getByLabelText(/Site notes/), "Kitchen");
      await user.click(screen.getByRole("button", { name: "Parse notes" }));
      await user.click(await screen.findByRole("button", { name: "Add to this estimate" }));

      expect(onApply).toHaveBeenCalledTimes(1);
      expect(onApply.mock.calls[0]![1]).toBe("append");
      expect(onApply.mock.calls[0]![0][0]!.name).toBe("Kitchen");
      expect(onClose).toHaveBeenCalled();
    });

    it("confirms before replacing an estimate that already has rooms", async () => {
      serveParse();
      const { user, onApply } = renderDrawer({ hasExistingRooms: true });

      await user.type(screen.getByLabelText(/Site notes/), "Kitchen");
      await user.click(screen.getByRole("button", { name: "Parse notes" }));
      await user.click(await screen.findByRole("button", { name: "Replace everything" }));
      expect(onApply).not.toHaveBeenCalled();

      await user.click(screen.getAllByRole("button", { name: "Replace everything" })[1]!);
      expect(onApply.mock.calls[0]![1]).toBe("replace");
    });

    it("offers no replace option on an empty estimate", async () => {
      serveParse();
      const { user } = renderDrawer({ hasExistingRooms: false });

      await user.type(screen.getByLabelText(/Site notes/), "Kitchen");
      await user.click(screen.getByRole("button", { name: "Parse notes" }));

      expect(await screen.findByRole("button", { name: "Use these rooms" })).toBeVisible();
      expect(screen.queryByRole("button", { name: "Replace everything" })).not.toBeInTheDocument();
    });

    it("can go back to the notes to try again", async () => {
      serveParse();
      const { user } = renderDrawer();

      await user.type(screen.getByLabelText(/Site notes/), "Kitchen");
      await user.click(screen.getByRole("button", { name: "Parse notes" }));
      await user.click(await screen.findByRole("button", { name: "Back to notes" }));

      expect(screen.getByLabelText(/Site notes/)).toHaveValue("Kitchen");
    });
  });

  describe("failures", () => {
    it("says the parser is unconfigured rather than showing a raw 503", async () => {
      server.use(
        http.post(url("/ai/parse-estimate"), () =>
          apiError(503, "integration_unavailable", "GROQ_API_KEY is not set."),
        ),
      );
      const { user } = renderDrawer();

      await user.type(screen.getByLabelText(/Site notes/), "Kitchen");
      await user.click(screen.getByRole("button", { name: "Parse notes" }));

      expect(await screen.findByText(/not configured on this environment/)).toBeVisible();
      // And says what the user can still do.
      expect(screen.getByText(/add rooms and items by hand/)).toBeVisible();
    });

    it("explains a 422 as notes the model could not read", async () => {
      // ParsedEstimate requires at least one room; that guardrail is what keeps a
      // hallucination out of someone's document, and it surfaces here as a 422.
      server.use(
        http.post(url("/ai/parse-estimate"), () =>
          apiError(422, "validation_failed", "Could not extract any rooms."),
        ),
      );
      const { user } = renderDrawer();

      await user.type(screen.getByLabelText(/Site notes/), "asdf");
      await user.click(screen.getByRole("button", { name: "Parse notes" }));

      expect(await screen.findByText(/No rooms could be found/)).toBeVisible();
    });
  });

  describe("dictation", () => {
    it("is hidden where the browser cannot do it", () => {
      renderDrawer();

      expect(screen.queryByRole("button", { name: "Dictate" })).not.toBeInTheDocument();
      expect(screen.getByText(/Dictation needs Chrome or Edge/)).toBeVisible();
    });

    it("appends a finalised phrase to the notes", async () => {
      const Recognition = installSpeech();
      const { user } = renderDrawer();

      await user.type(screen.getByLabelText(/Site notes/), "Kitchen:");
      await user.click(screen.getByRole("button", { name: "Dictate" }));
      Recognition.latest!.say("two coats of paint");

      await waitFor(() =>
        expect(screen.getByLabelText(/Site notes/)).toHaveValue("Kitchen: two coats of paint"),
      );
    });

    it("stops when asked, and offers to start again", async () => {
      const Recognition = installSpeech();
      const { user } = renderDrawer();

      await user.click(screen.getByRole("button", { name: "Dictate" }));
      expect(screen.getByRole("button", { name: "Stop dictating" })).toBeVisible();

      await user.click(screen.getByRole("button", { name: "Stop dictating" }));

      expect(Recognition.latest!.stopped).toBe(true);
      expect(await screen.findByRole("button", { name: "Dictate" })).toBeVisible();
    });

    it("switches language, and does not leave a session running in the old one", async () => {
      const Recognition = installSpeech();
      const { user } = renderDrawer();

      await user.click(screen.getByRole("button", { name: "Dictate" }));
      const first = Recognition.latest!;
      expect(first.lang).toBe("en-US");

      await user.click(screen.getByRole("button", { name: "ES" }));

      expect(first.stopped).toBe(true);
      await user.click(await screen.findByRole("button", { name: "Dictate" }));
      expect(Recognition.latest!.lang).toBe("es-ES");
    });

    it("reports a denied microphone", async () => {
      const Recognition = installSpeech();
      const { user } = renderDrawer();

      await user.click(screen.getByRole("button", { name: "Dictate" }));
      Recognition.latest!.onerror?.({ error: "not-allowed" });

      expect(await screen.findByText(/Microphone access was denied/)).toBeVisible();
    });
  });
});
