/**
 * The estimates list.
 *
 * Filter and search live in the query string, so a refresh, a bookmark, and the back
 * button all behave. The legacy list kept both in module-level variables, which is why
 * reloading always dumped you back on "active" with an empty search box.
 */
import { useEffect, useMemo } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useCreateEstimate, useEstimates } from "@/api/queries/estimates";
import type { EstimateOut } from "@/api/types";
import { useActor } from "@/auth/useAuth";
import { Button } from "@/components/Button";
import { EstimateStatusBadge } from "@/components/Badge";
import { EmptyState, ErrorState, LoadingState, PageHeader } from "@/components/feedback";
import { Input } from "@/components/form";
import { useToast } from "@/components/Toast";
import { ESTIMATE_FILTER_ORDER, ESTIMATE_STATUS_LABELS, type EstimateStatus } from "@/domain/enums";
import { computeTotals } from "@/domain/estimateTotals";
import type { StoredRoom } from "@/domain/estimateTotals";
import { formatMoney } from "@/domain/money";
import { cn } from "@/lib/cn";
import { daysLeftInTrash, displayName, formatDate } from "@/lib/format";
import { hasUnseen, markSeen } from "@/lib/seen";
import { ApiError } from "@/api/client";
import { TrashList } from "./TrashList";

export function EstimatesListPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  const actor = useActor();

  const view = params.get("view"); // "trash" or null
  const isTrash = view === "trash";
  const status = (params.get("status") as EstimateStatus | null) ?? undefined;
  const search = params.get("q") ?? "";

  /**
   * One request for the whole list, filtered by status in the browser.
   *
   * The status chips each carry an unread dot, which needs to know what is in the
   * *other* statuses too — so a server-filtered query could not light them. This is
   * also how the legacy list worked, and it removes a round trip per chip click.
   *
   * 200 is the API's own ceiling. Beyond that the dots (and the list) would be
   * computed from a partial set; revisit with real pagination if a team ever gets
   * there.
   */
  const { data, isPending, error, refetch } = useEstimates({ trash: isTrash, limit: 200 });

  const createEstimate = useCreateEstimate();

  function setParam(key: string, value: string | null) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  }

  /**
   * Search filters client-side, as it did before.
   *
   * The API does accept a `q` parameter, but the whole list is already loaded for the
   * filter chips and these are a handful of estimates per team — filtering in memory
   * is instant and avoids a request per keystroke. Revisit if a team ever exceeds the
   * 50-row page.
   */
  const items = useMemo(() => data?.items ?? [], [data?.items]);

  /** Ids per status, for the chips' unread dots. */
  const idsByStatus = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const estimate of items) {
      const bucket = map.get(estimate.status);
      if (bucket) bucket.push(estimate.id);
      else map.set(estimate.status, [estimate.id]);
    }
    return map;
  }, [items]);

  const inStatus = useMemo(
    () => (status ? items.filter((estimate) => estimate.status === status) : items),
    [items, status],
  );

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return inStatus;

    return inStatus.filter((estimate) =>
      [estimate.project_name, estimate.client_name, estimate.identifier, estimate.pm_name]
        .filter(Boolean)
        .some((field) => field.toLowerCase().includes(needle)),
    );
  }, [inStatus, search]);

  // Viewing a status clears its dot. Deliberately not scoped to the search: what has
  // been *shown* is the whole status, and a search is a lens over it rather than a
  // different list.
  useEffect(() => {
    if (isTrash || !status) return;
    markSeen(status, idsByStatus.get(status) ?? []);
  }, [isTrash, status, idsByStatus]);

  async function handleCreate() {
    try {
      const created = await createEstimate.mutateAsync({});
      navigate(`/estimates/${created.id}`);
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : "Could not create the estimate.");
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Supplements"
        actions={
          <Button variant="primary" onClick={handleCreate} busy={createEstimate.isPending}>
            New estimate
          </Button>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <Chip active={!status && !isTrash} onClick={() => setParams(withSearch(params, {})) }>
          All
        </Chip>
        {ESTIMATE_FILTER_ORDER.map((value) => (
          <Chip
            key={value}
            active={status === value && !isTrash}
            // The dot means "something arrived here since you last looked". Never on
            // the chip you are looking at — the effect above has just cleared it.
            unread={!isTrash && status !== value && hasUnseen(value, idsByStatus.get(value) ?? [])}
            onClick={() => setParams(withSearch(params, { status: value }))}
          >
            {ESTIMATE_STATUS_LABELS[value]}
          </Chip>
        ))}
        <Chip active={isTrash} onClick={() => setParams(withSearch(params, { view: "trash" }))}>
          Trash
        </Chip>

        <div className="ml-auto w-full sm:w-64">
          <Input
            type="search"
            placeholder="Search name, client, claim ID…"
            aria-label="Search estimates"
            value={search}
            onChange={(event) => setParam("q", event.target.value)}
          />
        </div>
      </div>

      {isPending ? (
        <LoadingState />
      ) : error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : isTrash ? (
        <TrashList estimates={visible} actor={actor} />
      ) : visible.length === 0 ? (
        <EmptyState
          title={search ? "No estimates match that search" : "No estimates yet"}
          description={
            search
              ? "Try a different name, client, or claim ID."
              : "Create one to start pricing a supplement."
          }
          {...(search
            ? {}
            : {
                action: (
                  <Button variant="primary" onClick={handleCreate}>
                    New estimate
                  </Button>
                ),
              })}
        />
      ) : (
        <>
          <p className="text-sm text-gray-500">
            {visible.length} {visible.length === 1 ? "estimate" : "estimates"}
            {search && ` matching “${search}”`}
          </p>
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {visible.map((estimate) => (
              <li key={estimate.id}>
                <EstimateCard estimate={estimate} />
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

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
          ? "bg-gray-900 text-white"
          : "bg-white text-gray-600 ring-1 ring-inset ring-gray-300 hover:bg-gray-50",
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
  // `totals` is attached to every estimate response, so prefer the server's number.
  // The local computation is the fallback for a payload that predates it.
  const total =
    estimate.totals?.total ?? computeTotals(estimate.rooms as StoredRoom[]).total.toFixed(2);
  const roomCount =
    estimate.totals?.room_count ?? computeTotals(estimate.rooms as StoredRoom[]).roomCount;

  const daysLeft = daysLeftInTrash(estimate.deleted_at);

  return (
    <Link
      to={`/estimates/${estimate.id}`}
      className="flex h-full flex-col gap-3 rounded-card bg-surface p-4 ring-1 ring-gray-200 transition-shadow hover:shadow-md"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-medium text-gray-900">{estimate.project_name}</p>
          <p className="truncate text-sm text-gray-500">{estimate.client_name || "No client"}</p>
        </div>
        <EstimateStatusBadge status={estimate.status as EstimateStatus} />
      </div>

      <div className="mt-auto flex items-end justify-between gap-2 border-t border-gray-100 pt-3">
        <div className="min-w-0 text-xs text-gray-500">
          <p className="font-mono">{estimate.identifier}</p>
          <p className="truncate">
            {displayName(estimate.creator)} · {formatDate(estimate.created_at)}
          </p>
          {daysLeft !== null && (
            <p className="mt-0.5 text-warning-600">
              {daysLeft} {daysLeft === 1 ? "day" : "days"} left
            </p>
          )}
        </div>
        <div className="shrink-0 text-right">
          <p className="tnum font-semibold text-gray-900">{formatMoney(total)}</p>
          <p className="text-xs text-gray-500">
            {roomCount} {roomCount === 1 ? "room" : "rooms"}
          </p>
        </div>
      </div>
    </Link>
  );
}
