/**
 * The signed-in chrome: topbar, navigation, account menu.
 *
 * A topbar rather than a sidebar, matching what staff use today. Navigation is
 * role-aware — `member` never sees Team — but that is presentation only; the API
 * enforces the same rule on every request.
 */
import { useEffect, useRef, useState } from "react";
import { Link, NavLink, Outlet, useNavigate } from "react-router-dom";
import { useAuth, useIsElevated } from "@/auth/useAuth";
import { RoleBadge } from "./Badge";
import { BrandMark } from "@/features/auth/AuthLayout";
import { cn } from "@/lib/cn";
import type { Role } from "@/domain/enums";

interface NavItem {
  to: string;
  label: string;
  elevatedOnly?: boolean;
}

const NAV: NavItem[] = [
  { to: "/estimates", label: "Supplements" },
  { to: "/projects", label: "Projects" },
  { to: "/calendar", label: "Calendar" },
  { to: "/team", label: "Team", elevatedOnly: true },
];

export function AppShell() {
  const elevated = useIsElevated();
  const items = NAV.filter((item) => !item.elevatedOnly || elevated);

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-30 border-b border-gray-200 bg-surface">
        <div className="mx-auto flex h-13 max-w-7xl items-center gap-6 px-4 sm:px-6">
          <Link to="/" className="shrink-0">
            <BrandMark />
          </Link>

          <nav className="flex flex-1 items-center gap-1 overflow-x-auto" aria-label="Main">
            {items.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  cn(
                    "rounded-md px-3 py-1.5 text-sm font-medium whitespace-nowrap transition-colors",
                    isActive
                      ? "bg-brand-50 text-brand-700"
                      : "text-gray-600 hover:bg-gray-100 hover:text-gray-900",
                  )
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>

          <AccountMenu />
        </div>
      </header>

      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6">
        <Outlet />
      </main>
    </div>
  );
}

function AccountMenu() {
  const { profile, signOut } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);

  // Close on an outside click or Escape. Both, because either alone leaves a way to
  // get stuck with the menu open.
  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: MouseEvent) {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  if (!profile) return null;

  const displayName = profile.full_name || profile.email;

  return (
    <div className="relative shrink-0" ref={container}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-gray-100"
      >
        <Avatar url={profile.avatar_url} name={displayName} />
        <span className="hidden text-sm font-medium text-gray-700 sm:inline">{displayName}</span>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 z-40 mt-1 w-56 overflow-hidden rounded-md bg-surface py-1 shadow-lg ring-1 ring-gray-200"
        >
          <div className="border-b border-gray-100 px-3 py-2">
            <p className="truncate text-sm font-medium text-gray-900">{displayName}</p>
            <p className="truncate text-xs text-gray-500">{profile.email}</p>
            <div className="mt-1.5">
              <RoleBadge role={profile.role as Role} />
            </div>
          </div>

          <MenuLink to="/profile" onSelect={() => setOpen(false)}>
            Profile
          </MenuLink>
          <MenuLink to="/settings" onSelect={() => setOpen(false)}>
            Settings
          </MenuLink>

          <button
            type="button"
            role="menuitem"
            onClick={async () => {
              setOpen(false);
              await signOut();
              navigate("/login", { replace: true });
            }}
            className="w-full border-t border-gray-100 px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-50"
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

function MenuLink({
  to,
  onSelect,
  children,
}: {
  to: string;
  onSelect: () => void;
  children: string;
}) {
  return (
    <Link
      to={to}
      role="menuitem"
      onClick={onSelect}
      className="block px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
    >
      {children}
    </Link>
  );
}

export function Avatar({
  url,
  name,
  size = "size-7",
}: {
  url?: string | null | undefined;
  name: string;
  size?: string;
}) {
  const [failed, setFailed] = useState(false);

  if (url && !failed) {
    return (
      <img
        src={url}
        alt=""
        onError={() => setFailed(true)}
        className={cn(size, "shrink-0 rounded-full object-cover ring-1 ring-gray-200")}
      />
    );
  }

  return (
    <span
      aria-hidden="true"
      className={cn(
        size,
        "flex shrink-0 items-center justify-center rounded-full bg-brand-50 text-xs font-semibold text-brand-700 ring-1 ring-brand-100",
      )}
    >
      {name.trim().charAt(0).toUpperCase() || "?"}
    </span>
  );
}
