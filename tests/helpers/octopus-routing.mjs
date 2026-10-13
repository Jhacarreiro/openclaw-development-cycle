import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Managed Octopus launches fail closed unless every canonical routing role has
// an exact {provider, model} route in $HOME/.claude-octopus/config/providers.json.
export const canonicalRouting = {
  architect: { provider: "commandcode", model: "xiaomi/mimo-v2.6-pro" },
  strategist: { provider: "commandcode", model: "qwen/qwen3.8-max-0902" },
  "security-reviewer": { provider: "commandcode", model: "xai/grok-4.7" },
  "code-reviewer": { provider: "claude", model: "claude-sonnet-5-5" },
  implementer: { provider: "commandcode", model: "xiaomi/mimo-v2.6-pro" },
  "implementer-heavy": { provider: "codex", model: "gpt-6.1-sol" },
  synthesizer: { provider: "claude", model: "claude-sonnet-5-5" },
  researcher: { provider: "codex", model: "gpt-6.1-sol" },
};

export function writeCanonicalRoutingConfig(home) {
  const configDir = join(home, ".claude-octopus", "config");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "providers.json"), JSON.stringify({ routing: { roles: canonicalRouting } }));
}

export function withCanonicalRoutingHome(callback) {
  const previousHome = process.env.HOME;
  const home = mkdtempSync(join(tmpdir(), "development-cycle-octopus-"));
  writeCanonicalRoutingConfig(home);
  try {
    process.env.HOME = home;
    return callback();
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
}
