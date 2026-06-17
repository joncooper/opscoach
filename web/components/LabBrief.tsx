"use client";

import type { LabBriefModel } from "@/lib/lab-brief";
import { parseLabBrief } from "@/lib/lab-brief";

export function LabBrief({
  prompt,
  summary,
  brief,
}: {
  prompt?: string | null;
  summary?: string | null;
  brief?: LabBriefModel;
}) {
  const model = brief ?? parseLabBrief(prompt);
  if (!model.objective && !prompt && !summary) {
    return null;
  }

  return (
    <section className="lab-brief panel">
      <h2 style={{ marginTop: 0 }}>Lab brief</h2>
      {model.objective ? (
        <p className="lab-brief__objective">{model.objective}</p>
      ) : summary ? (
        <p className="lab-brief__objective">{summary}</p>
      ) : null}
      {model.body ? <p className="muted lab-brief__body">{model.body}</p> : null}
      {model.steps.length > 0 ? (
        <>
          <h3 className="lab-brief__heading">What to do</h3>
          <ul className="lab-brief__list">
            {model.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ul>
        </>
      ) : null}
      {model.deliverables.length > 0 ? (
        <>
          <h3 className="lab-brief__heading">Key paths</h3>
          <ul className="lab-brief__paths">
            {model.deliverables.map((path) => (
              <li key={path}>
                <code>{path}</code>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}
