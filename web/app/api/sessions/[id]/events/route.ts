import { formatSse, sessionEvents } from "@/lib/events";
import { stepEventsForSession } from "@/lib/provisioning-steps";
import { readLearnerSessionToken, requireLearnerSession } from "@/lib/session-access";
import { getSessionState } from "@/lib/sessions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const token = readLearnerSessionToken(request);
  const authorized = await requireLearnerSession(id, token);
  if (!authorized) {
    return new Response("Unauthorized", { status: 401 });
  }

  const session = await getSessionState(id);
  if (!session) {
    return new Response("Session not found", { status: 404 });
  }

  const encoder = new TextEncoder();
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let unsubscribe: (() => void) | undefined;

  const stream = new ReadableStream({
    start(controller) {
      const send = (payload: string) => {
        controller.enqueue(encoder.encode(payload));
      };

      send(formatSse({ type: "heartbeat", at: new Date().toISOString() }));
      if (session.latestGrader) {
        send(formatSse({ type: "grader", result: session.latestGrader }));
      }
      send(formatSse({ type: "status", status: session.status }));
      for (const stepEvent of stepEventsForSession(session)) {
        send(formatSse(stepEvent));
      }
      for (const entry of session.bootstrapProgress ?? []) {
        send(
          formatSse({
            type: "bootstrap_progress",
            step: entry.step,
            detail: entry.detail,
            at: entry.at,
          })
        );
      }
      if (session.status === "ready" && session.sshHost) {
        send(
          formatSse({
            type: "ready",
            sshHost: session.sshHost,
            sshPort: session.sshPort ?? 22,
          })
        );
      }

      unsubscribe = sessionEvents.subscribe(id, (event) => {
        send(formatSse(event));
      });

      heartbeat = setInterval(() => {
        send(formatSse({ type: "heartbeat", at: new Date().toISOString() }));
      }, 15_000);

      request.signal.addEventListener("abort", () => {
        if (heartbeat) clearInterval(heartbeat);
        unsubscribe?.();
        controller.close();
      });
    },
    cancel() {
      if (heartbeat) clearInterval(heartbeat);
      unsubscribe?.();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
