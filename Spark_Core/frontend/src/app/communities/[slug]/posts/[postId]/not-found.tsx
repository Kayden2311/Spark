import { headers } from "next/headers";
import { PostUnavailable } from "./post-unavailable";

/**
 * Shown for every unreadable post, whether it exists or not: the text never says which. The only thing it
 * learns is whether the request carried a session cookie, to offer Sign in to visitors who have none.
 */
export default async function PostNotFound() {
  const cookie = (await headers()).get("cookie") ?? "";
  const signedIn = /(?:^|;\s*)spark_session=/u.test(cookie);
  return <PostUnavailable signedIn={signedIn} />;
}
