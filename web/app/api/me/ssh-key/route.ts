import { NextResponse } from "next/server";
import { ensureMigrated, getUserKey, setUserKey } from "@/lib/db";
import { readAlbIdentity } from "@/lib/identity";
import { isSameOriginRequest } from "@/lib/http";
import { validatePublicKey } from "@/lib/ssh-key";

export async function GET(request: Request) {
  const identity = await readAlbIdentity(request);
  if (!identity) {
    return NextResponse.json({ signedIn: false, key: null });
  }
  await ensureMigrated();
  const record = await getUserKey(identity.sub);
  return NextResponse.json({
    signedIn: true,
    key: record?.publicKey ?? null,
    updatedAt: record?.updatedAt ?? null,
  });
}

export async function PUT(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Cross-origin request rejected" }, { status: 403 });
  }
  const identity = await readAlbIdentity(request);
  if (!identity) {
    return NextResponse.json(
      { error: "Sign in to save a default SSH key." },
      { status: 401 }
    );
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  const publicKey = (body as { publicKey?: unknown })?.publicKey;
  if (typeof publicKey !== "string") {
    return NextResponse.json({ error: "publicKey is required" }, { status: 400 });
  }
  const validation = validatePublicKey(publicKey);
  if (!validation.ok || !validation.key) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }
  await ensureMigrated();
  await setUserKey(identity.sub, identity.email, validation.key);
  return NextResponse.json({ ok: true, key: validation.key });
}
