import type { EmailMessage } from "../email-sender.js";
import { renderEmail } from "../layout.js";

export interface TaskAssignedEmailInput {
  actorName: string;
  recipientName: string;
  /** The task's display key, for example WEB-42. */
  issueKey: string;
  issueTitle: string;
  projectName: string;
  workspaceName: string;
  /** Absolute link to the task on its board. */
  issueUrl: string;
  /** Absolute link to the recipient's notification settings. */
  preferencesUrl: string;
}

/** Collapses whitespace, including CR/LF, so values are safe in a subject line and in prose. */
function plain(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

const SUBJECT_TITLE_LENGTH = 80;

/** At most 80 characters (code points); a longer title keeps 79 and ends with an ellipsis. */
function shortTitle(title: string): string {
  const characters = Array.from(title);
  return characters.length <= SUBJECT_TITLE_LENGTH ? title : `${characters.slice(0, SUBJECT_TITLE_LENGTH - 1).join("")}…`;
}

export function taskAssignedEmail(input: TaskAssignedEmailInput): Omit<EmailMessage, "to"> {
  const actor = plain(input.actorName);
  const recipient = plain(input.recipientName);
  const key = plain(input.issueKey);
  const title = plain(input.issueTitle);
  const project = plain(input.projectName);
  const workspace = plain(input.workspaceName);
  const { html, text } = renderEmail({
    preheader: `${actor} assigned you ${key} in ${project}.`,
    heading: `${key}: ${title}`,
    paragraphs: [
      `Hi ${recipient},`,
      `${actor} assigned you ${key}: ${title}, in the ${project} project of the ${workspace} workspace.`,
    ],
    action: { label: "Open task", url: input.issueUrl },
    footerNote: "You received this email because a teammate assigned you a task in Spark.",
    settingsUrl: input.preferencesUrl,
    settingsLabel: "Email preferences",
  });
  return { subject: `${actor} assigned you ${key}: ${shortTitle(title)}`, html, text };
}
