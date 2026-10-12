/**
 * Rendering a component with the providers it expects.
 *
 * The auth context is supplied directly rather than by mounting the real
 * `AuthProvider`, which would need a configured Firebase app and a live
 * `onIdTokenChanged` subscription. What a screen actually depends on is the *shape* of
 * `AuthState` — a profile and a role — so tests provide that and stay honest about it.
 */
import type { ReactElement, ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { render, type RenderResult } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AuthContext, type AuthState } from "@/auth/AuthProvider";
import { ToastProvider } from "@/components/Toast";
import type { UserOut } from "@/api/types";
import { makeUser } from "./factories";

/**
 * A QueryClient per test.
 *
 * Retries off, because a test asserting an error state should not wait out two
 * backoffs first; `gcTime: Infinity` with a fresh client per test keeps caches from
 * leaking between tests while never expiring mid-assertion.
 */
export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity, staleTime: 0 },
      mutations: { retry: false },
    },
  });
}

export function makeAuthState(profile: UserOut | null, overrides: Partial<AuthState> = {}): AuthState {
  return {
    loading: false,
    firebaseUser: null,
    profile,
    error: null,
    isNewAccount: false,
    signOut: async () => {},
    refreshProfile: async () => {},
    googleAccessToken: null,
    googleCalendarAvailable: false,
    requestGoogleCalendarAccess: async () => {
      throw new Error("No Google Calendar access in this test.");
    },
    ...overrides,
  };
}

export interface RenderOptions {
  /** The signed-in user. Pass `null` to render as signed out. */
  user?: UserOut | null;
  /** Initial URL. Use with `path` when the component reads route params. */
  route?: string;
  /** Route pattern to mount `ui` at, e.g. `/estimates/:estimateId`. */
  path?: string;
  queryClient?: QueryClient;
  auth?: Partial<AuthState>;
}

export interface RenderWithProvidersResult extends RenderResult {
  queryClient: QueryClient;
  user: ReturnType<typeof userEvent.setup>;
}

export function renderWithProviders(
  ui: ReactElement,
  options: RenderOptions = {},
): RenderWithProvidersResult {
  const {
    user: profile = makeUser(),
    route = "/",
    path,
    queryClient = makeQueryClient(),
    auth = {},
  } = options;

  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={makeAuthState(profile, auth)}>
        <ToastProvider>
          <MemoryRouter initialEntries={[route]}>
            {path ? <Routes><Route path={path} element={children} /></Routes> : children}
          </MemoryRouter>
        </ToastProvider>
      </AuthContext.Provider>
    </QueryClientProvider>
  );

  const result = render(ui, { wrapper });
  return { ...result, queryClient, user: userEvent.setup() };
}

export * from "@testing-library/react";
