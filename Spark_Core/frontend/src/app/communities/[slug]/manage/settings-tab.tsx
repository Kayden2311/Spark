"use client";

import { useState, type FormEvent } from "react";

import { CommunityFieldset, changedFields, validate, valuesOf, type FieldErrors, type FieldValues } from "../../_components/community-fields";
import { ApiError, communitiesApi, membershipErrorMessage } from "../../_lib/api";
import type { ManageContext } from "./manage-view";

export const STALE_MESSAGE = "Updated by a teammate. Their changes are loaded below; review them and save again.";

/**
 * Community settings. The parent remounts this tab (key = version) whenever the saved community changes, so
 * the form always starts from the version it will send in If-Match.
 */
export function SettingsTab({ context, stale, onSaved, onStale }: { context: ManageContext; stale: boolean; onSaved(): void; onStale(error: unknown): void }) {
  const { community, notify, handleAccess, update } = context;
  const [saved] = useState<FieldValues>(() => valuesOf(community));
  const [values, setValues] = useState<FieldValues>(saved);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const patch = changedFields(saved, values);
  const dirty = Object.keys(patch).length > 0;

  const change = (next: Partial<FieldValues>) => {
    setValues((current) => ({ ...current, ...next }));
    setErrors((current) => {
      const cleared = { ...current };
      for (const key of Object.keys(next) as Array<keyof FieldValues>) delete cleared[key];
      return cleared;
    });
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !dirty) return;
    const found = validate(values);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setBusy(true);
    setProblem(null);
    try {
      const updated = await communitiesApi.update(community.id, community.version, patch);
      setBusy(false);
      onSaved();
      notify("Settings saved.");
      update(() => updated);
    } catch (error) {
      setBusy(false);
      if (error instanceof ApiError && error.status === 412) {
        onStale(error);
        return;
      }
      if (handleAccess(error)) return;
      setProblem(membershipErrorMessage(error));
    }
  };

  return (
    <form aria-labelledby="settings-title" className="spPanel" noValidate onSubmit={(event) => void submit(event)}>
      <header className="spPanelHead">
        <div className="spPanelHeadText">
          <h2 id="settings-title">Settings</h2>
          <p>What people see in the directory and on the community page. The address stays the same.</p>
        </div>
      </header>
      <div className="spPanelBody">
        {stale && <p className="spAlert spAlertWarn spFormNotice" role="status">{STALE_MESSAGE}</p>}
        {problem && <p className="spAlert spAlertDanger spFormNotice" role="alert">{problem}</p>}
        <CommunityFieldset disabled={busy} errors={errors} idPrefix="settings" onChange={change} savedVisibility={saved.visibility} values={values} />
      </div>
      <footer className="spPanelFoot">
        <button className="spBtn spBtnGhost" disabled={busy || !dirty} onClick={() => { setValues(saved); setErrors({}); }} type="button">Discard changes</button>
        <button className="spBtn spBtnPrimary" disabled={busy || !dirty} type="submit">{busy ? "Saving…" : "Save changes"}</button>
      </footer>
    </form>
  );
}
