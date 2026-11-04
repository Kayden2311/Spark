/** Email notification preferences of the signed-in user (/api/v1/me/notification-preferences). */

import { workspaceApi } from "../w/_lib/api";

export interface EmailPreferences {
  taskAssigned: boolean;
  dueReminders: boolean;
  weeklyDigest: boolean;
}

export interface NotificationPreferences {
  email: EmailPreferences;
  timezone: string;
}

export async function fetchNotificationPreferences(signal?: AbortSignal): Promise<NotificationPreferences> {
  return (await workspaceApi<NotificationPreferences>("/me/notification-preferences", { signal })).data;
}

export async function saveNotificationPreferences(preferences: NotificationPreferences): Promise<NotificationPreferences> {
  const body: NotificationPreferences = {
    email: {
      taskAssigned: preferences.email.taskAssigned,
      dueReminders: preferences.email.dueReminders,
      weeklyDigest: preferences.email.weeklyDigest,
    },
    timezone: preferences.timezone,
  };
  return (await workspaceApi<NotificationPreferences>("/me/notification-preferences", { method: "PUT", body })).data;
}
