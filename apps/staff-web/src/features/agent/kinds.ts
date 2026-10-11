/**
 * The kinds of change the assistant can propose, as the panel names them, and where the
 * record each one saves can be opened. Mirrors `agent_rules.KINDS` on the API.
 */
import type { Target } from "./protocol";

export const KIND_TITLES: Record<string, string> = {
  "meeting.create": "New meeting",
  "meeting.update": "Change to a meeting",
  "supplement.create": "New supplement",
  "supplement.update_details": "Change to a supplement's details",
  "supplement.transition": "Change to a supplement's status",
  "supplement.submit": "Send a supplement for review",
  "memory.change": "Change to what I remember",
};

/** Where in the app a saved record lives. */
export function linkTo(target: Target | null | undefined): string | null {
  if (!target) return null;
  if (target.type === "supplement") return `/estimates/${target.id}`;
  if (target.type === "meeting") return "/calendar";
  if (target.type === "memory") return "/profile";
  return null;
}
