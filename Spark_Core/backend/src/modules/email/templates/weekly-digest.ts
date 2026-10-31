import type { PlanStatus } from "../../work/domain/metrics.js";
import type { EmailMessage } from "../email-sender.js";
import { renderEmail } from "../layout.js";
import type { EmailList } from "../layout.js";
import { plain, shortDay } from "./format.js";

export interface DigestProject {
  key: string;
  name: string;
  methodology: string;
  donePercent: number;
  planPercent: number | null;
  status: PlanStatus;
  /** The plan window's name, for example the active sprint. */
  label: string | null;
}

export interface DigestItem {
  key: string;
  title: string;
  /** The due date as YYYY-MM-DD. */
  due: string;
  url: string;
}

export interface WeeklyDigestEmailInput {
  recipientName: string;
  workspaceName: string;
  workspaceUrl: string;
  /** The Monday the digest covers the week before, as YYYY-MM-DD. */
  weekOf: string;
  projects: DigestProject[];
  members: Array<{ name: string; completed: number }>;
  atRisk: DigestItem[];
  overdue: DigestItem[];
  atRiskTotal: number;
  overdueTotal: number;
  /** Absolute link to the recipient's notification settings. */
  preferencesUrl: string;
}

const STATUS_LABELS: Record<PlanStatus, string> = {
  on_track: "On track",
  at_risk: "At risk",
  behind: "Behind",
  no_plan: "No plan",
};

const percent = (value: number) => `${Number(value.toFixed(1))}%`;

function itemList(title: string, items: DigestItem[], total: number): EmailList {
  const more = total - items.length;
  return {
    title,
    items: items.map((item) => ({ text: `${plain(item.key)} ${plain(item.title)} - due ${shortDay(item.due)}`, url: item.url })),
    note: more > 0 ? `and ${more} more` : undefined,
  };
}

export function weeklyDigestEmail(input: WeeklyDigestEmailInput): Omit<EmailMessage, "to"> {
  const recipient = plain(input.recipientName);
  const workspace = plain(input.workspaceName);
  const week = shortDay(input.weekOf);
  const subject = `${workspace} weekly digest — week of ${week}`;
  const lists: EmailList[] = [
    {
      title: "Projects",
      items: input.projects.map((project) => {
        const plan = project.planPercent === null ? "no plan window" : `${percent(project.planPercent)} of the plan elapsed${project.label ? ` (${plain(project.label)})` : ""}`;
        return { text: `${plain(project.key)} ${plain(project.name)} - ${percent(project.donePercent)} done, ${plan}: ${STATUS_LABELS[project.status]}` };
      }),
    },
    {
      title: "Completed last week",
      items: input.members.length > 0
        ? input.members.map((member) => ({ text: `${plain(member.name)} - ${member.completed}` }))
        : [{ text: "Nothing was completed." }],
    },
  ];
  if (input.atRisk.length > 0) lists.push(itemList("Due in the next 3 days", input.atRisk, input.atRiskTotal));
  if (input.overdue.length > 0) lists.push(itemList("Overdue", input.overdue, input.overdueTotal));
  const { html, text } = renderEmail({
    preheader: `Your week in ${workspace}: progress, completed work and what needs attention.`,
    heading: `${workspace} weekly digest`,
    paragraphs: [`Hi ${recipient},`, `Here is how ${workspace} is doing, for the week of ${week}.`],
    lists,
    action: { label: "Open workspace", url: input.workspaceUrl },
    footerNote: "You receive this digest every Monday for each workspace you belong to.",
    settingsUrl: input.preferencesUrl,
    settingsLabel: "Email preferences",
  });
  return { subject, html, text };
}
