"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";

import { useAuth } from "../auth-context";
import { SparkLogo as SparkMark } from "../brand/spark-logo";
import { initials } from "../components";
import { WorkspaceSplash } from "../w/_components/splash";
import { ApiError, SESSION_EXPIRED_EVENT, messageOf, workspaceApi, type Workspace } from "../w/_lib/api";
import { cleanSlugInput, deriveSlug, isValidSlug } from "./slug";

const NAME_MAX = 80;
const SLUG_RULE = "Use 3–40 lowercase letters, numbers or hyphens, starting and ending with a letter or number.";

const METHODS = [
  { name: "Scrum", tone: "blue", text: "Sprints and a backlog" },
  { name: "Kanban", tone: "green", text: "A continuous flow" },
  { name: "Waterfall", tone: "amber", text: "Phases and milestones" },
] as const;

export default function OnboardingPage() {
  const { isAuthenticated, isLoading, refreshSession, user, workspaces } = useAuth();
  const router = useRouter();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [slugError, setSlugError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!isLoading && !isAuthenticated) router.replace(`/login?redirect=${encodeURIComponent("/onboarding")}`);
  }, [isAuthenticated, isLoading, router]);

  useEffect(() => {
    const onExpired = () => void refreshSession();
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
  }, [refreshSession]);

  if (isLoading || !isAuthenticated) return <WorkspaceSplash label="Checking your session…" />;

  const onNameChange = (value: string) => {
    setName(value);
    setNameError(null);
    if (!slugEdited) {
      setSlug(deriveSlug(value));
      setSlugError(null);
    }
  };

  const onSlugChange = (value: string) => {
    const cleaned = cleanSlugInput(value);
    setSlug(cleaned);
    // Clearing the field hands the address back to the name.
    setSlugEdited(cleaned !== "");
    setSlugError(null);
  };

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting) return;
    const trimmed = name.trim();
    const nextSlug = slug || deriveSlug(trimmed);
    const nameProblem = trimmed === "" ? "Give your workspace a name." : trimmed.length > NAME_MAX ? `Keep the name under ${NAME_MAX} characters.` : null;
    const slugProblem = isValidSlug(nextSlug) ? null : SLUG_RULE;
    setNameError(nameProblem);
    setSlugError(slugProblem);
    setFormError(null);
    if (nameProblem || slugProblem) return;

    setSubmitting(true);
    try {
      const { data } = await workspaceApi<Workspace>("/workspaces", { method: "POST", body: { name: trimmed, slug: nextSlug } });
      await refreshSession();
      router.push(`/w/${data.slug}`);
    } catch (error) {
      setSubmitting(false);
      if (error instanceof ApiError && error.code === "slug_taken") setSlugError("That address is taken. Try another.");
      else if (error instanceof ApiError && error.code === "too_many_workspaces") setFormError("You've reached the limit of workspaces you can own. Leave or hand over one before creating another.");
      else setFormError(messageOf(error));
    }
  };

  const previewName = name.trim() || "Your workspace";
  const previewSlug = slug || deriveSlug(name) || "your-team";

  return (
    <div className="wsOnboarding">
      <div aria-hidden="true" className="authAmbientGrid" />
      <div aria-hidden="true" className="wsGlow" />
      <div aria-hidden="true" className="wsGlow two" />
      <header className="wsOnboardingHeader">
        <Link aria-label="Spark home" className="sparkBrand" href="/">
          <SparkMark />
          <span>Spark</span>
        </Link>
        <div className="wsOnboardingUser">
          {workspaces.length > 0 && <Link className="wsBackLink" href="/workspace">Back to my workspaces</Link>}
          <span aria-hidden="true" className="avatar">{initials(user?.displayName, "U")}</span>
        </div>
      </header>

      <main className="wsOnboardingMain">
        <div className="wsOnboardingIntro">
          <p className="sparkKicker wsPulse"><span aria-hidden="true" />Get started</p>
          <h1>Name your workspace</h1>
          <p className="wsLead">A workspace is home for your team&apos;s projects, people and decisions. Pick a name everyone recognises — you can change it later.</p>
        </div>

        <div className="wsOnboardingGrid">
          <form className="wsFormCard" noValidate onSubmit={onSubmit}>
            <div className="wsField">
              <label htmlFor="workspace-name">Workspace name</label>
              <input
                aria-describedby={nameError ? "workspace-name-error" : "workspace-name-hint"}
                aria-invalid={nameError ? true : undefined}
                autoComplete="organization"
                autoFocus
                id="workspace-name"
                maxLength={NAME_MAX}
                onChange={(event) => onNameChange(event.target.value)}
                placeholder="Northstar Labs"
                value={name}
              />
              {nameError
                ? <p className="wsFieldError" id="workspace-name-error" role="alert">{nameError}</p>
                : <p className="wsFieldHint" id="workspace-name-hint">Your team or company name, up to {NAME_MAX} characters.</p>}
            </div>

            <div className="wsField">
              <label htmlFor="workspace-slug">Workspace address</label>
              <div className="wsAddress" data-invalid={slugError ? true : undefined}>
                <span aria-hidden="true">spark.app/w/</span>
                <input
                  aria-describedby={slugError ? "workspace-slug-error" : "workspace-slug-hint"}
                  aria-invalid={slugError ? true : undefined}
                  autoCapitalize="none"
                  autoComplete="off"
                  id="workspace-slug"
                  onChange={(event) => onSlugChange(event.target.value)}
                  placeholder="your-team"
                  spellCheck={false}
                  value={slug}
                />
              </div>
              {slugError
                ? <p className="wsFieldError" id="workspace-slug-error" role="alert">{slugError}</p>
                : <p className="wsFieldHint" id="workspace-slug-hint">Lowercase letters, numbers and hyphens. Teammates will use this link.</p>}
            </div>

            {formError && <div className="wsAlert" role="alert">{formError}</div>}

            <button className="sparkPrimary wsSubmit" disabled={submitting} type="submit">
              {submitting ? "Creating workspace…" : "Create workspace"}
              {!submitting && <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6" /></svg>}
            </button>
            <p className="wsFormFoot">You&apos;ll be the owner. Invite teammates as soon as it&apos;s ready.</p>
          </form>

          <aside aria-label="Preview" className="wsPreviewCard">
            <div className="wsPreviewBar">
              <span aria-hidden="true" className="wsPreviewDots"><i /><i /><i /></span>
              <p className="wsPreviewUrl" data-testid="slug-preview">spark.app/w/{previewSlug}</p>
            </div>
            <div className="wsPreviewBody">
              <div className="wsPreviewWorkspace">
                <span className="avatar">{initials(previewName, "W")}</span>
                <div>
                  <strong>{previewName}</strong>
                  <span>1 member · You&apos;re the owner</span>
                </div>
              </div>
              <div className="wsPreviewSteps">
                <p className="wsPreviewStep done"><span aria-hidden="true">1</span>Name your workspace</p>
                <p className="wsPreviewStep"><span aria-hidden="true">2</span>Invite your teammates</p>
                <p className="wsPreviewStep"><span aria-hidden="true">3</span>Start your first project</p>
              </div>
              <div className="wsNext">
                <p className="wsNextTitle">Next: choose how your team works — Scrum, Kanban or Waterfall</p>
                <ul className="wsNextMethods">
                  {METHODS.map((method) => (
                    <li key={method.name}>
                      <span className={`tag ${method.tone}`}>{method.name}</span>
                      <span>{method.text}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </aside>
        </div>
      </main>
    </div>
  );
}
