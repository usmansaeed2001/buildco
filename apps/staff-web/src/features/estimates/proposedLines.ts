/**
 * Lines the assistant proposed, in the editor's own shape, for the user to add by hand
 * after taking a proposal over with Stop.
 */
import type { ProposalLabels } from "@/features/agent/protocol";
import { readRooms, type LineItemDoc } from "./document";

/** One line to add by hand after Stop, and where it goes. */
export interface LineToAdd {
  /** Its room's position, for a room that is already there. */
  roomIndex: number;
  room: string;
  newRoom: boolean;
  item: LineItemDoc;
}

/**
 * The proposed lines in the editor's own shape, taken from the document the proposal
 * would have saved, so that each keeps its catalogue id and price exactly.
 */
export function linesToAdd(payload: Record<string, unknown>, labels: ProposalLabels): LineToAdd[] {
  const rooms = readRooms(Array.isArray(payload["rooms"]) ? payload["rooms"] : []);
  const positions = Array.isArray(payload["positions"]) ? payload["positions"] : [];
  const lines = labels.lines ?? [];
  return positions.flatMap((position, index) => {
    if (!Array.isArray(position)) return [];
    const [roomIndex, itemIndex] = position as [number, number];
    const item = rooms[roomIndex]?.items[itemIndex];
    const line = lines[index];
    if (!item || !line) return [];
    return [{ roomIndex, room: line.room, newRoom: line.new_room, item }];
  });
}
