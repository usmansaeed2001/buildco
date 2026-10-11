/**
 * The estimates list.
 *
 * Filter and search live in the query string, so a refresh, a bookmark, and the back
 * button all behave. The legacy list kept both in module-level variables, which is why
 * reloading always dumped you back on "active" with an empty search box.
 */
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  PAGE_SIZE,
  useCreateEstimate,
  useEstimateIds,
  useEstimateTransition,
  useEstimates,
  useTrashEstimate,
} from "@/api/queries/estimates";
import type { EstimateOut, EstimateSort } from "@/api/types";
import { useActor } from "@/auth/useAuth";
import { Button } from "@/components/Button";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { KebabIcon, Menu, MenuItem, MenuSeparator } from "@/components/Menu";
import { EstimateStatusBadge } from "@/components/Badge";
import { EmptyState, ErrorState, PageHeader } from "@/components/feedback";
import { Input, Select } from "@/components/form";
import { Pagination } from "@/components/Pagination";
import { useToast } from "@/components/Toast";
import { ESTIMATE_FILTER_ORDER, ESTIMATE_STATUS_LABELS, type EstimateStatus } from "@/domain/enums";
import { availableTransitions } from "@/domain/estimateRules";
import { computeTotals } from "@/domain/estimateTotals";
import type { StoredRoom } from "@/domain/estimateTotals";
import { formatMoney } from "@/domain/money";
import { cn } from "@/lib/cn";
import {
  TRASH_RETENTION_DAYS,
  daysLeftInTrash,
  displayName,
  formatRelative,
} from "@/lib/format";
import { hasUnseen, markSeen } from "@/lib/seen";
import { useDebounced } from "@/lib/useDebounced";
import { endOfLocalDay, startOfLocalDay } from "@/lib/dateRange";
import { ApiError } from "@/api/client";
import { EstimatesGridSkeleton } from "./EstimateCardSkeleton";
import { NewEstimateModal, type NewEstimateValues } from "./NewEstimateModal";
import { TrashList } from "./TrashList";

