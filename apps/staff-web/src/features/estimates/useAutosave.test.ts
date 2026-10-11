import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useAutosave } from "./useAutosave";

describe("useAutosave", () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => vi.useRealTimers());

  function setup(initial = { a: 1 }, options: { enabled?: boolean; delay?: number } = {}) {
    const save = vi.fn().mockResolvedValue(undefined);
    const view = renderHook(
      ({ value }) => useAutosave({ value, save, delay: options.delay ?? 1200, ...options }),
      { initialProps: { value: initial } },
    );
    return { save, ...view };
  }

  it("does not save the value it was mounted with", async () => {
    const { save } = setup();
    await act(async () => void vi.advanceTimersByTime(5000));
    expect(save).not.toHaveBeenCalled();
  });

  it("saves once after the debounce, not once per edit", async () => {
    const { save, rerender, result } = setup();

    rerender({ value: { a: 2 } });
    rerender({ value: { a: 3 } });
    rerender({ value: { a: 4 } });
    expect(result.current.state).toBe("pending");
    expect(save).not.toHaveBeenCalled();

    await act(async () => void vi.advanceTimersByTime(1200));

    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({ a: 4 });
    await waitFor(() => expect(result.current.state).toBe("saved"));
  });

  it("does not write when the value returns to what the server holds", async () => {
    const { save, rerender } = setup();

    rerender({ value: { a: 2 } });
    rerender({ value: { a: 1 } });
    await act(async () => void vi.advanceTimersByTime(1200));

    expect(save).not.toHaveBeenCalled();
  });

  it("surfaces a failed write instead of swallowing it", async () => {
    const save = vi.fn().mockRejectedValue(new Error("locked"));
    const { rerender, result } = renderHook(
      ({ value }) => useAutosave({ value, save, delay: 10 }),
      { initialProps: { value: { a: 1 } } },
    );

    rerender({ value: { a: 2 } });
    await act(async () => void vi.advanceTimersByTime(10));

    await waitFor(() => expect(result.current.state).toBe("error"));
    expect((result.current.error as Error).message).toBe("locked");
  });

  it("retries after a failure rather than treating the write as durable", async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValue(undefined);
    const { rerender, result } = renderHook(
      ({ value }) => useAutosave({ value, save, delay: 10 }),
      { initialProps: { value: { a: 1 } } },
    );

    rerender({ value: { a: 2 } });
    await act(async () => void vi.advanceTimersByTime(10));
    await waitFor(() => expect(result.current.state).toBe("error"));

    await act(async () => {
      await result.current.flush();
    });
    await waitFor(() => expect(result.current.state).toBe("saved"));
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("flush resolves only once the save has finished", async () => {
    let finish: () => void = () => {};
    const save = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const { rerender, result } = renderHook(
      ({ value }) => useAutosave({ value, save, delay: 1200 }),
      { initialProps: { value: { a: 1 } } },
    );
    rerender({ value: { a: 2 } });

    let settled = false;
    let flushing: Promise<void> = Promise.resolve();
    await act(async () => {
      flushing = result.current.flush().then(() => void (settled = true));
    });
    // The request has gone out and not come back. Returning here is the old behaviour,
    // which is what made "save, then change the status" a race.
    expect(save).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);

    await act(async () => {
      finish();
      await flushing;
    });
    expect(settled).toBe(true);
    expect(result.current.state).toBe("saved");
  });

  it("flush rejects when the save fails, with the save's own error", async () => {
    const save = vi.fn().mockRejectedValue(new Error("locked"));
    const { rerender, result } = renderHook(
      ({ value }) => useAutosave({ value, save, delay: 1200 }),
      { initialProps: { value: { a: 1 } } },
    );
    rerender({ value: { a: 2 } });

    let failure: unknown = null;
    await act(async () => {
      failure = await result.current.flush().catch((caught: unknown) => caught);
    });

    expect((failure as Error).message).toBe("locked");
    expect(result.current.state).toBe("error");
  });

  it("flush waits for a save that is already in flight", async () => {
    let finish: () => void = () => {};
    const save = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const { rerender, result } = renderHook(
      ({ value }) => useAutosave({ value, save, delay: 10 }),
      { initialProps: { value: { a: 1 } } },
    );
    rerender({ value: { a: 2 } });
    await act(async () => void vi.advanceTimersByTime(10));
    expect(save).toHaveBeenCalledTimes(1);

    let settled = false;
    let flushing: Promise<void> = Promise.resolve();
    await act(async () => {
      flushing = result.current.flush().then(() => void (settled = true));
    });
    // Nothing new to write, but the debounced write has not landed yet.
    expect(save).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);

    await act(async () => {
      finish();
      await flushing;
    });
    expect(settled).toBe(true);
  });

  it("reports whether there is anything unsaved", async () => {
    const { rerender, result } = setup();
    expect(result.current.isDirty()).toBe(false);

    rerender({ value: { a: 2 } });
    expect(result.current.isDirty()).toBe(true);

    await act(async () => {
      await result.current.flush();
    });
    expect(result.current.isDirty()).toBe(false);
  });

  it("flush commits immediately without waiting out the debounce", async () => {
    const { save, rerender, result } = setup();

    rerender({ value: { a: 2 } });
    await act(async () => {
      await result.current.flush();
    });

    expect(save).toHaveBeenCalledWith({ a: 2 });
  });

  it("flush is a no-op when nothing has changed", async () => {
    const { save, result } = setup();
    await act(async () => {
      await result.current.flush();
    });
    expect(save).not.toHaveBeenCalled();
  });

  it("commits the outstanding edit on unmount — the legacy version dropped it", async () => {
    const { save, rerender, unmount } = setup();

    rerender({ value: { a: 2 } });
    // Well inside the 1.2s window: the legacy scheduleSave lost this entirely.
    await act(async () => void vi.advanceTimersByTime(100));
    expect(save).not.toHaveBeenCalled();

    await act(async () => {
      unmount();
    });

    expect(save).toHaveBeenCalledWith({ a: 2 });
  });

  it("writes nothing at all when disabled", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const { rerender, unmount } = renderHook(
      ({ value }) => useAutosave({ value, save, delay: 10, enabled: false }),
      { initialProps: { value: { a: 1 } } },
    );

    rerender({ value: { a: 2 } });
    await act(async () => void vi.advanceTimersByTime(1000));
    await act(async () => {
      unmount();
    });

    expect(save).not.toHaveBeenCalled();
  });

  it("markSaved accepts a re-seeded value without writing it back", async () => {
    const { save, rerender, result } = setup();

    rerender({ value: { a: 99 } });
    act(() => result.current.markSaved());
    await act(async () => void vi.advanceTimersByTime(5000));

    expect(save).not.toHaveBeenCalled();
    expect(result.current.state).toBe("saved");
  });

  it("markSaved takes the value being seeded, before the hook has rendered with it", async () => {
    // A re-seed sets state and marks it saved in one go. At that moment the hook has
    // not yet been handed the new value, so "the current value" would be the old one.
    const { save, rerender, result } = setup();

    act(() => result.current.markSaved({ a: 99 }));
    rerender({ value: { a: 99 } });
    await act(async () => void vi.advanceTimersByTime(5000));

    expect(save).not.toHaveBeenCalled();
    expect(result.current.isDirty()).toBe(false);
  });
});
