import { redirect } from "next/navigation";
import { findCatalogEntryByLabId } from "@/lib/content";

export default async function LegacyLabLink({
  params,
}: {
  params: Promise<{ labId: string }>;
}) {
  const { labId } = await params;
  const entry = findCatalogEntryByLabId(labId);
  if (!entry) {
    redirect("/");
  }
  redirect(`/play/${entry.packId}/${entry.labId}`);
}
