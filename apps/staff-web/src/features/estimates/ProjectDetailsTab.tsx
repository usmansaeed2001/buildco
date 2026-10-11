/**
 * The estimate's identifying fields.
 *
 * These autosave on the same debounce as the room document, so there is no Save button
 * — matching the legacy editor, where every field called `scheduleSave()` on input.
 *
 * The claim identifier is shown but not editable. The server assigns it (`CLM-######`,
 * generated with a collision retry in `estimate_service.create_estimate`) and
 * `EstimateUpdate` has no field for it, so an input here would be a control that
 * silently does nothing.
 */
import { Card } from "@/components/feedback";
import { Field, Input, TextField, Textarea } from "@/components/form";
import type { EstimateDetails } from "./document";

export function ProjectDetailsTab({
  details,
  identifier,
  readOnly,
  onChange,
}: {
  details: EstimateDetails;
  identifier: string;
  readOnly: boolean;
  onChange: <K extends keyof EstimateDetails>(field: K, value: EstimateDetails[K]) => void;
}) {
  return (
    <Card className="mt-4 p-5">
      <div className="grid gap-4 app-sm:grid-cols-2">
        <TextField
          label="Project name"
          value={details.project_name}
          disabled={readOnly}
          onChange={(event) => onChange("project_name", event.target.value)}
        />

        <TextField
          label="Client name"
          value={details.client_name}
          disabled={readOnly}
          onChange={(event) => onChange("client_name", event.target.value)}
        />

        <Field label="Claim ID" hint="Assigned when the estimate is created.">
          {(props) => <Input {...props} value={identifier} readOnly className="font-mono" />}
        </Field>

        <TextField
          label="Project manager"
          value={details.pm_name}
          disabled={readOnly}
          onChange={(event) => onChange("pm_name", event.target.value)}
        />

        <TextField
          label="Insurance carrier"
          value={details.insurance_carrier}
          disabled={readOnly}
          onChange={(event) => onChange("insurance_carrier", event.target.value)}
        />

        <div className="app-sm:col-span-2">
          <Field label="Notes">
            {(props) => (
              <Textarea
                {...props}
                rows={4}
                value={details.notes}
                disabled={readOnly}
                placeholder="Anything the reviewer should know"
                onChange={(event) => onChange("notes", event.target.value)}
              />
            )}
          </Field>
        </div>
      </div>
    </Card>
  );
}
