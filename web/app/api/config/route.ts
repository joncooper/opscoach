import { NextResponse } from "next/server";
import { defaultLearnerPublicKey, defaultLearnerPublicKeys } from "@/lib/default-ssh-keys";

export async function GET() {
  return NextResponse.json({
    defaultLearnerPublicKey: defaultLearnerPublicKey(),
    defaultLearnerPublicKeys: defaultLearnerPublicKeys(),
  });
}
