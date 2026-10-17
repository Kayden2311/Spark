"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useAuth } from "../../../auth-context";

export const MAX_MESSAGE_LENGTH = 500;

export function RequestForm({ slug, name }: { slug: string; name: string }) {
  const { isAuthenticated, isLoading } = useAuth();
  const router = useRouter();
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);

  const requestPath = `/communities/${slug}/request`;

  if (!isLoading && !isAuthenticated) {
    return (
      <div className="authCardWrapper">
        <h1 className="authHeading">Sign in to request access</h1>
        <p className="authSubheading">You need a Spark account before you can ask to join {name}.</p>
        <Link className="authSubmitBtn" href={`/login?redirect=${encodeURIComponent(requestPath)}`}>
          Sign in
        </Link>
        <div className="authSwitchNotice">
          <span>New to Spark? </span>
          <Link href={`/signup?redirect=${encodeURIComponent(requestPath)}`}>Create an account</Link>
        </div>
      </div>
    );
  }

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (message.length > MAX_MESSAGE_LENGTH) {
      setError(`Keep your message under ${MAX_MESSAGE_LENGTH} characters.`);
      return;
    }
    setError(null);
    router.push(`${requestPath}/sent`);
  };

  return (
    <div className="authCardWrapper">
      <h1 className="authHeading">Request access to {name}</h1>
      <p className="authSubheading">
        The community owner reviews each request. Preview only: nothing is saved until the membership API ships.
      </p>
      {error && (
        <div className="authAlertBanner" role="alert">
          <span>{error}</span>
        </div>
      )}
      <form onSubmit={handleSubmit} className="authForm" noValidate>
        <div className="authField">
          <label htmlFor="request-message" className="authLabel">
            Message to the owner (optional)
          </label>
          <textarea
            id="request-message"
            className="authInput"
            rows={5}
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            placeholder="What are you building and why this circle?"
          />
          <small>{message.length}/{MAX_MESSAGE_LENGTH}</small>
        </div>
        <button type="submit" className="authSubmitBtn">Send request</button>
      </form>
      <div className="authSwitchNotice">
        <Link href={`/communities/${slug}`}>Back to {name}</Link>
      </div>
    </div>
  );
}
