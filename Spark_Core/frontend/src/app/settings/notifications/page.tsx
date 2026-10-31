"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

import { PageTitle, WorkspaceShell } from "../../components";
import { useAuth } from "../../auth-context";
import {
  fetchNotificationPreferences,
  saveNotificationPreferences,
  type EmailPreferences,
  type NotificationPreferences,
} from "../../_lib/preferences";
import { ApiError, SESSION_EXPIRED_EVENT, messageOf } from "../../w/_lib/api";
import { viewerZone, zoneChoices } from "../../w/_lib/schedule";

const SWITCHES: Array<[keyof EmailPreferences, string]> = [
  ["taskAssigned", "Task assigned to me"],
  ["dueReminders", "Due-soon and overdue reminders — daily at 8:00"],
  ["weeklyDigest", "Weekly digest — Mondays at 8:00"],
];

type Load = { status: "loading" } | { status: "error"; message: string } | { status: "ready" };

function Settings() {
  const { isAuthenticated, isLoading } = useAuth();
  const router = useRouter();
  const zoneList = useId();
  const [reloadKey, setReloadKey] = useState(0);
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [saved, setSaved] = useState<NotificationPreferences | null>(null);
  const [draft, setDraft] = useState<NotificationPreferences | null>(null);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);
  const [zoneError, setZoneError] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [browserZone] = useState(viewerZone);
  const alive = useRef(true);
  const busy = useRef(false);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const toLogin = useCallback(() => router.replace(`/login?redirect=${encodeURIComponent("/settings/notifications")}`), [router]);

  useEffect(() => {
    if (!isLoading && !isAuthenticated) toLogin();
  }, [isAuthenticated, isLoading, toLogin]);

  useEffect(() => {
    window.addEventListener(SESSION_EXPIRED_EVENT, toLogin);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, toLogin);
  }, [toLogin]);

  useEffect(() => {
    const controller = new AbortController();
    fetchNotificationPreferences(controller.signal)
      .then((preferences) => {
        setSaved(preferences);
        setDraft(preferences);
        setLoad({ status: "ready" });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setLoad({ status: "error", message: messageOf(error) });
      });
    return () => controller.abort();
  }, [reloadKey]);

  const zones = useMemo(() => zoneChoices(saved?.timezone ?? "", browserZone), [saved, browserZone]);

  const changed = !!saved && !!draft && (
    SWITCHES.some(([key]) => saved.email[key] !== draft.email[key]) || saved.timezone !== draft.timezone
  );

  const edit = (update: (current: NotificationPreferences) => NotificationPreferences) => {
    setDraft((current) => (current ? update(current) : current));
    setDone(false);
    setFailure(null);
  };

  const toggle = (key: keyof EmailPreferences) => edit((current) => ({ ...current, email: { ...current.email, [key]: !current.email[key] } }));
  const setZone = (timezone: string) => {
    setZoneError(null);
    edit((current) => ({ ...current, timezone }));
  };

  const save = async () => {
    if (!draft || !changed || busy.current) return;
    busy.current = true;
    setSaving(true);
    setDone(false);
    setFailure(null);
    setZoneError(null);
    try {
      const next = await saveNotificationPreferences({ ...draft, timezone: draft.timezone.trim() });
      if (!alive.current) return;
      setSaved(next);
      setDraft(next);
      setDone(true);
    } catch (error) {
      if (!alive.current || (error instanceof ApiError && error.status === 401)) return;
      if (error instanceof ApiError && error.status === 400) setZoneError(error.message);
      else setFailure(messageOf(error));
    } finally {
      busy.current = false;
      if (alive.current) setSaving(false);
    }
  };

  return (
    <>
      <PageTitle eyebrow="Settings" title="Email notifications" />
      {load.status === "loading" && (
        <div aria-busy="true" className="notificationLoading" role="status">
          <span className="wsSrOnly">Loading settings…</span>
          {Array.from({ length: 3 }, (_, index) => <span className="vizSkeleton" key={index} />)}
        </div>
      )}
      {load.status === "error" && (
        <div className="wsCard notificationState" role="alert">
          <p>{load.message}</p>
          <button className="sparkSecondary" onClick={() => { setLoad({ status: "loading" }); setReloadKey((value) => value + 1); }} type="button">Try again</button>
        </div>
      )}
      {load.status === "ready" && draft && (
        <form className="wsCard settingsCard" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <section aria-labelledby="settings-email-heading">
            <h2 id="settings-email-heading">Send me an email when</h2>
            <ul className="settingsSwitches">
              {SWITCHES.map(([key, label]) => (
                <li key={key}>
                  <span id={`switch-${key}`}>{label}</span>
                  <button aria-checked={draft.email[key]} aria-labelledby={`switch-${key}`} className="settingsSwitch" onClick={() => toggle(key)} role="switch" type="button">
                    <span aria-hidden="true" className="settingsSwitchKnob" />
                  </button>
                </li>
              ))}
            </ul>
            <p className="wsFieldHint">Invitations and account emails are always sent.</p>
          </section>
          <div className="wsField">
            <label htmlFor="settings-zone">Time zone</label>
            <input
              aria-describedby={zoneError ? "settings-zone-error settings-zone-hint" : "settings-zone-hint"}
              aria-invalid={zoneError ? true : undefined}
              autoComplete="off"
              id="settings-zone"
              list={zoneList}
              onChange={(event) => setZone(event.target.value)}
              spellCheck={false}
              type="text"
              value={draft.timezone}
            />
            <datalist id={zoneList}>{zones.map((zone) => <option key={zone} value={zone} />)}</datalist>
            {zoneError && <p className="wsFieldError" id="settings-zone-error">{zoneError}</p>}
            <p className="wsFieldHint" id="settings-zone-hint">Reminders and the weekly digest are sent at 8:00 in this time zone.</p>
            {draft.timezone !== browserZone && (
              <button className="textButton settingsZoneLink" onClick={() => setZone(browserZone)} type="button">Use my browser&apos;s zone ({browserZone})</button>
            )}
          </div>
          <div className="settingsActions">
            <button className="sparkPrimary" disabled={!changed || saving} type="submit">{saving ? "Saving…" : "Save"}</button>
            <p aria-live="polite" className="settingsStatus" role="status">{done ? "Saved" : ""}</p>
          </div>
          {failure && <p className="notificationNotice" role="alert">{failure}</p>}
        </form>
      )}
    </>
  );
}

export default function NotificationSettingsPage() {
  return (
    <WorkspaceShell current="Settings">
      <Settings />
    </WorkspaceShell>
  );
}
