"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:4000";

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface AuthWorkspace {
  workspaceId: string;
  workspaceName: string;
  workspaceSlug: string;
  role: string;
}

export interface AuthContextType {
  user: AuthUser | null;
  workspaces: AuthWorkspace[];
  platformRoles: string[];
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<{ success: boolean; error?: string }>;
  signup: (displayName: string, email: string, password: string) => Promise<{ success: boolean; error?: string }>;
  logout: () => Promise<void>;
  refreshSession: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [workspaces, setWorkspaces] = useState<AuthWorkspace[]>([]);
  const [platformRoles, setPlatformRoles] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);

  const refreshSession = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/v1/me`, {
        method: "GET",
        credentials: "include",
        headers: { Accept: "application/json" },
      });

      if (res.ok) {
        const data = await res.json();
        setUser(data.user);
        setWorkspaces(data.workspaces || []);
        setPlatformRoles(data.platformRoles || []);
      } else {
        setUser(null);
        setWorkspaces([]);
        setPlatformRoles([]);
      }
    } catch {
      setUser(null);
      setWorkspaces([]);
      setPlatformRoles([]);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    let isMounted = true;
    const checkAuth = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/v1/me`, {
          method: "GET",
          credentials: "include",
          headers: { Accept: "application/json" },
        });

        if (!isMounted) return;
        if (res.ok) {
          const data = await res.json();
          setUser(data.user);
          setWorkspaces(data.workspaces || []);
          setPlatformRoles(data.platformRoles || []);
        } else {
          setUser(null);
          setWorkspaces([]);
          setPlatformRoles([]);
        }
      } catch {
        if (!isMounted) return;
        setUser(null);
        setWorkspaces([]);
        setPlatformRoles([]);
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    };

    void checkAuth();
    return () => {
      isMounted = false;
    };
  }, []);

  const login = async (
    email: string,
    password: string,
  ): Promise<{ success: boolean; error?: string }> => {
    setIsLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/v1/auth/password/sign-in`, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, application/problem+json",
        },
        body: JSON.stringify({ email, password }),
      });

      if (res.ok) {
        const data = await res.json();
        setUser(data.user);
        if (data.workspace) setWorkspaces([data.workspace]);
        setIsLoading(false);
        return { success: true };
      }

      const errData = await res.json().catch(() => ({}));
      setIsLoading(false);
      return {
        success: false,
        error: errData.detail || errData.title || "Authentication failed. Please check your credentials.",
      };
    } catch {
      setIsLoading(false);
      return {
        success: false,
        error: "Unable to connect to authentication server. Please ensure backend is running.",
      };
    }
  };

  const signup = async (
    displayName: string,
    email: string,
    password: string,
  ): Promise<{ success: boolean; error?: string }> => {
    setIsLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/v1/auth/password/sign-up`, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, application/problem+json",
        },
        body: JSON.stringify({ displayName, email, password }),
      });

      if (res.ok) {
        const data = await res.json();
        setUser(data.user);
        if (data.workspace) setWorkspaces([data.workspace]);
        setIsLoading(false);
        return { success: true };
      }

      const errData = await res.json().catch(() => ({}));
      setIsLoading(false);
      return {
        success: false,
        error: errData.detail || errData.title || "Sign up failed. Please check your details.",
      };
    } catch {
      setIsLoading(false);
      return {
        success: false,
        error: "Unable to connect to authentication server. Please ensure backend is running.",
      };
    }
  };

  const logout = async () => {
    setIsLoading(true);
    try {
      await fetch(`${API_BASE}/api/v1/auth/sign-out`, {
        method: "POST",
        credentials: "include",
      });
    } catch {
      // Ignore network failures on logout
    } finally {
      setUser(null);
      setWorkspaces([]);
      setPlatformRoles([]);
      setIsLoading(false);
    }
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        workspaces,
        platformRoles,
        isAuthenticated: !!user,
        isLoading,
        login,
        signup,
        logout,
        refreshSession,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextType {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
