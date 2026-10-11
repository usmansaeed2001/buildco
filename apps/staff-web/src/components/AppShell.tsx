/**
 * The signed-in chrome: topbar, navigation, account menu.
 *
 * A topbar rather than a sidebar, matching what staff use today. Navigation is
 * role-aware — `member` never sees Team — but that is presentation only; the API
 * enforces the same rule on every request.
 *
 * **Width.** The content was capped at `max-w-7xl` (1280px), which on a 1440p or wider
 * monitor left a third of the screen as empty margin — while the screens that actually
 * need the room, the estimates grid and the calendar's seven-column week, were the ones
 * being squeezed. It is now `max-w-[1600px]`, wide enough to use a large display and
 * still short of the line where a table becomes hard to track across. Prose-shaped
 * screens set their own narrower cap and are deliberately unaffected — see
 * `HomePage`.
 *
 * **Below `md` the nav collapses into a drawer.** It used to scroll sideways instead,
 * which meant a phone showed the first two links and no indication the others existed.
 *
 * **Breakpoints here and on every page inside are the app column's, not the window's**
 * (`app-sm:`, `app-md:` and so on). The shell sits in `AppFrame`, which can dock a panel
 * beside it, and the app has to lay itself out for the width it is actually given.
 */
import { useEffect, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useAuth, useIsElevated } from "@/auth/useAuth";
import { AppFrame } from "./AppFrame";
import { RoleBadge } from "./Badge";
import { Menu } from "./Menu";
import { ThemeToggle } from "./ThemeToggle";
import {
  AgentContextReporter,
  AgentLauncher,
  AgentLockBanner,
} from "@/features/agent/AgentLauncher";
import { AgentPanel } from "@/features/agent/AgentPanel";
import { AgentProvider, useAgent } from "@/features/agent/AgentProvider";
import { BrandMark } from "@/features/auth/AuthLayout";
import { cn } from "@/lib/cn";
import { setPreference } from "@/lib/theme";
import { useThemePreference } from "@/lib/useTheme";
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

/**
 * The provider sits outside the frame because the frame is drawn from it: whether a
 * panel is docked, and whether the app is locked. It is mounted here, once, and not on
 * any page, so the panel and a live conversation survive moving between pages.
 */
export function AppShell() {
  return (
    <AgentProvider>
      <Shell />
    </AgentProvider>
  );
}

function Shell() {
  const agent = useAgent();
  const elevated = useIsElevated();
  const items = NAV.filter((item) => !item.elevatedOnly || elevated);
  const [menuOpen, setMenuOpen] = useState(false);
  const { pathname } = useLocation();

  // Navigating is the one thing that should always close the drawer. Without this it
  // stays open over the page you just asked for, which reads as a broken tap.
  useEffect(() => setMenuOpen(false), [pathname]);

  const link = ({ isActive }: { isActive: boolean }) =>
    cn(
      "rounded-md px-3 py-1.5 text-sm font-medium whitespace-nowrap transition-colors",
      isActive
        ? "bg-brand-50 text-brand-700 dark:text-brand-300"
        : "text-gray-600 hover:bg-gray-100 hover:text-gray-900",
    );

  return (
    <AppFrame
      panel={agent?.panelOpen ? <AgentPanel /> : undefined}
      launcher={<AgentLauncher />}
      locked={agent?.state.mode === "working"}
      lockBanner={<AgentLockBanner />}
    >
      <AgentContextReporter />
      <header className="sticky top-0 z-30 border-b border-gray-200 bg-surface">
        <div className="mx-auto flex h-13 max-w-[1600px] items-center gap-3 px-4 app-sm:gap-6 app-sm:px-6">
          <button
            type="button"
            aria-label="Menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
            className="-ml-1 rounded-md p-1.5 text-gray-600 hover:bg-gray-100 app-md:hidden"
          >
            <MenuIcon open={menuOpen} />
          </button>

          <Link to="/" className="shrink-0">
            <BrandMark />
          </Link>

          <nav className="hidden flex-1 items-center gap-1 app-md:flex" aria-label="Main">
            {items.map((item) => (
              <NavLink key={item.to} to={item.to} className={link}>
                {item.label}
              </NavLink>
            ))}
          </nav>

          {/* Pushes the account menu right on narrow screens, where the nav that used to
              do it is hidden. */}
          <div className="flex-1 app-md:hidden" />

          <ThemeToggle className="-mr-1" />
          <AccountMenu />
        </div>

        {menuOpen && (
          <nav
            className="flex flex-col gap-1 border-t border-gray-200 px-3 py-2 app-md:hidden"
            aria-label="Main"
          >
            {items.map((item) => (
              <NavLink key={item.to} to={item.to} className={link}>
                {item.label}
              </NavLink>
            ))}
          </nav>
        )}
      </header>

      <main className="mx-auto w-full max-w-[1600px] flex-1 px-4 py-6 app-sm:px-6">
        <Outlet />
      </main>
    </AppFrame>
  );
}

function MenuIcon({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="size-5">
      {open ? (
        <path d="M5 5l10 10M15 5L5 15" stroke="currentColor" strokeWidth="1.6" />
      ) : (
        <path d="M3 6h14M3 10h14M3 14h14" stroke="currentColor" strokeWidth="1.6" />
      )}
    </svg>
  );
}

function AccountMenu() {
  const { profile, signOut } = useAuth();
  const preference = useThemePreference();
  const navigate = useNavigate();

  if (!profile) return null;

  const displayName = profile.full_name || profile.email;

  return (
    <Menu
      label="Account"
      trigger={
        <>
          <Avatar url={profile.avatar_url} name={displayName} />
          <span className="hidden text-sm font-medium text-gray-700 app-sm:inline">{displayName}</span>
        </>
      }
    >
      {(close) => (
        <>
          <div className="border-b border-gray-100 px-3 py-2">
            <p className="truncate text-sm font-medium text-gray-900">{displayName}</p>
            <p className="truncate text-xs text-gray-500">{profile.email}</p>
            <div className="mt-1.5">
              <RoleBadge role={profile.role as Role} />
            </div>
          </div>

          <MenuLink to="/profile" onSelect={close}>
            Profile
          </MenuLink>
          <MenuLink to="/settings" onSelect={close}>
            Settings
          </MenuLink>

          {/* Only offered once the header toggle has overridden the OS. Shown always, it
              would be an item that does nothing for everyone who never touched the
              toggle. */}
          {preference !== "system" && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setPreference("system");
                close();
              }}
              className="block w-full px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-50"
            >
              Match system theme
            </button>
          )}

          <button
            type="button"
            role="menuitem"
            onClick={async () => {
              close();
              await signOut();
              navigate("/login", { replace: true });
            }}
            className="w-full border-t border-gray-100 px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-50"
          >
            Sign out
          </button>
        </>
      )}
    </Menu>
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
        "flex shrink-0 items-center justify-center rounded-full bg-brand-50 text-xs font-semibold text-brand-700 dark:text-brand-300 ring-1 ring-brand-100",
      )}
    >
      {name.trim().charAt(0).toUpperCase() || "?"}
    </span>
  );
}
