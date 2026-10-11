/**
 * Team settings: the rate catalogue, custom units and categories, notification toggles.
 *
 * All of it is **team-wide and stored server-side**. In the legacy app it lived in
 * `localStorage`, which meant the universal rate list was neither universal nor a list
 * anyone else could see: two estimators on the same job had different prices, and
 * clearing site data lost the lot. The notification switches were worse — they gated
 * nothing at all, because the emails are sent server-side and the browser was never
 * consulted. They now actually govern the mail.
 *
 * Everyone can read this page; the estimate editor needs the catalogue and the custom
 * units to render a line. Only owners and admins can change anything, and the page says
 * so rather than silently disabling every control.
 */
import { useState } from "react";
import { ApiError } from "@/api/client";
import {
  useCatalogue,
  useCreateCatalogueItem,
  useDeleteCatalogueItem,
  useTeamSettings,
  useUpdateTeamSettings,
} from "@/api/queries/settings";
import type { CatalogueItemOut, TeamSettingsOut } from "@/api/types";
import { useUsers } from "@/api/queries/users";
import { useIsElevated } from "@/auth/useAuth";
import { Button } from "@/components/Button";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Alert, Card, ErrorState, LoadingState, PageHeader } from "@/components/feedback";
import { Field, Input, Select, TextField } from "@/components/form";
import { Table, TableWrap, TBody, Td, Th, THead, Tr } from "@/components/Table";
import { useToast } from "@/components/Toast";
import { ITEM_CATEGORIES, ITEM_UNITS } from "@/domain/enums";
import { formatMoney, isNegativeMoney, toMoneyString } from "@/domain/money";
import { displayName } from "@/lib/format";

/** Copy for each notification key the API accepts. */
const NOTIFICATIONS: { key: string; label: string; description: string }[] = [
  {
    key: "estimate_locked",
    label: "Estimate locked",
    description: "When an owner locks an estimate.",
  },
  {
    key: "member_joined",
    label: "New member",
    description: "When someone signs in for the first time.",
  },
  {
    key: "member_removed",
    label: "Member removed",
    description: "When someone is removed from the team.",
  },
];

export function SettingsPage() {
  const elevated = useIsElevated();
  const settings = useTeamSettings();
  const catalogue = useCatalogue();

  if (settings.isPending || catalogue.isPending) return <LoadingState label="Loading settings…" />;
  if (settings.error) {
    return <ErrorState error={settings.error} onRetry={() => void settings.refetch()} />;
  }

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Settings"
        subtitle="Shared by the whole team, not just this browser."
      />

      {!elevated && (
        <Alert tone="info">
          These are team-wide settings. You can see them, but only an owner or admin can
          change them.
        </Alert>
      )}

      <Reviewer settings={settings.data} canEdit={elevated} />
      <RateList items={catalogue.data ?? []} canEdit={elevated} />
      <ListSetting
        title="Custom units"
        description="Beyond the built-in units. Shown alongside them in the estimate editor."
        field="custom_units"
        values={settings.data.custom_units ?? []}
        builtIn={[...ITEM_UNITS]}
        addLabel="Add unit"
        canEdit={elevated}
      />
      <ListSetting
        title="Custom categories"
        description="Beyond the built-in categories."
        field="custom_categories"
        values={settings.data.custom_categories ?? []}
        builtIn={[...ITEM_CATEGORIES]}
        addLabel="Add category"
        canEdit={elevated}
      />
      <Notifications settings={settings.data} canEdit={elevated} />
    </div>
  );
}

function Reviewer({ settings, canEdit }: { settings: TeamSettingsOut; canEdit: boolean }) {
  const toast = useToast();
  const update = useUpdateTeamSettings();
  const users = useUsers();

  const current = settings.default_reviewer?.id ?? "";

  async function choose(id: string) {
    if (!id) return;
    try {
      await update.mutateAsync({ default_reviewer_id: id });
    } catch (caught) {
      toast.error(
        caught instanceof ApiError ? caught.message : "The reviewer could not be saved.",
      );
    }
  }

  return (
    <Card className="flex flex-col gap-3 p-5">
      <div>
        <h2 className="text-xs font-medium tracking-wide text-gray-500 uppercase">Reviewer</h2>
        <p className="mt-1 text-sm text-gray-500">
          Every estimate sent for approval goes to this person. They receive a link and can
          approve, reject, or request changes without signing in.
        </p>
      </div>

      {/* Anyone on the team, not just owners and admins. Who signs off on an estimate is a
          business decision, and the approval is authorised by the emailed link rather than
          by the reviewer's role — so naming a member here grants them nothing extra. */}
      <Field label="Who approves estimates">
        {(props) => (
          <Select
            {...props}
            value={current}
            disabled={!canEdit || users.isPending || update.isPending}
            onChange={(event) => void choose(event.target.value)}
          >
            <option value="" disabled>
              {users.isPending ? "Loading the team…" : "Choose someone"}
            </option>
            {(users.data ?? []).map((user) => (
              <option key={user.id} value={user.id}>
                {displayName(user)} — {user.email}
              </option>
            ))}
          </Select>
        )}
      </Field>

      {!settings.default_reviewer && (
        <Alert tone="warning">
          Nobody is set up to approve estimates yet, so sending one for review will fail until
          someone is chosen here.
        </Alert>
      )}
    </Card>
  );
}

