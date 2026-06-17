import { NextRequest, NextResponse } from "next/server";
import { getCatalogGrouped, getLabCatalog } from "@/lib/content";

export async function GET(request: NextRequest) {
  try {
    const packId = request.nextUrl.searchParams.get("packId") ?? undefined;
    const grouped = request.nextUrl.searchParams.get("grouped") === "1";
    if (grouped) {
      const packs = getCatalogGrouped().filter((pack) =>
        packId ? pack.packId === packId : true
      );
      return NextResponse.json({ packs });
    }
    const catalog = getLabCatalog(packId);
    return NextResponse.json({ labs: catalog });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load labs";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
