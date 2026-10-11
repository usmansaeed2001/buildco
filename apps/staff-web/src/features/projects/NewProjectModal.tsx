/**
 * Creating a project.
 *
 * Only the fields the API's `ProjectCreate` accepts. Costs and amounts collected are
 * absent on purpose — they are recorded as the job runs, and offering them here invites
 * someone to fill in a "collected" figure before any work has happened.
 */
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError } from "@/api/client";
import { useCreateProject } from "@/api/queries/projects";
import { useAssignableUsers } from "@/api/queries/users";
import { Button } from "@/components/Button";
import { Modal } from "@/components/Modal";
import { Alert } from "@/components/feedback";
import { Field, Input, Select, TextField, Textarea } from "@/components/form";
import { useToast } from "@/components/Toast";
import { isNegativeMoney, toMoneyString } from "@/domain/money";
import { displayName } from "@/lib/format";

export function NewProjectModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const navigate = useNavigate();
  const create = useCreateProject();
  const { data: users } = useAssignableUsers();

  const [ownerName, setOwnerName] = useState("");
  const [address, setAddress] = useState("");
  const [workType, setWorkType] = useState("");
  const [startDate, setStartDate] = useState("");
  const [assignedTo, setAssignedTo] = useState("");
  const [budget, setBudget] = useState("");
  const [notes, setNotes] = useState("");
  const [failure, setFailure] = useState<string | null>(null);

  function reset() {
    setOwnerName("");
    setAddress("");
    setWorkType("");
    setStartDate("");
    setAssignedTo("");
    setBudget("");
    setNotes("");
    setFailure(null);
  }

  async function submit() {
    setFailure(null);
    try {
      const project = await create.mutateAsync({
        owner_name: ownerName.trim(),
        address: address.trim(),
        work_type: workType.trim(),
        // Empty string is not a date; the field is nullable and must be omitted.
        ...(startDate ? { start_date: startDate } : {}),
        ...(assignedTo ? { assigned_to: assignedTo } : {}),
        // Money over the wire is a string, always.
        total_budget: toMoneyString(budget),
        notes: notes.trim(),
      });

      toast.success("Project created.");
      reset();
      onClose();
      navigate(`/projects/${project.id}`);
    } catch (caught) {
      setFailure(
        caught instanceof ApiError ? caught.message : "The project could not be created.",
      );
    }
  }

  // The API defaults every field, but a project with no owner and no address is
  // unfindable in a list of thirty. Requiring one of them is a UI decision.
  const usable = ownerName.trim().length > 0 || address.trim().length > 0;
  const budgetInvalid = isNegativeMoney(budget);

  return (
    <Modal
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      title="New project"
      size="lg"
      footer={
        <>
          <Button
            onClick={() => {
              reset();
              onClose();
            }}
            disabled={create.isPending}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            busy={create.isPending}
            disabled={!usable || budgetInvalid}
            onClick={() => void submit()}
          >
            Create project
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {failure && <Alert tone="danger">{failure}</Alert>}

        <div className="grid gap-4 app-sm:grid-cols-2">
          <TextField
            label="Home owner"
            value={ownerName}
            placeholder="Jordan Homeowner"
            onChange={(event) => setOwnerName(event.target.value)}
          />
          <TextField
            label="Address"
            value={address}
            placeholder="12 Oak Street"
            onChange={(event) => setAddress(event.target.value)}
          />
          <TextField
            label="Type of work"
            value={workType}
            placeholder="Water damage restoration"
            onChange={(event) => setWorkType(event.target.value)}
          />
          <Field label="Start date">
            {(props) => (
              <Input
                {...props}
                type="date"
                value={startDate}
                onChange={(event) => setStartDate(event.target.value)}
              />
            )}
          </Field>

          <Field label="Assign to" hint="They will be notified.">
            {(props) => (
              <Select
                {...props}
                value={assignedTo}
                onChange={(event) => setAssignedTo(event.target.value)}
              >
                <option value="">Unassigned</option>
                {(users ?? []).map((user) => (
                  <option key={user.id} value={user.id}>
                    {displayName(user)}
                  </option>
                ))}
              </Select>
            )}
          </Field>

          <Field
            label="Total budget"
            {...(budgetInvalid ? { error: "A budget cannot be negative." } : {})}
          >
            {(props) => (
              <Input
                {...props}
                inputMode="decimal"
                className="tnum text-right"
                value={budget}
                placeholder="0.00"
                onChange={(event) => setBudget(event.target.value)}
              />
            )}
          </Field>
        </div>

        <Field label="Notes">
          {(props) => (
            <Textarea
              {...props}
              rows={3}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
            />
          )}
        </Field>

        {!usable && (
          <p className="text-xs text-gray-500">Give the project an owner or an address.</p>
        )}
      </div>
    </Modal>
  );
}
