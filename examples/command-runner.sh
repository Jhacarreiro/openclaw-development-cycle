#!/bin/sh
set -eu

request_path=${1:?usage: command-runner.sh REQUEST_JSON}
get_field() {
  python3 -c 'import json, sys; print(json.load(open(sys.argv[1])).get(sys.argv[2], ""))' "$request_path" "$1"
}
project=$(get_field project)
run_id=$(get_field runId)
mode=$(get_field mode)
results_root=$(get_field resultsRoot)
prompt_path=$(get_field promptPath)

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
