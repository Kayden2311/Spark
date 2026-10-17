"use client";

import Link from "next/link";
import { useState } from "react";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) {
      setError("Enter a valid email address.");
      return;
    }
    setError(null);
    setSubmitted(true);
  };

  return (
    <div className="authPageRoot">
      <div className="authCardWrapper">
        <h1 className="authHeading">Reset your password</h1>
        {submitted ? (
          <p className="authSubheading" role="status">
            If an account exists for that email, a reset link will be sent. Preview only: no email is sent yet.
          </p>
        ) : (
          <>
            <p className="authSubheading">Enter your account email to request a reset link.</p>
            {error && (
              <div className="authAlertBanner" role="alert">
                <span>{error}</span>
              </div>
            )}
            <form onSubmit={handleSubmit} className="authForm" noValidate>
              <div className="authField">
                <label htmlFor="reset-email" className="authLabel">Email</label>
                <input
                  id="reset-email"
                  type="email"
                  autoComplete="email"
                  className="authInput"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </div>
              <button type="submit" className="authSubmitBtn">Send reset link</button>
            </form>
          </>
        )}
        <div className="authSwitchNotice">
          <Link href="/login">Back to sign in</Link>
        </div>
      </div>
    </div>
  );
}
