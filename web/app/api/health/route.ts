import { NextResponse } from "next/server";
import { labEc2Diagnostics } from "@/lib/ec2-errors";

/** Lightweight ALB/ops probe — no DB or content packs required. */
export async function GET() {
  return NextResponse.json({ ok: true, lab: labEc2Diagnostics() });
}
