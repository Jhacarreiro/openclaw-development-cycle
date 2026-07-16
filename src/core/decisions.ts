export type FinalDecision = "go" | "revise" | "stop";

export type FinalDecisionParse =
  | { ok: true; decision: FinalDecision }
  | { ok: false; error: "invalid_final_decision"; firstToken: string | null; expected: FinalDecision[] };

const EXPECTED: FinalDecision[] = ["go", "revise", "stop"];

export function parseFinalDecision(input: unknown): FinalDecisionParse {
  const text = String(input ?? "").trim();
  const firstToken = text.split(/\s+/, 1)[0]?.toLowerCase() || null;
  const match = /^(go|revise|stop)\b/i.exec(text);
  if (!match) {
    return { ok: false, error: "invalid_final_decision", firstToken, expected: [...EXPECTED] };
  }
  return { ok: true, decision: match[1].toLowerCase() as FinalDecision };
}
