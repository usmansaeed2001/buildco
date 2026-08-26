import { useContext } from "react";
import { AuthContext, type AuthState } from "./AuthProvider";
import { isElevated, type Role } from "@/domain/enums";
import type { ActorSnapshot } from "@/domain/estimateRules";

export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside <AuthProvider>.");
  return context;
}

/**
 * The signed-in user as a rules snapshot.
 *
 * `domain/estimateRules` and friends take an `ActorSnapshot` rather than the whole
 * profile, mirroring the backend's own rule signatures. Returns null while the session
 * is still resolving, so callers must handle "not known yet" rather than defaulting to
 * a role — defaulting to `member` would flash the wrong navigation, and defaulting to
 * `owner` would flash controls the user may not have.
 */
export function useActor(): ActorSnapshot | null {
  const { profile } = useAuth();
  if (!profile) return null;
  return { id: profile.id, role: profile.role as Role };
}

export function useIsElevated(): boolean {
  const { profile } = useAuth();
  return isElevated(profile?.role as Role | undefined);
}
