import { dueReminderEmail } from "../email/templates/due-reminder.js";
import { DeliveryError } from "../outbox/dispatcher.js";
import { createScheduledJob } from "./runner.js";

interface ReminderRow {
  status: string;
  email: string | null;
  recipient_name: string | null;
  total: number | null;
  task_workspace: string | null;
  task_workspace_slug: string | null;
  task_key: string | null;
  task_title: string | null;
  task_due: string | null;
  task_overdue: boolean | null;
}

/**
 * The once-a-day reminder: one email per user listing the tasks due today or tomorrow, or overdue, across
 * workspaces. The database re-reads what is due at send time and answers "skipped" when the email is no
 * longer wanted, which closes the row as suppressed.
 */
export const dueRemindersJob = createScheduledJob("due_reminders", async (row, lockToken, { pool, appBaseUrl }) => {
  const found = await pool.query<ReminderRow>(
    `SELECT status, email, recipient_name, total, task_workspace, task_workspace_slug, task_key, task_title, task_due::text AS task_due, task_overdue
     FROM spark.worker_due_reminder_email($1, $2)`,
    [row.id, lockToken],
  );
  const first = found.rows[0];
  if (!first || first.status !== "pending") return { outcome: "skip" };
  if (first.email === null || first.recipient_name === null) throw new DeliveryError("invalid_payload");

  try {
    const message = dueReminderEmail({
      recipientName: first.recipient_name,
      total: first.total ?? found.rows.length,
      tasks: found.rows.map((task) => {
        if (
          task.task_key === null || task.task_title === null || task.task_workspace === null ||
          task.task_workspace_slug === null || task.task_due === null
        ) {
          throw new DeliveryError("invalid_payload");
        }
        const projectKey = task.task_key.slice(0, task.task_key.lastIndexOf("-"));
        return {
          workspace: task.task_workspace,
          key: task.task_key,
          title: task.task_title,
          due: task.task_due,
          overdue: task.task_overdue === true,
          url: `${appBaseUrl}/w/${encodeURIComponent(task.task_workspace_slug)}/p/${encodeURIComponent(projectKey)}?issue=${encodeURIComponent(task.task_key)}`,
        };
      }),
      preferencesUrl: `${appBaseUrl}/settings/notifications`,
    });
    return { outcome: "send", message: { to: first.email, ...message } };
  } catch (error) {
    throw error instanceof DeliveryError ? error : new DeliveryError("template_error");
  }
});
