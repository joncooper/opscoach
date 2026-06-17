import { z } from "zod";
import { NextResponse } from "next/server";
import { verifyCallbackAuth } from "@/lib/callback-auth";
import { reportBootstrapProgress } from "@/lib/sessions";
import { BOOTSTRAP_STEP_ORDER } from "@/lib/bootstrap-progress";

const bodySchema = z.object({
  step: z.enum(BOOTSTRAP_STEP_ORDER),
  detail: z.string().min(1).max(500),
});

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  if (!(await verifyCallbackAuth(id, request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request body", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const result = await reportBootstrapProgress(id, parsed.data);
  if (!result.accepted) {
    return NextResponse.json({ error: "Progress not accepted" }, { status: 409 });
  }

  return NextResponse.json({ accepted: true }, { status: 202 });
}
