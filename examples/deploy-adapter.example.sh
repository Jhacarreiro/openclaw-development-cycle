#!/bin/sh
set -eu

request_path=${1:?usage: deploy-adapter.example.sh REQUEST_JSON}
mode=$(jq -r '.mode' "$request_path")
project=$(jq -r '.project' "$request_path")
deploy_id=$(jq -r '.deployId' "$request_path")
project_root=$(jq -r '.projectRoot' "$request_path")
source_commit=$(jq -r '.sourceCommit' "$request_path")
deployment_target=$(jq -r '.deploymentTarget // ""' "$request_path")
results_root=$(jq -r '.resultsRoot' "$request_path")
manifest_path=$(jq -r '.manifestPath' "$request_path")
authorization_path=$(jq -r '.authorizationPath // ""' "$request_path")

mkdir -p "$results_root"

case "$mode" in
  prepare)
    jq -n \
      --arg sourceCommit "$source_commit" \
      --arg project "$project" \
      --arg deployId "$deploy_id" \
      --arg deploymentTarget "$deployment_target" \
      '{
        schemaVersion: 1,
        sourceCommit: $sourceCommit,
        project: $project,
        deployId: $deployId,
        deploymentTarget: ($deploymentTarget // ""),
        expectedMutations: ["example: promote candidate artifact"],
        protectedPaths: ["/srv/app"],
        requiredAuthorizations: [],
        verificationChecks: ["health", "release==commit"],
        rollback: { available: true, description: "example rollback: restore previous image", artifacts: [] }
      }' > "$manifest_path"
    jq -n --arg m "$manifest_path" '{ok:true, mode:"prepare", manifestPath:$m}' 2>/dev/null || printf '{"ok":true,"mode":"prepare"}\n'
    ;;

  execute)
    if [ -n "$authorization_path" ] && [ ! -s "$authorization_path" ]; then
      printf '{"ok":false,"error":"authorization_required"}\n' >&2
      exit 2
    fi
    printf '{"ok":true,"mode":"execute","project":"%s","deployId":"%s"}\n' "$project" "$deploy_id"
    ;;

  verify)
    result_dir=$(dirname "$manifest_path")
    verify_result="$result_dir/verify_result.json"
    jq -n --arg c "$source_commit" '{ok:true, mode:"verify", sourceCommit:$c, checks:[{name:"health", ok:true}]}' > "$verify_result"
    printf '{"ok":true,"mode":"verify"}\n'
    ;;

  *)
    printf '{"ok":false,"error":"unknown_mode","mode":"%s"}\n' "$mode" >&2
    exit 2
    ;;
esac
