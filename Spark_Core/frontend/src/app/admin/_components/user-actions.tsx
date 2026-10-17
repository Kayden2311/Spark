import { adminApi, reloadIfStale } from "../_lib/api";
import type { UserStatus, UserSummary } from "../_lib/types";
import type { ReasonRequest } from "./reason-dialog";

/** Admin-tier accounts (super or platform admins) can only be changed by a super admin. */
export function canChangeStatus(viewerRoles: readonly string[], target: Pick<UserSummary, "platformRoles">): boolean {
  const adminTier = target.platformRoles.some((role) => role === "super_admin" || role === "platform_admin");
  return !adminTier || viewerRoles.includes("super_admin");
}

/** Builds the confirmation for suspending or reactivating a user, shared by the list and detail pages. */
export function statusRequest(user: Pick<UserSummary, "id" | "displayName" | "status">, onDone: (status: UserStatus) => void, onStale: () => void): ReasonRequest {
  const suspending = user.status === "active";
  return {
    title: suspending ? `Suspend ${user.displayName}?` : `Reactivate ${user.displayName}?`,
    description: suspending
      ? <p>They are signed out everywhere immediately and can&apos;t sign in until reactivated. Their data is kept.</p>
      : <p>They can sign in again. Sessions ended by the suspension stay ended.</p>,
    confirmLabel: suspending ? "Suspend user" : "Reactivate user",
    tone: suspending ? "danger" : "primary",
    onConfirm: async (reason) => {
      const status: UserStatus = suspending ? "suspended" : "active";
      await adminApi(`/users/${user.id}/status`, { method: "PATCH", body: { status, reason } }).catch((error: unknown) => reloadIfStale(error, onStale));
      onDone(status);
    },
  };
}
