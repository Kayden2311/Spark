"use client";

import { useRef, useState, type FormEvent } from "react";
import { TextField } from "../_components/text-field";
import { contentApi, contentErrorMessage, POST_BODY_MAX, POST_TITLE_MAX, SubmissionKey, type PostDetail } from "../_lib/content-api";

interface ComposerProps {
  communityId: string;
  onCreated: (post: PostDetail) => void;
}

/** New post form: title and body with counters. Post is disabled while a field is blank or a send is running. */
export function Composer({ communityId, onCreated }: ComposerProps) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = useRef(new SubmissionKey());
  const ready = title.trim().length > 0 && body.trim().length > 0;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready || sending) return;
    setSending(true);
    setError(null);
    const payload = { title, body };
    try {
      const post = await contentApi.createPost(communityId, payload, key.current.forContent(JSON.stringify(payload)));
      key.current.done();
      setTitle("");
      setBody("");
      onCreated(post);
    } catch (failure) {
      setError(contentErrorMessage(failure));
    } finally {
      setSending(false);
    }
  };

  return (
    <form className="circleComposer" onSubmit={(event) => void submit(event)}>
      <TextField label="Title" max={POST_TITLE_MAX} onChange={setTitle} value={title} />
      <TextField label="Body" max={POST_BODY_MAX} onChange={setBody} rows={4} value={body} />
      {error && (
        <p className="circleNotice circleNoticeError circleFormError" role="alert">
          {error}
        </p>
      )}
      <div className="circleComposerActions">
        <button className="circleCtaBtn" disabled={!ready || sending} type="submit">
          {sending ? "Posting…" : "Post"}
        </button>
      </div>
    </form>
  );
}
