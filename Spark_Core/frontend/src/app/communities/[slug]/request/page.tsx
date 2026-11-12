import { RequestForm } from "./request-form";

export default async function RequestAccessPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return (
    <div className="authPageRoot">
      <RequestForm slug={slug} />
    </div>
  );
}
