/**
 * The single door to the API.
 *
 * Everything that talks to the backend goes through `apiFetch`, so token injection,
 * the error envelope, and 401 handling are implemented once rather than in every
 * caller. The legacy app defined its own `api()` helper in each of four HTML files,
 * and they had drifted apart — one cached the session for four minutes, another
 * didn't, and only some of them redirected on 401.
 */

/** Resolves the current Firebase ID token, or null when signed out.
 *
 * Injected rather than imported so this module has no dependency on the auth layer —
 * that keeps it usable from the public review page, which must work with no user at
 * all, and keeps it trivially testable. `auth/AuthProvider` installs the real one. */
type TokenResolver = () => Promise<string | null>;

let resolveToken: TokenResolver = async () => null;
let onUnauthorized: () => void = () => {};

export function configureApi(options: {
  getToken: TokenResolver;
  onUnauthorized: () => void;
}): void {
  resolveToken = options.getToken;
  onUnauthorized = options.onUnauthorized;
}

/**
 * The API base path.
 *
 * Defaults to a same-origin `/api/v1`, which is correct in both environments: Vite
 * proxies it to localhost:8000 in development, and the Firebase Hosting rewrite sends
 * it to Cloud Run in production. The env var exists only to point a local build at a
 * remote backend; it is not needed for a normal deploy.
 */
export const API_BASE: string = import.meta.env.VITE_API_BASE_URL ?? "/api/v1";

/** The shape every non-2xx response uses (`app/errors.py`). */
export interface ApiErrorBody {
  code: string;
  message: string;
  details?: Record<string, unknown> | null;
}

/** One validation failure, from a 422's `details.errors`. */
export interface ValidationIssue {
  location: (string | number)[];
  message: string;
  type: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown> | null;
  /** Correlates a client-side report with the server log line. */
  readonly requestId: string | null;

  constructor(status: number, body: ApiErrorBody, requestId: string | null) {
    super(body.message);
    this.name = "ApiError";
    this.status = status;
    this.code = body.code;
    this.details = body.details ?? null;
    this.requestId = requestId;
  }

  /** Field-level failures from a 422, for mapping onto form inputs. */
  get validationIssues(): ValidationIssue[] {
    const errors = this.details?.errors;
    return Array.isArray(errors) ? (errors as ValidationIssue[]) : [];
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }

  /** 410 — the reviewer's decision was already recorded and the link is spent. */
  get isGone(): boolean {
    return this.status === 410;
  }

  get isConflict(): boolean {
    return this.status === 409;
  }

  /** 503 — an integration (storage, Groq) has no credentials configured. */
  get isIntegrationUnavailable(): boolean {
    return this.status === 503;
  }
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  /** Serialised as JSON. Omit for endpoints that take no body. */
  body?: unknown;
  /** Appended as a query string. `undefined` and `null` entries are dropped. */
  query?: Record<string, string | number | boolean | undefined | null>;
  /** Skip the Authorization header. For the public review and auth-status endpoints. */
  anonymous?: boolean;
  signal?: AbortSignal;
}

function buildUrl(path: string, query?: RequestOptions["query"]): string {
  const url = `${API_BASE}${path}`;
  if (!query) return url;

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${url}?${qs}` : url;
}

export async function apiFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = "GET", body, query, anonymous = false, signal } = options;

  // Only Authorization and Content-Type are allowed by the API's CORS policy
  // (`app/main.py`). Adding anything else here fails preflight in development, where
  // the request is genuinely cross-origin.
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";

  if (!anonymous) {
    // Firebase refreshes the ID token internally when it is close to expiry, so
    // asking for it per request is both correct and cheap.
    const token = await resolveToken();
    if (token) headers["Authorization"] = `Bearer ${token}`;
  }

  const response = await fetch(buildUrl(path, query), {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    ...(signal ? { signal } : {}),
  });

  if (response.ok) {
    // 204, and any empty body, would throw on .json().
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  const requestId = response.headers.get("X-Request-ID");
  const error = new ApiError(response.status, await readErrorBody(response), requestId);

  // A 401 means the token is missing, invalid, or — the case that matters — the
  // account was banned since it was issued. The backend rechecks status on every
  // request, so revocation is immediate rather than waiting out the token's hour.
  // Anonymous calls are exempt: the public review page has no session to end.
  if (response.status === 401 && !anonymous) onUnauthorized();

  throw error;
}

/** Never let error handling throw its own error. */
async function readErrorBody(response: Response): Promise<ApiErrorBody> {
  try {
    const parsed = (await response.json()) as { error?: ApiErrorBody };
    if (parsed?.error?.code && parsed.error.message) return parsed.error;
  } catch {
    // A proxy timeout or a crash before the handlers run yields HTML or nothing.
  }
  return {
    code: "http_error",
    message: `Request failed with status ${response.status}.`,
  };
}