export function EstimatesListPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const actor = useActor();

  const view = params.get("view"); // "trash" or null
  const isTrash = view === "trash";
  const status = (params.get("status") as EstimateStatus | null) ?? undefined;
  const search = params.get("q") ?? "";
  const from = params.get("from") ?? "";
  const to = params.get("to") ?? "";
  const offset = Math.max(0, Number(params.get("offset") ?? 0) || 0);
  // Defaults to most-recently-edited: people find work by what they touched last, not by
  // what they filed first. Requested explicitly rather than relying on the API's default,
  // which stays `recently_created` for every other caller.
  const sort = (SORTS.find((option) => option.value === params.get("sort"))?.value ??
    "recently_edited") as EstimateSort;

  // Debounced so typing does not fire a request per keystroke now that search is
  // server-side. 250ms is below the threshold where the list feels laggy and well above
  // the gap between keystrokes.
  const debouncedSearch = useDebounced(search, 250);

  /**
   * Status, search and the date window are all applied **server-side**.
   *
   * They used to be applied in the browser over one 200-row request. That was fine while
   * the whole list arrived at once and is a correctness bug the moment it does not: page
   * two would be filtered against only the rows page two happens to hold.
   */
  const { data, isPending, error, refetch } = useEstimates({
    trash: isTrash,
    status,
    q: debouncedSearch.trim() || undefined,
    created_from: startOfLocalDay(from),
    created_to: endOfLocalDay(to),
    sort,
    limit: PAGE_SIZE,
    offset,
  });

  /**
   * The dots need every status, not the page you are looking at.
   *
   * Hence a separate, deliberately tiny request. Skipped in the trash view, which has no
   * chips.
   */
  const ids = useEstimateIds(!isTrash);

  const createEstimate = useCreateEstimate();
  const [creating, setCreating] = useState(false);

  function setParam(key: string, value: string | null) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    // Any change to what is being filtered invalidates the current page number —
    // otherwise narrowing a list while on page three shows an empty page.
    if (key !== "offset") next.delete("offset");
    setParams(next, { replace: true });
  }

  const items = useMemo(() => data?.items ?? [], [data?.items]);

  /** Ids per status, for the chips' unread dots. */
  const idsByStatus = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const row of ids.data ?? []) {
      const bucket = map.get(row.status);
      if (bucket) bucket.push(row.id);
      else map.set(row.status, [row.id]);
    }
    return map;
  }, [ids.data]);

  const visible = items;
  const filtering = Boolean(search || status || from || to);

  // Viewing a status clears its dot. Deliberately not scoped to the search: what has
  // been *shown* is the whole status, and a search is a lens over it rather than a
  // different list.
  useEffect(() => {
    if (isTrash || !status) return;
    markSeen(status, idsByStatus.get(status) ?? []);
  }, [isTrash, status, idsByStatus]);

  async function handleCreate(values: NewEstimateValues) {
    // Deliberately not caught here — the modal shows the failure beside the field that
    // caused it, which for a duplicate claim ID is the only place it is actionable.
    const created = await createEstimate.mutateAsync(values);
    setCreating(false);
    navigate(`/estimates/${created.id}`);
  }

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Supplements"
        subtitle="Every supplement estimate across your projects."
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            <PlusIcon />
            New estimate
          </Button>
        }
      />

      {/* One bordered panel rather than controls loose on the page. The filters used to
          wrap into a ragged stack of three rows with nothing tying them together; giving
          them a surface and an internal rule makes the grouping the layout's job instead
          of the reader's. */}
      <div className="overflow-hidden rounded-card bg-surface ring-1 ring-gray-200">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-100 px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <Chip active={!status && !isTrash} onClick={() => setParams(withSearch(params, {}))}>
              All
            </Chip>
            {ESTIMATE_FILTER_ORDER.map((value) => (
              <Chip
                key={value}
                active={status === value && !isTrash}
                // The dot means "something arrived here since you last looked". Never on
                // the chip you are looking at — the effect above has just cleared it.
                unread={
                  !isTrash && status !== value && hasUnseen(value, idsByStatus.get(value) ?? [])
                }
                onClick={() => setParams(withSearch(params, { status: value }))}
              >
                {ESTIMATE_STATUS_LABELS[value]}
              </Chip>
            ))}
            <Chip active={isTrash} onClick={() => setParams(withSearch(params, { view: "trash" }))}>
              Trash
            </Chip>
          </div>

          {/* The count lives with the filters that determine it, not down beside the
              pager. Held to a fixed shape while loading so the row does not reflow. */}
          <p className="shrink-0 text-sm whitespace-nowrap text-gray-500" aria-live="polite">
            {isPending ? "Loading…" : `${data?.total ?? 0} ${data?.total === 1 ? "estimate" : "estimates"}`}
          </p>
        </div>

        <div className="flex flex-col gap-3 bg-gray-50/60 px-4 py-3 app-lg:flex-row app-lg:items-center">
          <div className="relative flex-1">
            <SearchIcon />
            <Input
              type="search"
              placeholder="Search name, client or claim ID"
              aria-label="Search estimates"
              className="pl-9"
              value={search}
              onChange={(event) => setParam("q", event.target.value)}
            />
          </div>

          <div className="flex flex-wrap items-center gap-2 app-lg:gap-3">
            {/* Labelled, because two bare date inputs beside a dropdown say nothing about
                what they filter. */}
            <div className="flex items-center gap-2 app-lg:border-l app-lg:border-gray-200 app-lg:pl-3">
              <span className="text-xs font-medium text-gray-500">Created</span>
              <div className="w-36">
                <Input
                  type="date"
                  aria-label="Created from"
                  value={from}
                  max={to || undefined}
                  onChange={(event) => setParam("from", event.target.value)}
                />
              </div>
              <span className="text-sm text-gray-400">to</span>
              <div className="w-36">
                <Input
                  type="date"
                  aria-label="Created to"
                  value={to}
                  min={from || undefined}
                  onChange={(event) => setParam("to", event.target.value)}
                />
              </div>
            </div>

            <div className="flex items-center gap-2 app-lg:border-l app-lg:border-gray-200 app-lg:pl-3">
              <span className="text-xs font-medium text-gray-500">Sort</span>
              {/* Width on the wrapper, not the control. `cn` is a plain join, so a
                  `w-auto` passed to Select would sit alongside its own `w-full` and lose
                  — which is exactly how this dropdown ended up spanning the page. */}
              <div className="w-44">
                <Select
                  aria-label="Sort by"
                  value={sort}
                  onChange={(event) => setParam("sort", event.target.value)}
                >
                  {SORTS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
          </div>
        </div>
      </div>

      {isPending ? (
        <EstimatesGridSkeleton />
      ) : error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : isTrash ? (
        <TrashList estimates={visible} actor={actor} />
      ) : visible.length === 0 ? (
        <EmptyState
          title={filtering ? "Nothing matches these filters" : "No estimates yet"}
          description={
            filtering
              ? "Try a different name, claim ID, or date range."
              : "Create one to start pricing a supplement."
          }
          {...(filtering
            ? {}
            : {
                action: (
                  <Button variant="primary" onClick={() => setCreating(true)}>
                    New estimate
                  </Button>
                ),
              })}
        />
      ) : (
        <>
          <ul className="grid gap-4 app-sm:grid-cols-2 app-lg:grid-cols-3">
            {visible.map((estimate) => (
              <li key={estimate.id}>
                <EstimateCard estimate={estimate} />
              </li>
            ))}
          </ul>
          <Pagination
            total={data?.total ?? 0}
            limit={PAGE_SIZE}
            offset={offset}
            onChange={(next) => setParam("offset", next ? String(next) : null)}
          />
        </>
      )}

      <NewEstimateModal
        open={creating}
        busy={createEstimate.isPending}
        onClose={() => setCreating(false)}
        onCreate={handleCreate}
      />
    </div>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true" className="size-4">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

/** Sits inside the search field's padding, so the field reads as a search box. */
function SearchIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
      className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-gray-400"
    >
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}

