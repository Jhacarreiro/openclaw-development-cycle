#!/bin/sh
set -eu

request_path=${1:?usage: command-runner.sh REQUEST_JSON}
project=$(jq -r '.project' "$request_path")
run_id=$(jq -r '.runId' "$request_path")
mode=$(jq -r '.mode' "$request_path")
results_root=$(jq -r '.resultsRoot' "$request_path")
prompt_path=$(jq -r '.promptPath' "$request_path")

mkdir -p "$results_root"
output="$results_root/example-command-adapter-delivery.md"
{
  printf '# Example command adapter delivery\n\n'
  printf -- '- Project: `%s`\n' "$project"
  printf -- '- Run: `%s`\n' "$run_id"
  printf -- '- Mode: `%s`\n\n' "$mode"
  printf 'This fixture proves the generic adapter contract. It does not modify the source checkout.\n\n'
  printf '## Prompt received\n\n```text\n'
  cat "$prompt_path"
  printf '\n```\n'
} > "$output"

printf '{"ok":true,"adapter":"example-command","artifact":"%s"}\n' "$output"
