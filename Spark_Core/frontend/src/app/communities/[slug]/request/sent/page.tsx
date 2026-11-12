import { RequestSent } from "./request-sent";

export default async function RequestSentPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return (
    <div className="authPageRoot">
      <RequestSent slug={slug} />
    </div>
  );
}