/** Sort options, in the order the dropdown offers them. */
const SORTS: { value: EstimateSort; label: string }[] = [
  { value: "recently_edited", label: "Recently edited" },
  { value: "recently_created", label: "Recently created" },
  { value: "highest_total", label: "Highest total" },
  { value: "client_name", label: "Client A–Z" },
];

/** Reset paging-irrelevant params while keeping the current search text. */
function withSearch(current: URLSearchParams, next: Record<string, string>): URLSearchParams {
  const params = new URLSearchParams(next);
  const q = current.get("q");
  if (q) params.set("q", q);
  return params;
}

function Chip({
  active,
  unread = false,
  onClick,
  children,
}: {
  active: boolean;
  unread?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-medium transition-colors",
        active
          ? "bg-gray-900 text-surface"
          : "bg-surface text-gray-600 ring-1 ring-inset ring-gray-300 hover:bg-gray-50",
      )}
    >
      {children}
      {unread && (
        // Announced, not just coloured: a red dot alone says nothing to a screen
        // reader, and colour alone fails anyone who cannot distinguish it.
        <span className="size-1.5 rounded-full bg-danger-500">
          <span className="sr-only">new</span>
        </span>
      )}
    </button>
  );
}

export function EstimateCard({ estimate }: { estimate: EstimateOut }) {
  const toast = useToast();
  const actor = useActor();
  const transition = useEstimateTransition(estimate.id);
  const trash = useTrashEstimate();
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const total =
    estimate.totals?.total ?? computeTotals(estimate.rooms as StoredRoom[]).total.toFixed(2);
  const roomCount =
    estimate.totals?.room_count ?? computeTotals(estimate.rooms as StoredRoom[]).roomCount;

  const daysLeft = daysLeftInTrash(estimate.deleted_at);
  const named = estimateName(estimate);
  // Decided by the same rule as the editor's toolbar, and for the same reason: the API
  // refuses a transition from a status it is not offered from. This menu used to offer
  // Archive on anything not already archived, which let an admin archive and then
  // unarchive a locked estimate, undoing a lock only the owner may lift.
  const archiving = actor
    ? availableTransitions(actor, {
        status: estimate.status as EstimateStatus,
        createdBy: estimate.created_by ?? null,
        isTrashed: Boolean(estimate.deleted_at),
      }).find(({ action }) => action === "archive" || action === "unarchive")?.action
    : undefined;
  const unpriced = isUnpriced(total, roomCount);

  async function run(label: string, action: () => Promise<unknown>) {
    try {
      await action();
      toast.success(label);
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : "That did not work.");
    }
  }

  return (
    // `relative`, with the title carrying a stretched pseudo-element below. The card used
    // to be one big `<Link>`, which cannot hold a menu button: a `<button>` inside an
    // `<a>` is invalid HTML and clicking it navigates. This keeps the whole card
    // clickable while the menu is a real sibling rather than a nested control.
    <article className="group relative flex h-full overflow-hidden rounded-card bg-surface ring-1 ring-gray-200 transition-shadow focus-within:shadow-md hover:shadow-md">
      {/* A status stripe rather than only a pill. On a three-column grid it lets you scan
          a column by colour, and on a phone — where the cards stack full width — it is
          the thing that keeps the list from reading as one grey block. */}
      <span aria-hidden="true" className={cn("w-1 shrink-0", STATUS_STRIPE[estimate.status] ?? "bg-gray-300")} />

      <div className="flex min-w-0 flex-1 flex-col gap-3 p-4">
        <div className="flex items-start justify-between gap-2">
          <EstimateStatusBadge status={estimate.status as EstimateStatus} />
          {/* Above the stretched link, so it is clickable rather than swallowed by it. */}
          <div className="relative z-10 -mt-1 -mr-1">
            <Menu label={`Actions for ${named || estimate.identifier}`} trigger={<KebabIcon />}>
              {(close) => (
                <>
                  {archiving && (
                    <MenuItem
                      onSelect={() => {
                        close();
                        void run(archiving === "unarchive" ? "Unarchived." : "Archived.", () =>
                          transition.mutateAsync(archiving),
                        );
                      }}
                    >
                      {archiving === "unarchive" ? "Unarchive" : "Archive"}
                    </MenuItem>
                  )}
                  <MenuSeparator />
                  <MenuItem
                    tone="danger"
                    onSelect={() => {
                      close();
                      setConfirmingDelete(true);
                    }}
                  >
                    Delete
                  </MenuItem>
                </>
              )}
            </Menu>
          </div>
        </div>

        <div className="min-w-0">
          <Link
            to={`/estimates/${estimate.id}`}
            className="block truncate text-lg leading-tight font-bold tracking-tight after:absolute after:inset-0 after:content-[''] focus-visible:outline-none"
          >
            {named ? (
              <span className="text-gray-900 transition-colors group-hover:text-brand-700 group-hover:dark:text-brand-300">
                {named}
              </span>
            ) : (
              <span className="text-gray-500">
                Untitled · <span className="font-mono text-base">{estimate.identifier}</span>
              </span>
            )}
          </Link>
          <p className="mt-1 truncate text-sm text-gray-500">
            {estimate.client_name || "No client"}
          </p>
        </div>

        <div className="mt-auto flex items-end justify-between gap-3 border-t border-gray-100 pt-3">
          <div className="min-w-0">
            <p className="tnum text-xs font-semibold text-gray-600">{estimate.identifier}</p>
            {/* Edited, not created. You look for the thing you touched last. */}
            <p className="mt-0.5 truncate text-xs text-gray-400">
              {displayName(estimate.creator)} · edited {formatRelative(estimate.updated_at)}
            </p>
            {daysLeft !== null && (
              <p className="mt-0.5 text-xs text-warning-600 dark:text-warning-400">
                {daysLeft} {daysLeft === 1 ? "day" : "days"} left
              </p>
            )}
          </div>

          <div className="shrink-0 text-right">
            {/* A zero total on an estimate with no rooms is not a number, it is an absence
                — and it used to be set in the heaviest type on the card. A zero total with
                rooms in it is a real figure and keeps its weight. */}
            {unpriced ? (
              <p className="text-sm text-gray-400">Not priced yet</p>
            ) : (
              <>
                <p className="tnum text-xl leading-none font-extrabold tracking-tight text-gray-900">
                  {formatMoney(total)}
                </p>
                <p className="mt-1.5 text-xs text-gray-400">
                  {roomCount} {roomCount === 1 ? "room" : "rooms"}
                </p>
              </>
            )}
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={confirmingDelete}
        title="Move to trash?"
        confirmLabel="Move to trash"
        tone="danger"
        busy={trash.isPending}
        onCancel={() => setConfirmingDelete(false)}
        onConfirm={() => {
          setConfirmingDelete(false);
          void run("Moved to trash.", () => trash.mutateAsync(estimate.id));
        }}
      >
        <p>
          <strong>{named || estimate.identifier}</strong> goes to the trash, where it can be
          restored for {TRASH_RETENTION_DAYS} days.
        </p>
      </ConfirmDialog>
    </article>
  );
}

/**
 * The stripe colour per status.
 *
 * Deliberately the same hues the status badge already uses, so the stripe and the pill
 * on the same card never disagree — the stripe is a second reading of one fact, not a
 * second fact.
 */
const STATUS_STRIPE: Record<string, string> = {
  active: "bg-brand-600",
  submitted: "bg-gray-400",
  changes_requested: "bg-warning-500",
  approved: "bg-success-500",
  rejected: "bg-danger-500",
  locked: "bg-gray-500",
  archived: "bg-gray-300",
};

/**
 * The estimate's name, or empty when it has never been given one.
 *
 * `"New Estimate"` is matched deliberately. It was the column's default until this round,
 * so an estimate created without a name was not unnamed — it was named the same thing as
 * every other one, which is why a list of them read as identical rows. Treating the old
 * default as "unnamed" is what makes the estimates already in the database legible.
 */
function estimateName(estimate: EstimateOut): string {
  const name = estimate.project_name.trim();
  return name === "New Estimate" ? "" : name;
}

/** Zero money *and* no rooms — an estimate nobody has priced, rather than one worth nothing. */
function isUnpriced(total: string, roomCount: number): boolean {
  return roomCount === 0 && Number(total) === 0;
}
