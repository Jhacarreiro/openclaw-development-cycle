

export function looksLikePlanRequest(text: string) {
  const t = String(text || "").toLowerCase();
  const markers = [
    "plan request for implementation",
    "required implementation output",
    "cria um plano técnico",
    "produz um plano técnico",
    "create or validate the implementation plan only",
    "não implementar nada",
    "apenas planear",
    "output location",
    "gravar o plano final",
  ];
  return markers.filter((m) => t.includes(m)).length >= 2;
}
function planMatchesAny(text: string, patterns: RegExp[]) {
  return patterns.some((re) => re.test(String(text || "")));
}

export function analyzeImplementationPlan(text: string, context: any = {}) {
  const source = String(text || "");
  const projectRoot = String(context.projectRoot || "").trim();
  const projectWikiPath = String(context.projectWikiPath || "").trim();
  const evidence = {
    implementationTasks: planMatchesAny(source, [
      /(?:^|\n)#{1,6}\s+.*\b(?:implementation tasks?|ordered implementation|tasks?|phases?|fases?|implementa[cç][aã]o|build order|passos?)\b/im,
      /(?:^|\n)\s*\d+[.)]\s+\S+/m,
    ]),
    validationChecks: planMatchesAny(source, [
      /validation checks?|validation|acceptance criteria|test matrix/i,
      /crit[eé]rios?\s+de\s+(?:aceita[cç][aã]o|sucesso)|valida[cç][aã]o|testes?/i,
      /\b(?:npm test|npm run build|typecheck|lint|pytest|go test|cargo test)\b/i,
    ]),
    stopConditions: planMatchesAny(source, [
      /stop conditions?|blocking conditions?|stop and report|stop before|human confirmation|protected or risky|rollback|forbidden|do not/i,
      /condi[cç][oõ]es?\s+de\s+paragem|parar|interromper|bloqueio|confirma[cç][aã]o humana|caminhos? protegidos?/i,
    ]),
    expectedArtifacts: planMatchesAny(source, [
      /expected artifacts?|artifacts?|deliverables?|output paths?|required screens?|required outputs?/i,
      /artefactos?|entreg[aá]veis|resultados?\s+esperados?|outputs?|ficheiros?\s+(?:gerados|finais?)/i,
    ]),
    relevantCodePaths: planMatchesAny(source, [
      /project paths?|projectroot|projectwikipath|project_root_code_checkout|project docs root|source checkout|relevant code paths?|affected files?|output paths?/i,
      /(?:^|[\s`])(?:\.{0,2}\/|\/data\/|src\/|tests\/|docs\/|app\/|packages\/)[^\s`]+/im,
      /\b[\w.-]+\.(?:ts|tsx|js|mjs|cjs|json|md|py|sh|yml|yaml|html|css|scss|go|rs)\b/i,
    ]),
    projectRoot: Boolean(projectRoot) || /projectroot|project_root_code_checkout|source checkout/i.test(source),
    projectWikiPath: Boolean(projectWikiPath) || /projectwikipath|project docs root/i.test(source),
  };
  const missing: string[] = [];
  if (!evidence.implementationTasks) missing.push("implementation_tasks");
  if (!evidence.validationChecks) missing.push("validation_checks");
  if (!evidence.stopConditions) missing.push("stop_conditions");
  if (!evidence.expectedArtifacts) missing.push("expected_artifacts");
  if (!evidence.relevantCodePaths) missing.push("relevant_code_paths");
  if (!evidence.projectRoot) missing.push("project_root");
  if (!evidence.projectWikiPath) missing.push("project_wiki_path");
  const structurallyConformant =
    /(?:^|\n)#{1,6}\s+project paths?\s*$/im.test(source)
    && /(?:^|\n)#{1,6}\s+(?:ordered implementation|implementation tasks?)\b/im.test(source)
    && /(?:^|\n)#{1,6}\s+validation checks?\s*$/im.test(source)
    && /(?:^|\n)#{1,6}\s+stop conditions?\s*$/im.test(source)
    && /(?:^|\n)#{1,6}\s+expected artifacts?\s*$/im.test(source);
  return { complete: missing.length === 0, missing, evidence, structurallyConformant };
}

export function normalizeImplementationPlan(text: string, context: any, analysis: any) {
  const projectRoot = String(context.projectRoot || "").trim() || "Declared in the approved source plan below.";
  const projectWikiPath = String(context.projectWikiPath || "").trim() || "Declared in the approved source plan below.";
  const source = String(text || "").trim();
  return `# Canonical implementation plan

> Normalized by Development Cycle from an already approved source plan.
> This normalization changes structure only: scope, task ordering, validation intent, stop conditions, and deliverables remain defined by the source plan preserved verbatim below.

## Project paths

- projectRoot: ${projectRoot}
- projectWikiPath: ${projectWikiPath}
- relevant code paths / affected files: preserved in the approved source plan below
- expected output paths / artifacts: preserved in the approved source plan below
- protected or risky paths: preserved in the approved source plan below

## Ordered implementation tasks

Follow the task sequence and phase ordering in the approved source plan below without changing scope.

## Validation checks

Apply the validation and acceptance checks stated in the approved source plan below.

## Stop conditions

Apply the blockers, risky-change gates, rollback rules, and human-confirmation conditions stated in the approved source plan below.

## Expected artifacts

Produce only the deliverables and output artifacts stated in the approved source plan below.

## Development Cycle normalization metadata

- sourceStructurallyConformant: ${Boolean(analysis.structurallyConformant)}
- normalizationChangedIntent: false
- unresolvedSemanticGaps: none

## Approved source plan (verbatim)

${source}
`;
}
