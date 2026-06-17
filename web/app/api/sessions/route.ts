import { NextResponse } from "next/server";
import { z } from "zod";
import { createSession } from "@/lib/sessions";
import { countActiveSessionsForOwner } from "@/lib/db";
import { readAlbIdentity } from "@/lib/identity";
import { isSameOriginRequest } from "@/lib/http";

const MAX_ACTIVE_SESSIONS_PER_USER = Number(
  process.env.OPSCOACH_MAX_ACTIVE_SESSIONS_PER_USER ?? "3"
);

// Pack/lab ids index into filesystem paths (lib/content.ts), so constrain them to
// simple slugs — no slashes or dots — to prevent path traversal.
const slug = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/, "must be a simple id");

const bodySchema = z.object({
  packId: slug,
  labId: slug,
  publicKey: z.string().max(8192).optional().default(""),
  mode: z.enum(["practice", "assessment"]).default("practice"),
});

export async function POST(request: Request) {
  try {
    if (!isSameOriginRequest(request)) {
      return NextResponse.json({ error: "Cross-origin request rejected" }, { status: 403 });
    }
    const json = await request.json();
    const parsed = bodySchema.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request body", details: parsed.error.flatten() },
        { status: 400 }
      );
    }
    const identity = await readAlbIdentity(request);
    if (identity && Number.isFinite(MAX_ACTIVE_SESSIONS_PER_USER)) {
      const active = await countActiveSessionsForOwner(identity.sub);
      if (active >= MAX_ACTIVE_SESSIONS_PER_USER) {
        return NextResponse.json(
          { error: "Too many active labs. Stop one before starting another." },
          { status: 429 }
        );
      }
    }
    const { session, token } = await createSession({ ...parsed.data, owner: identity });
    return NextResponse.json({ session, token }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to create session";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
