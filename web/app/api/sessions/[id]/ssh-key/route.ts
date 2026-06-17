import { getVendedPrivateKey } from "@/lib/sessions";

// Serves this session's vended SSH private key — the throwaway key that lets a
// browser-terminal learner connect from their own terminal. Gated by the session
// token (same header the shell + stop endpoints use), so only the session owner
// can retrieve it. The key only grants access to this session's short-lived lab host.
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const token =
    request.headers.get("x-session-token") ??
    new URL(request.url).searchParams.get("token") ??
    "";
  if (!token) {
    return new Response("Missing session token", { status: 401 });
  }
  const key = await getVendedPrivateKey(id, token);
  if (!key) {
    return new Response("Not found", { status: 404 });
  }
  return new Response(key, {
    status: 200,
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="opscoach-${id.slice(0, 8)}.key"`,
      "Cache-Control": "no-store",
    },
  });
}
