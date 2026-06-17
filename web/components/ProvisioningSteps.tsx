"use client";

import { CircleCheck, CircleDashed, LoaderCircle, XCircle } from "lucide-react";
import type { ProvisioningStep } from "@/lib/provisioning-steps";

function StepIcon({ status }: { status: ProvisioningStep["status"] }) {
  switch (status) {
    case "done":
      return <CircleCheck size={17} style={{ color: "var(--pass)" }} aria-hidden />;
    case "failed":
      return <XCircle size={17} style={{ color: "var(--fail)" }} aria-hidden />;
    case "active":
      return (
        <LoaderCircle
          size={17}
          style={{ color: "var(--warn)", animation: "spin 1s linear infinite" }}
          aria-hidden
        />
      );
    default:
      return <CircleDashed size={17} style={{ color: "var(--text-tertiary)" }} aria-hidden />;
  }
}

export function ProvisioningSteps({ steps }: { steps: ProvisioningStep[] }) {
  return (
    <ol className="provisioning-steps">
      {steps.map((step) => (
        <li
          key={step.id}
          className={`provisioning-step provisioning-step--${step.status}`}
        >
          <StepIcon status={step.status} />
          <div className="provisioning-step__content">
            <strong style={{ color: step.status === "pending" ? "var(--text-tertiary)" : "var(--text)" }}>
              {step.label}
            </strong>
            {step.detail ? <span className="muted">{step.detail}</span> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}
