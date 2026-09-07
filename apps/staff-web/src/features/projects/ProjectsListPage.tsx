/**
 * The projects list.
 *
 * Filter and search live in the query string, matching the estimates list — a refresh,
 * a bookmark and the back button all behave.
 *
 * The status chips include `Closed` and `Pending payment`, which nobody can *set*: they
 * are derived by the rules engine. Filtering by them is still exactly what someone
 * wants — "what is waiting on money" is the most common question this screen answers.
 */
import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useProjects } from "@/api/queries/projects";
import type { ProjectOut } from "@/api/types";
import { useIsElevated } from "@/auth/useAuth";
import { Button } from "@/components/Button";
import { ProjectStatusBadge, WorkStatusBadge } from "@/components/Badge";
import { EmptyState, ErrorState, LoadingState, PageHeader } from "@/components/feedback";
import { Input } from "@/components/form";
import { PROJECT_STATUSES, PROJECT_STATUS_LABELS, type ProjectStatus } from "@/domain/enums";
import { formatMoney, percentOf, toDecimal } from "@/domain/money";
import { cn } from "@/lib/cn";
import { displayName, formatDate } from "@/lib/format";
import { NewProjectModal } from "./NewProjectModal";

export function ProjectsListPage() {
  const [params, setParams] = useSearchParams();
  const elevated = useIsElevated();
  const [creating, setCreating] = useState(false);

  const status = (params.get("status") as ProjectStatus | null) ?? undefined;
  const search = params.get("q") ?? "";

  const { data, isPending, error, refetch } = useProjects({ status });

  function setParam(key: string, value: string | null) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  }

  /** Client-side, as on the estimates list and for the same reason: the page is already
   *  loaded, these are tens of projects, and a request per keystroke buys nothing. */
  const visible = useMemo(() => {
    const items = data?.items ?? [];
    const needle = search.trim().toLowerCase();
    if (!needle) return items;

    return items.filter((project) =>
      [project.owner_name, project.address, project.work_type]
        .filter(Boolean)
        .some((field) => field.toLowerCase().includes(needle)),
    );
  }, [data?.items, search]);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Projects"
        actions={
          elevated ? (
            <Button variant="primary" onClick={() => setCreating(true)}>
              New project
            </Button>
          ) : undefined
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <Chip active={!status} onClick={() => setParams(withSearch(params, {}))}>
          All
        </Chip>
        {PROJECT_STATUSES.map((value) => (
          <Chip
            key={value}
            active={status === value}
            onClick={() => setParams(withSearch(params, { status: value }))}
          >
            {PROJECT_STATUS_LABELS[value]}
          </Chip>
        ))}

        <div className="ml-auto w-full sm:w-64">
          <Input
            type="search"
            placeholder="Search owner, address, work type…"
            aria-label="Search projects"
            value={search}
            onChange={(event) => setParam("q", event.target.value)}
          />
        </div>
      </div>

      {isPending ? (
        <LoadingState />
      ) : error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : visible.length === 0 ? (
        <EmptyState
          title={search ? "No projects match that search" : "No projects yet"}
          description={
            search
              ? "Try a different owner, address, or work type."
              : elevated
                ? "Create one to start tracking work and payments."
                : "You have not been assigned to any projects."
          }
          {...(search || !elevated
            ? {}
            : {
                action: (
                  <Button variant="primary" onClick={() => setCreating(true)}>
                    New project
                  </Button>
                ),
              })}
        />
      ) : (
        <>
          <p className="text-sm text-gray-500">
            {visible.length} {visible.length === 1 ? "project" : "projects"}
            {search && ` matching “${search}”`}
          </p>
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {visible.map((project) => (
              <li key={project.id}>
                <ProjectCard project={project} />
              </li>
            ))}
          </ul>
        </>
      )}

      <NewProjectModal open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}

function withSearch(current: URLSearchParams, next: Record<string, string>): URLSearchParams {
  const params = new URLSearchParams(next);
  const q = current.get("q");
  if (q) params.set("q", q);
  return params;
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "rounded-full px-3 py-1 text-sm font-medium transition-colors",
        active
          ? "bg-gray-900 text-surface"
          : "bg-surface text-gray-600 ring-1 ring-inset ring-gray-300 hover:bg-gray-50",
      )}
    >
      {children}
    </button>
  );
}

export function ProjectCard({ project }: { project: ProjectOut }) {
  const collected = toDecimal(project.amount_collected);
  const budget = toDecimal(project.total_budget);
  const percent = percentOf(collected, budget);

  return (
    <Link
      to={`/projects/${project.id}`}
      className="flex h-full flex-col gap-3 rounded-card bg-surface p-4 ring-1 ring-gray-200 transition-shadow hover:shadow-md"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-medium text-gray-900">
            {project.owner_name || "Unnamed owner"}
          </p>
          <p className="truncate text-sm text-gray-500">{project.address || "No address"}</p>
        </div>
        <ProjectStatusBadge status={project.status as ProjectStatus} />
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <WorkStatusBadge status={project.work_status} />
        {project.work_type && <span className="text-gray-500">{project.work_type}</span>}
      </div>

      {/* A budget of zero means none was set, not that nothing is owed — a bar at 0%
          would read as "no money collected", which is a different claim. */}
      {budget.isZero() ? (
        <p className="text-xs text-gray-400">No budget set</p>
      ) : (
        <div>
          <div className="h-1.5 overflow-hidden rounded-full bg-gray-100">
            <div
              className="h-full rounded-full bg-brand-500"
              style={{ width: `${percent}%` }}
              role="presentation"
            />
          </div>
          <p className="mt-1 tnum text-xs text-gray-500">
            {formatMoney(collected)} of {formatMoney(budget)} collected
          </p>
        </div>
      )}

      <div className="mt-auto flex items-end justify-between gap-2 border-t border-gray-100 pt-3 text-xs text-gray-500">
        <span className="truncate">
          {project.assignee ? displayName(project.assignee) : "Unassigned"}
        </span>
        <span>{formatDate(project.start_date, "No start date")}</span>
      </div>
    </Link>
  );
}
