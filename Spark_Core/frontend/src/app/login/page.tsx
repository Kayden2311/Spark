"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { useAuth } from "../auth-context";
import { HeroParticles } from "../hero-particles";

function SparkMark() {
  return (
    <svg aria-hidden="true" className="sparkMark" viewBox="0 0 48 48">
      <path className="sparkBolt" d="M27 2 8 27h13l-2 19 21-27H27z" />
    </svg>
  );
}

function GitHubIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
    </svg>
  );
}

function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18">
      <path
        fill="#4285F4"
        d="M23.745 12.27c0-.7-.06-1.4-.19-2.07H12v4.51h6.6c-.29 1.52-1.14 2.82-2.4 3.68v3.05h3.88c2.27-2.09 3.665-5.17 3.665-9.17z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3.05c-1.08.72-2.45 1.16-4.05 1.16-3.12 0-5.77-2.1-6.72-4.93H1.25v3.15C3.26 21.36 7.33 24 12 24z"
      />
      <path
        fill="#FBBC05"
        d="M5.28 14.27c-.25-.72-.38-1.49-.38-2.27s.13-1.55.38-2.27V6.58H1.25C.45 8.18 0 9.99 0 12s.45 3.82 1.25 5.42l4.03-3.15z"
      />
      <path
        fill="#EA4335"
        d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.33 0 3.26 2.64 1.25 6.58l4.03 3.15c.95-2.83 3.6-4.98 6.72-4.98z"
      />
    </svg>
  );
}

function MailIcon() {
  return (
    <svg className="authInputIcon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg className="authInputIcon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const redirectQuery = searchParams.get("redirect");

  const { isAuthenticated, user, platformRoles, login, isLoading: authLoading } = useAuth();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // If already authenticated, redirect to appropriate destination
  useEffect(() => {
    if (isAuthenticated && !authLoading) {
      const userRole = user?.role || "";
      const isPlatformStaff =
        ["super_admin", "platform_admin", "community_moderator", "content_moderator", "campaign_moderator"].includes(userRole) ||
        platformRoles.some((r) =>
          ["super_admin", "platform_admin", "community_moderator", "content_moderator", "campaign_moderator"].includes(r)
        );
      if (redirectQuery) {
        router.replace(redirectQuery);
      } else if (isPlatformStaff) {
        router.replace("/admin");
      } else {
        router.replace("/workspace");
      }
    }
  }, [isAuthenticated, authLoading, platformRoles, user, redirectQuery, router]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) {
      setError("Please provide both email and password.");
      return;
    }

    setError(null);
    setIsSubmitting(true);

    const result = await login(email, password);
    setIsSubmitting(false);

    if (result.success) {
      if (redirectQuery) {
        router.push(redirectQuery);
        return;
      }
      const userRole = result.user?.role || "";
      const roles = result.platformRoles || [];
      const isPlatformStaff =
        ["super_admin", "platform_admin", "community_moderator", "content_moderator", "campaign_moderator"].includes(userRole) ||
        roles.some((r: string) =>
          ["super_admin", "platform_admin", "community_moderator", "content_moderator", "campaign_moderator"].includes(r)
        );
      if (isPlatformStaff) {
        router.replace("/admin");
      } else {
        router.replace("/workspace");
      }
    } else {
      setError(result.error || "Authentication failed.");
    }
  };

  return (
    <div className="authPageRoot">
      <HeroParticles />
      <div className="authAmbientGrid" aria-hidden="true" />
      <div className="authHeroGlow1" aria-hidden="true" />
      <div className="authHeroGlow2" aria-hidden="true" />

      <div className="authCardWrapper">
        {/* Brand Lockup */}
        <Link href="/" className="authBrandLockup" aria-label="Spark home">
          <div className="authBrandBolt">
            <SparkMark />
          </div>
          <span className="authBrandName">Spark</span>
        </Link>

        <h1 className="authHeading">Sign in to Spark</h1>
        <p className="authSubheading">
          The calm operating system for startup teams and founder circles.
        </p>

        {/* OAuth Social Login Buttons */}
        <div className="oauthButtonGroup">
          <button
            type="button"
            className="oauthBtn"
            onClick={() => setError("GitHub OAuth will be enabled upon domain configuration.")}
          >
            <GitHubIcon />
            <span>GitHub</span>
          </button>
          <button
            type="button"
            className="oauthBtn"
            onClick={() => setError("Google OAuth will be enabled upon domain configuration.")}
          >
            <GoogleIcon />
            <span>Google</span>
          </button>
        </div>

        <div className="authDivider">
          <span>or continue with email</span>
        </div>

        {/* Error Alert */}
        {error && (
          <div className="authAlertBanner" role="alert">
            <svg viewBox="0 0 20 20" fill="currentColor">
              <path
                fillRule="evenodd"
                d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z"
                clipRule="evenodd"
              />
            </svg>
            <span>{error}</span>
          </div>
        )}

        {/* Login Form */}
        <form onSubmit={handleSubmit} className="authForm" noValidate>
          <div className="authField">
            <label htmlFor="auth-email" className="authLabel">
              Work email
            </label>
            <div className="authInputWrapper">
              <MailIcon />
              <input
                id="auth-email"
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="founder@startup.io"
                className="authInput"
              />
            </div>
          </div>

          <div className="authField">
            <div className="authLabelRow">
              <label htmlFor="auth-password" className="authLabel">
                Password
              </label>
              <a
                href="#reset"
                className="authForgotLink"
                onClick={(e) => {
                  e.preventDefault();
                  setError("Password reset instructions will be sent to your work email.");
                }}
              >
                Forgot password?
              </a>
            </div>
            <div className="authInputWrapper">
              <LockIcon />
              <input
                id="auth-password"
                type={showPassword ? "text" : "password"}
                required
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••••••"
                className="authInput"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="authTogglePassword"
                aria-label={showPassword ? "Hide password" : "Show password"}
              >
                {showPassword ? "Hide" : "Show"}
              </button>
            </div>
          </div>

          <button
            type="submit"
            disabled={isSubmitting || authLoading}
            className="authSubmitBtn"
          >
            {isSubmitting ? "Authenticating..." : "Sign in"}
          </button>
        </form>

        <div className="authSwitchNotice">
          <span>Don&apos;t have an account? </span>
          <Link href={`/signup${redirectQuery ? `?redirect=${encodeURIComponent(redirectQuery)}` : ""}`}>
            Create an account
          </Link>
        </div>

        <p className="authTermsNotice">
          By signing in, you agree to Spark’s{" "}
          <Link href="/terms">Terms of Service</Link> and{" "}
          <Link href="/privacy">Privacy Policy</Link>.
        </p>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div className="authPageRoot">
          <div className="authCardWrapper" style={{ textAlign: "center", color: "#53627a" }}>
            Loading Spark Auth...
          </div>
        </div>
      }
    >
      <LoginForm />
    </Suspense>
  );
}

