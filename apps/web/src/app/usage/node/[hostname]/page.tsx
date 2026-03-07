import { redirect } from 'next/navigation';

export default async function UsageNodeRedirect({
  params,
}: {
  params: Promise<{ hostname: string }>;
}) {
  const { hostname } = await params;
  redirect(`/permacomputer/${hostname}`);
}
