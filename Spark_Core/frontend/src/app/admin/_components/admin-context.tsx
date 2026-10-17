"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { adminApi } from "../_lib/api";
import type { Overview } from "../_lib/types";
import { CheckIcon, AlertIcon } from "./icons";

interface Toast {
  id: number;
  tone: "success" | "error";
  message: string;
}

interface AdminContextValue {
  roles: string[];
  overview: Overview | null;
  refreshOverview: () => void;
  notify: (message: string, tone?: Toast["tone"]) => void;
}

const AdminContext = createContext<AdminContextValue | null>(null);

export function useAdmin(): AdminContextValue {
  const value = useContext(AdminContext);
  if (!value) throw new Error("useAdmin must be used inside the admin console");
  return value;
}

/** Shared console state: the caller's roles, live queue counts for the navigation, and toasts. */
export function AdminProvider({ roles, children }: { roles: string[]; children: ReactNode }) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(0);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    adminApi<Overview>("/overview", { signal: controller.signal }).then(setOverview).catch(() => {
      // Counts are a convenience; each section loads and reports its own data.
    });
    return () => controller.abort();
  }, [refreshKey]);

  const refreshOverview = useCallback(() => setRefreshKey((key) => key + 1), []);

  const notify = useCallback((message: string, tone: Toast["tone"] = "success") => {
    const id = ++nextId.current;
    setToasts((current) => [...current.slice(-2), { id, tone, message }]);
    window.setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), 4500);
  }, []);

  const value = useMemo(() => ({ roles, overview, refreshOverview, notify }), [roles, overview, refreshOverview, notify]);

  return (
    <AdminContext.Provider value={value}>
      {children}
      <div aria-live="polite" className="admToasts" role="status">
        {toasts.map((toast) => (
          <div className={`admToast admToast-${toast.tone}`} key={toast.id}>
            {toast.tone === "success" ? <CheckIcon /> : <AlertIcon />}
            <span>{toast.message}</span>
          </div>
        ))}
      </div>
    </AdminContext.Provider>
  );
}
