import type { EmailMessage } from "../email-sender.js";
import { renderEmail } from "../layout.js";
import { plain, shortDay } from "./format.js";

export interface DueReminderTask {
  workspace: string;
  /** The task's display key, for example WEB-42. */
  key: string;
  title: string;
  /** The due date as YYYY-MM-DD. */
  due: string;
  overdue: boolean;
  /** Absolute link to the task on its board. */
  url: string;
}

export interface DueReminderEmailInput {
  recipientName: string;
  tasks: DueReminderTask[];
  /** All tasks that qualified; more than tasks.length when the list was cut. */
  total: number;
  /** Absolute link to the recipient's notification settings. */
  preferencesUrl: string;
}

export function dueReminderEmail(input: DueReminderEmailInput): Omit<EmailMessage, "to"> {
  const recipient = plain(input.recipientName);
  const total = Math.max(input.total, input.tasks.length);
  const overdue = input.tasks.filter((task) => task.overdue).length;
  const noun = total === 1 ? "task" : "tasks";
  const subject = `You have ${total} ${noun} due soon${overdue > 0 ? ` (${overdue} overdue)` : ""}`;
  const more = total - input.tasks.length;
  const { html, text } = renderEmail({
    preheader: `${total} ${noun} assigned to you ${total === 1 ? "is" : "are"} due today, tomorrow or overdue.`,
    heading: subject,
    paragraphs: [`Hi ${recipient},`, `These tasks assigned to you are due today or tomorrow, or are already overdue.`],
    lists: [
      {
        title: "Your tasks",
        items: input.tasks.map((task) => ({
          text: `${plain(task.key)} ${plain(task.title)} (${plain(task.workspace)}) - ${task.overdue ? "overdue since" : "due"} ${shortDay(task.due)}`,
          url: task.url,
        })),
        note: more > 0 ? `and ${more} more` : undefined,
      },
    ],
    footerNote: "You receive this reminder once a day when you have tasks due soon.",
    settingsUrl: input.preferencesUrl,
    settingsLabel: "Email preferences",
  });
  return { subject, html, text };
}
