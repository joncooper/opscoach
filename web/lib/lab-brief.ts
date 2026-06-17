export interface LabBriefModel {
  objective: string;
  body: string;
  steps: string[];
  deliverables: string[];
}

const PATH_PATTERN = /(?:~\/[\w./-]+|\/(?:srv|home|var|etc|tmp)[\w./-]*)/g;

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/** Parse a lab prompt into a structured brief for the UI. */
export function parseLabBrief(prompt: string | null | undefined): LabBriefModel {
  const trimmed = (prompt ?? "").trim();
  if (!trimmed) {
    return { objective: "", body: "", steps: [], deliverables: [] };
  }

  const sentences = splitSentences(trimmed);
  const objective = sentences[0] ?? trimmed;
  const body = sentences.slice(1).join(" ").trim();

  const deliverables = [...new Set(trimmed.match(PATH_PATTERN) ?? [])];

  const steps = sentences
    .slice(1)
    .filter((sentence) => {
      const lower = sentence.toLowerCase();
      return (
        lower.startsWith("create ") ||
        lower.startsWith("copy ") ||
        lower.startsWith("move ") ||
        lower.startsWith("build ") ||
        lower.startsWith("set up ") ||
        lower.startsWith("use ") ||
        lower.startsWith("after ") ||
        lower.startsWith("expect ") ||
        lower.startsWith("leave ") ||
        lower.startsWith("verify ") ||
        lower.includes(" should ")
      );
    })
    .slice(0, 8);

  return { objective, body, steps, deliverables };
}