function RateList({ items, canEdit }: { items: CatalogueItemOut[]; canEdit: boolean }) {
  const toast = useToast();
  const create = useCreateCatalogueItem();
  const remove = useDeleteCatalogueItem();

  const [name, setName] = useState("");
  const [category, setCategory] = useState<string>(ITEM_CATEGORIES[0]);
  const [unit, setUnit] = useState<string>(ITEM_UNITS[0]);
  const [cost, setCost] = useState("");
  const [pendingDelete, setPendingDelete] = useState<CatalogueItemOut | null>(null);

  const costInvalid = isNegativeMoney(cost);

  async function add() {
    try {
      await create.mutateAsync({
        name: name.trim(),
        category,
        unit,
        unit_cost: toMoneyString(cost),
        notes: "",
      });
      setName("");
      setCost("");
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : "The rate could not be added.");
    }
  }

  async function confirmDelete() {
    const doomed = pendingDelete;
    setPendingDelete(null);
    if (!doomed) return;

    try {
      await remove.mutateAsync(doomed.id);
      toast.success("Rate removed.");
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : "The rate could not be removed.");
    }
  }

  return (
    <Card className="flex flex-col gap-4 p-5">
      <div>
        <h2 className="text-xs font-medium tracking-wide text-gray-500 uppercase">
          Universal rate list
        </h2>
        <p className="mt-1 text-sm text-gray-500">
          Add a priced line to an estimate in one click.
        </p>
      </div>

      {items.length === 0 ? (
        <p className="text-sm text-gray-500">No rates yet.</p>
      ) : (
        <TableWrap>
          <Table>
            <THead>
              <Tr>
                <Th>Item</Th>
                <Th>Category</Th>
                <Th>Unit</Th>
                <Th numeric>Unit cost</Th>
                <Th>
                  <span className="sr-only">Actions</span>
                </Th>
              </Tr>
            </THead>
            <TBody>
              {items.map((item) => (
                <Tr key={item.id}>
                  <Td>{item.name}</Td>
                  <Td>{item.category || "—"}</Td>
                  <Td>{item.unit || "—"}</Td>
                  <Td numeric>{formatMoney(item.unit_cost)}</Td>
                  <Td>
                    {canEdit && (
                      <div className="flex justify-end">
                        <button
                          type="button"
                          aria-label={`Remove ${item.name}`}
                          onClick={() => setPendingDelete(item)}
                          className="rounded p-1 text-xs text-gray-400 hover:bg-danger-50 hover:text-danger-600 hover:dark:text-danger-400"
                        >
                          &#10005;
                        </button>
                      </div>
                    )}
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        </TableWrap>
      )}

      {canEdit && (
        <div className="grid gap-3 border-t border-gray-100 pt-4 app-sm:grid-cols-[2fr_1fr_1fr_1fr_auto] app-sm:items-end">
          <TextField
            label="Item"
            value={name}
            placeholder="Drywall"
            onChange={(event) => setName(event.target.value)}
          />
          <Field label="Category">
            {(props) => (
              <Select {...props} value={category} onChange={(e) => setCategory(e.target.value)}>
                {ITEM_CATEGORIES.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Unit">
            {(props) => (
              <Select {...props} value={unit} onChange={(e) => setUnit(e.target.value)}>
                {ITEM_UNITS.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field
            label="Unit cost"
            {...(costInvalid ? { error: "Cannot be negative." } : {})}
          >
            {(props) => (
              <Input
                {...props}
                inputMode="decimal"
                className="tnum text-right"
                value={cost}
                placeholder="0.00"
                onChange={(event) => setCost(event.target.value)}
              />
            )}
          </Field>
          <Button
            busy={create.isPending}
            disabled={!name.trim() || costInvalid}
            onClick={() => void add()}
          >
            Add rate
          </Button>
        </div>
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Remove this rate?"
        confirmLabel="Remove"
        busy={remove.isPending}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => void confirmDelete()}
      >
        <p>
          <strong>{pendingDelete?.name}</strong> will no longer be offered when adding a line.
        </p>
        <p className="mt-2">
          Estimates already priced from it keep their prices — a line records the values it
          was built with, not a live reference.
        </p>
      </ConfirmDialog>
    </Card>
  );
}

function ListSetting({
  title,
  description,
  field,
  values,
  builtIn,
  addLabel,
  canEdit,
}: {
  title: string;
  description: string;
  field: "custom_units" | "custom_categories";
  values: string[];
  builtIn: string[];
  /** Distinct per section: three buttons all called "Add" read as three identical
   *  controls to anyone navigating by button name. */
  addLabel: string;
  canEdit: boolean;
}) {
  const toast = useToast();
  const update = useUpdateTeamSettings();
  const [draft, setDraft] = useState("");

  const duplicate =
    draft.trim().length > 0 &&
    [...builtIn, ...values].some((value) => value.toLowerCase() === draft.trim().toLowerCase());

  async function save(next: string[]) {
    try {
      await update.mutateAsync({ [field]: next });
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : "That change could not be saved.");
    }
  }

  return (
    <Card className="flex flex-col gap-3 p-5">
      <div>
        <h2 className="text-xs font-medium tracking-wide text-gray-500 uppercase">{title}</h2>
        <p className="mt-1 text-sm text-gray-500">{description}</p>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {builtIn.map((value) => (
          <span
            key={value}
            title="Built in — cannot be removed"
            className="rounded-full bg-gray-100 px-2.5 py-1 text-xs text-gray-500"
          >
            {value}
          </span>
        ))}
        {values.map((value) => (
          <span
            key={value}
            className="flex items-center gap-1 rounded-full bg-brand-50 px-2.5 py-1 text-xs text-brand-700 dark:text-brand-300"
          >
            {value}
            {canEdit && (
              <button
                type="button"
                aria-label={`Remove ${value}`}
                onClick={() => void save(values.filter((item) => item !== value))}
                className="text-brand-500 dark:text-brand-300 hover:text-brand-800 hover:dark:text-brand-300"
              >
                &#10005;
              </button>
            )}
          </span>
        ))}
      </div>

      {canEdit && (
        <div className="flex items-end gap-2">
          <div className="w-48">
            <TextField
              label={`Add to ${title.toLowerCase()}`}
              value={draft}
              {...(duplicate ? { error: "Already in the list." } : {})}
              onChange={(event) => setDraft(event.target.value)}
            />
          </div>
          <Button
            busy={update.isPending}
            disabled={!draft.trim() || duplicate}
            onClick={async () => {
              await save([...values, draft.trim()]);
              setDraft("");
            }}
          >
            {addLabel}
          </Button>
        </div>
      )}
    </Card>
  );
}

function Notifications({
  settings,
  canEdit,
}: {
  settings: TeamSettingsOut;
  canEdit: boolean;
}) {
  const toast = useToast();
  const update = useUpdateTeamSettings();
  const prefs = settings.notification_prefs ?? {};

  async function toggle(key: string, enabled: boolean) {
    try {
      // Only the switch that moved. The API merges rather than replaces, so sending the
      // whole map would be a way to reset toggles nobody touched.
      await update.mutateAsync({ notification_prefs: { [key]: enabled } });
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : "That setting could not be saved.");
    }
  }

  return (
    <Card className="flex flex-col gap-3 p-5">
      <div>
        <h2 className="text-xs font-medium tracking-wide text-gray-500 uppercase">
          Admin notifications
        </h2>
        <p className="mt-1 text-sm text-gray-500">
          Emails to every owner and admin. These take effect for the whole team.
        </p>
      </div>

      <ul className="flex flex-col divide-y divide-gray-100">
        {NOTIFICATIONS.map(({ key, label, description }) => (
          <li key={key} className="flex items-center gap-3 py-3">
            <input
              id={`pref-${key}`}
              type="checkbox"
              checked={prefs[key] ?? true}
              disabled={!canEdit || update.isPending}
              onChange={(event) => void toggle(key, event.target.checked)}
              className="size-4 shrink-0 rounded border-gray-300 text-brand-600 dark:text-brand-300 focus:ring-brand-500"
            />
            <label htmlFor={`pref-${key}`} className="min-w-0 flex-1">
              <span className="block text-sm text-gray-900">{label}</span>
              <span className="block text-xs text-gray-500">{description}</span>
            </label>
          </li>
        ))}
      </ul>

      <p className="text-xs text-gray-500">
        Access attempts by removed users are always sent. That is a security signal rather
        than a routine update, so it is deliberately not switchable.
      </p>
    </Card>
  );
}
