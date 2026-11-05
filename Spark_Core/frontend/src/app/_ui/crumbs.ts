/** One breadcrumb in the member app's top bar. The last one is the current page and has no link. */
export interface Crumb {
  label: string;
  href?: string;
}

interface CrumbWorkspace {
  slug: string;
  name: string;
}

interface CrumbProject {
  key: string;
  name: string;
}

/** Breadcrumbs for the shell's top bar, worked out from the address and what the shell already knows. */
export function shellCrumbs({ pathname, current, workspace, projects }: {
  pathname: string;
  current: string;
  workspace: CrumbWorkspace | null;
  projects: CrumbProject[] | null;
}): Crumb[] {
  if (pathname.startsWith("/settings")) return [{ label: "Settings" }];
  const base = workspace ? `/w/${workspace.slug}` : null;
  if (!workspace || !base || (pathname !== base && !pathname.startsWith(`${base}/`))) return current ? [{ label: current }] : [];

  const rest = pathname.slice(base.length).split("/").filter(Boolean);
  if (rest.length === 0) return [{ label: workspace.name }];

  const crumbs: Crumb[] = [{ label: workspace.name, href: base }];
  const projectsCrumb: Crumb = { label: "Projects", href: `${base}#projects` };
  if (rest[0] === "p" && rest[1]) {
    const key = decodeURIComponent(rest[1]);
    const project = projects?.find((item) => item.key === key);
    return [...crumbs, projectsCrumb, { label: project?.name ?? key }];
  }
  if (rest[0] === "projects" && rest[1] === "new") return [...crumbs, projectsCrumb, { label: "New project" }];
  return current ? [...crumbs, { label: current }] : crumbs;
}
