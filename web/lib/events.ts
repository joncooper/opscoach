import { EventEmitter } from "events";
import type { GraderResult } from "./types";

export type SessionEvent =
  | { type: "status"; status: string }
  | {
      type: "ready";
      sshHost: string;
      sshPort: number;
      graderHost?: string | null;
    }
  | { type: "grader"; result: GraderResult }
  | { type: "error"; message: string }
  | {
      type: "step";
      step: string;
      status: "pending" | "active" | "done" | "failed";
      detail?: string;
    }
  | {
      type: "bootstrap_progress";
      step: string;
      detail: string;
      at: string;
    }
  | { type: "heartbeat"; at: string };

class SessionEventBus {
  private buses = new Map<string, EventEmitter>();

  private getBus(sessionId: string): EventEmitter {
    let bus = this.buses.get(sessionId);
    if (!bus) {
      bus = new EventEmitter();
      bus.setMaxListeners(50);
      this.buses.set(sessionId, bus);
    }
    return bus;
  }

  publish(sessionId: string, event: SessionEvent): void {
    this.getBus(sessionId).emit("event", event);
  }

  subscribe(
    sessionId: string,
    listener: (event: SessionEvent) => void
  ): () => void {
    const bus = this.getBus(sessionId);
    bus.on("event", listener);
    return () => {
      bus.off("event", listener);
      if (bus.listenerCount("event") === 0) {
        this.buses.delete(sessionId);
      }
    };
  }
}

export const sessionEvents = new SessionEventBus();

export function formatSse(event: SessionEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}
