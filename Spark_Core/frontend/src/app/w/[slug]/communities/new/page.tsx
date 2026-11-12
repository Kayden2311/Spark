"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { PageHeader } from "../../../../_ui/page-header";
import { CommunityFieldset, emptyValues, toFields, validate, type FieldErrors, type FieldValues } from "../../../../communities/_components/community-fields";
import { ApiError, communitiesApi, isSignedOut, loginPath, membershipErrorMessage } from "../../../../communities/_lib/api";
import { cleanSlugInput, deriveSlug, isValidSlug } from "../../../../onboarding/slug";
import { canManage } from "../../../_lib/api";
import { useWorkspace } from "../../workspace-context";

const SLUG_TAKEN = "That address is taken. Try another one.";

export default function NewCommunityPage() {
  const { workspace } = useWorkspace();
  const router = useRouter();
  const [values, setValues] = useState<FieldValues>(emptyValues);
  const [slug, setSlug] = useState("");
  // Until the person edits the address, it follows the name.
  const [slugTouched, setSlugTouched] = useState(false);
  const [errors, setErrors] = useState<FieldErrors & { slug?: string }>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const back = `/w/${workspace.slug}/communities`;

  if (!canManage(workspace.role)) {
    return (
      <section aria-labelledby="community-restricted-title" className="spPanel spManageState">
        <div className="spEmpty">
          <h1 className="spEmptyTitle" id="community-restricted-title">Only workspace owners and admins can create communities.</h1>
          <p className="spEmptyText">Ask an owner or admin of {workspace.name} to host one, or browse the public directory.</p>
          <Link className="spBtn spBtnSecondary" href={back}>Back to communities</Link>
        </div>
      </section>
    );
  }

  const change = (next: Partial<FieldValues>) => {
    setValues((current) => ({ ...current, ...next }));
    if (next.name !== undefined && !slugTouched) setSlug(deriveSlug(next.name));
    setErrors((current) => {
      const cleared = { ...current };
      for (const key of Object.keys(next) as Array<keyof FieldValues>) delete cleared[key];
      if (next.name !== undefined && !slugTouched) delete cleared.slug;
      return cleared;
    });
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const found: FieldErrors & { slug?: string } = validate(values);
    if (!isValidSlug(slug)) found.slug = "Use 3–40 lowercase letters, numbers or hyphens, starting and ending with a letter or number.";
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setBusy(true);
    setProblem(null);
    try {
      const created = await communitiesApi.create(workspace.id, { slug, ...toFields(values) });
      router.push(`/communities/${encodeURIComponent(created.slug)}`);
    } catch (error) {
      setBusy(false);
      if (isSignedOut(error)) {
        router.push(loginPath(`/w/${workspace.slug}/communities/new`));
      } else if (error instanceof ApiError && error.code === "slug_taken") {
        setErrors((current) => ({ ...current, slug: SLUG_TAKEN }));
      } else if (error instanceof ApiError && error.code === "too_many_communities") {
        setProblem(`${workspace.name} has reached the limit of 10 communities, so it can't host another one.`);
      } else {
        setProblem(membershipErrorMessage(error));
      }
    }
  };

  const address = (
    <div className="spField">
      <label className="spLabel" htmlFor="community-slug">Address</label>
      <div className="spAffix" data-invalid={errors.slug ? true : undefined}>
        <span aria-hidden="true">spark.app/communities/</span>
        <input
          aria-describedby={errors.slug ? "community-slug-error" : "community-slug-preview"}
          aria-invalid={errors.slug ? true : undefined}
          autoCapitalize="off"
          autoComplete="off"
          id="community-slug"
          maxLength={40}
          onChange={(event) => {
            setSlugTouched(true);
            setSlug(cleanSlugInput(event.target.value));
            setErrors((current) => ({ ...current, slug: undefined }));
          }}
          spellCheck={false}
          value={slug}
        />
      </div>
      {errors.slug
        ? <p className="spError" id="community-slug-error" role="alert">{errors.slug}</p>
        : <p className="spHint" id="community-slug-preview">Link: <span className="spMono">{`spark.app/communities/${slug || "your-community"}`}</span>. It can&apos;t be changed later.</p>}
    </div>
  );

  return (
    <div className="spCommunityNew">
      <PageHeader lead={`${workspace.name} hosts it: workspace owners and admins can always manage it.`} title="New community" />
      <form aria-label="New community" className="spPanel" noValidate onSubmit={(event) => void submit(event)}>
        <div className="spPanelBody">
          {problem && <p className="spAlert spAlertDanger spFormNotice" role="alert">{problem}</p>}
          <CommunityFieldset afterName={address} disabled={busy} errors={errors} idPrefix="community" onChange={change} values={values} />
        </div>
        <footer className="spPanelFoot">
          <Link className="spBtn spBtnGhost" href={`/w/${workspace.slug}/communities`}>Cancel</Link>
          <button className="spBtn spBtnPrimary" disabled={busy} type="submit">{busy ? "Creating…" : "Create community"}</button>
        </footer>
      </form>
    </div>
  );
}
