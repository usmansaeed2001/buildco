/**
 * "What the assistant remembers": every memory it holds about the signed-in person, with
 * the words of theirs it was based on, and a way to delete each one.
 *
 * Shown on the Profile page. A person sees and deletes only their own; nobody else,
 * owners and admins included, can see what the assistant remembers about someone.
 *
 * The evidence is shown because it is the answer to "why does it think that": a memory
 * can only be made from something the person said or typed, and this is what they said.
 */
import { useState } from "react";
import { ApiError } from "@/api/client";
import { useAgentMemories, useAgentStatus, useDeleteAgentMemory } from "@/api/queries/agent";
import type { AgentMemoryOut } from "@/api/types";
import { Badge } from "@/components/Badge";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Alert, Card } from "@/components/feedback";
import { useToast } from "@/components/Toast";
import { TrashIcon } from "./icons";
import { Orb } from "./Orb";

const CATEGORIES: Record<string, string> = {
  identity: "Identity",
  preference: "Preference",
  work_habit: "Work habit",
};

const SAVED = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" });

export function AgentMemories() {
  const status = useAgentStatus();
  const memories = useAgentMemories();
  const remove = useDeleteAgentMemory();
  const toast = useToast();
  const [deleting, setDeleting] = useState<AgentMemoryOut | null>(null);

  const rows = memories.data ?? [];
  // Nothing to show to someone who has never been offered the assistant. Someone who
  // was, and has memories, keeps the means to delete them even if it is switched off.
  if (status.data?.enabled !== true && rows.length === 0) return null;

  async function confirm() {
    if (!deleting) return;
    try {
      await remove.mutateAsync(deleting.id);
      setDeleting(null);
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : "That could not be deleted.");
    }
  }

  return (
    <Card className="flex flex-col gap-4 p-5">
      <div>
        <h2 className="flex items-center gap-2 text-xs font-medium tracking-wide text-gray-500 uppercase">
          <Orb size={20} />
          What the assistant remembers
        </h2>
        <p className="mt-1.5 text-sm text-gray-600">
          Things you have told BuildCo Assistant about yourself and how you work. Only you can
          see these. It can remember only what you said yourself.
        </p>
      </div>

      {memories.error && <Alert tone="danger">Your memories could not be loaded.</Alert>}
      {!memories.error && rows.length === 0 && (
        <p className="rounded-card border border-dashed border-gray-200 px-4 py-5 text-center text-sm text-gray-500">
          Nothing yet. When you tell the assistant your name, a preference or how you usually
          work, it is listed here with the words it came from.
        </p>
      )}

      {rows.length > 0 && (
        <ul className="flex flex-col divide-y divide-gray-100">
          {rows.map((memory) => (
            <li key={memory.id} className="flex items-start justify-between gap-3 py-3">
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-gray-500">
                  <Badge>{CATEGORIES[memory.category] ?? memory.category}</Badge>
                  <span>Saved {SAVED.format(new Date(memory.created_at))}</span>
                  {memory.source === "inferred" && <span>· noticed, not asked for</span>}
                </p>
                <p className="mt-1.5 text-sm text-gray-900">{memory.content}</p>
                <p className="mt-1 text-xs text-gray-500">
                  From your words: <q>{memory.evidence}</q>
                </p>
              </div>
              <button
                type="button"
                aria-label={`Delete memory: ${memory.content}`}
                onClick={() => setDeleting(memory)}
                className="-mt-1 -mr-2 grid size-11 shrink-0 place-items-center rounded-full text-gray-400 transition-colors hover:bg-gray-100 hover:text-danger-600 dark:hover:text-danger-400"
              >
                <TrashIcon />
              </button>
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={deleting !== null}
        title="Delete this memory?"
        confirmLabel="Delete"
        busy={remove.isPending}
        onConfirm={() => void confirm()}
        onCancel={() => setDeleting(null)}
      >
        <p className="text-sm text-gray-700">
          The assistant will no longer know this: <q>{deleting?.content}</q>
        </p>
      </ConfirmDialog>
    </Card>
  );
}
