import { notFound } from "next/navigation";
import { serverGet } from "../../../../_lib/server-api";
import type { PostDetail } from "../../../_lib/content-api";
import { PostView } from "./post-view";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

interface PostPageProps {
  params: Promise<{ slug: string; postId: string }>;
  searchParams: Promise<{ edit?: string }>;
}

/**
 * Resolves the post on the server so an unreadable post, a post of another community and a malformed id answer
 * a real HTTP 404. Any other failure (the API down, a private community) renders the client view, which shows
 * its own state, so a brief API blip never becomes a 404.
 */
export default async function PostPage({ params, searchParams }: PostPageProps) {
  const [{ slug, postId }, { edit }] = await Promise.all([params, searchParams]);
  if (!UUID.test(postId)) notFound();
  const result = await serverGet(`/api/v1/posts/${encodeURIComponent(postId)}`);
  if (result.status === 404) notFound();
  const post = result.status === 200 ? (result.body as PostDetail) : null;
  if (post && post.communitySlug !== slug) notFound();
  return <PostView initial={post} postId={postId} slug={slug} startEditing={edit === "1"} />;
}
