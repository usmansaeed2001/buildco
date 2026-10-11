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
import { Button } from "@/components/Button";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Alert, Card } from "@/components/feedback";
import { useToast } from "@/components/Toast";

const CATEGORIES: Record<string, string> = {
  identity: "About you",
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
        <h2 className="text-xs font-medium tracking-wide text-gray-500 uppercase">
          What the assistant remembers
        </h2>
        <p className="mt-1 text-sm text-gray-600">
          Things you have told BuildCo Assistant about yourself and how you work. Only you can
          see these. It can remember only what you said yourself.
        </p>
      </div>

      {memories.error && <Alert tone="danger">Your memories could not be loaded.</Alert>}
      {!memories.error && rows.length === 0 && (
        <p className="text-sm text-gray-500">Nothing yet.</p>
      )}

      {rows.length > 0 && (
        <ul className="flex flex-col divide-y divide-gray-100">
          {rows.map((memory) => (
            <li key={memory.id} className="flex items-start justify-between gap-4 py-3">
              <div className="min-w-0">
                <p className="text-sm text-gray-900">{memory.content}</p>
                <p className="mt-0.5 text-xs text-gray-500">
                  {CATEGORIES[memory.category] ?? memory.category}
                  {" · saved "}
                  {SAVED.format(new Date(memory.created_at))}
                  {memory.source === "inferred" ? " · noticed, not asked for" : ""}
                </p>
                <p className="mt-1 text-xs text-gray-500">
                  From your words: <q>{memory.evidence}</q>
                </p>
              </div>
              <Button
                size="sm"
                aria-label={`Delete memory: ${memory.content}`}
                onClick={() => setDeleting(memory)}
              >
                Delete
              </Button>
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
