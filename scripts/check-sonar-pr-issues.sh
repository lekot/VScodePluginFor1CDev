#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

if [[ -z "${SONAR_TOKEN:-}" ]]; then
  fail 'SONAR_TOKEN is required to verify the pull request analysis.'
fi
if [[ ! "${SONAR_PR_NUMBER:-}" =~ ^[0-9]+$ ]]; then
  fail 'A numeric SONAR_PR_NUMBER is required.'
fi
if [[ ! "${SONAR_EXPECTED_PR_SHA:-}" =~ ^[[:xdigit:]]{40}$ ]]; then
  fail 'A 40-character SONAR_EXPECTED_PR_SHA is required.'
fi

project_key="$(awk -F= '
  $1 == "sonar.projectKey" {
    value = $2
    sub(/^[[:space:]]+/, "", value)
    sub(/[[:space:]]+$/, "", value)
    count++
    result = value
  }
  END {
    if (count != 1 || result == "") {
      exit 1
    }
    print result
  }
' sonar-project.properties)" || fail 'Could not read one sonar.projectKey from sonar-project.properties.'

sonar_api_base='https://sonarcloud.io'

api_get() {
  local endpoint="$1"
  shift

  curl --silent --fail \
    --connect-timeout 10 \
    --max-time 30 \
    --header "Authorization: Bearer ${SONAR_TOKEN}" \
    --get "$@" \
    "${sonar_api_base}${endpoint}" 2>/dev/null
}

get_analyzed_pr_sha() {
  local response
  local analyzed_sha

  if ! response="$(api_get '/api/project_pull_requests/list' \
    --data-urlencode "project=${project_key}")"; then
    return 1
  fi

  if ! analyzed_sha="$(jq --exit-status --raw-output \
    --arg pr "${SONAR_PR_NUMBER}" '
      if (.pullRequests | type) != "array" then
        error("invalid pull request list")
      else
        [.pullRequests[] | select((.key | tostring) == $pr)] as $matches
        | if ($matches | length) != 1 then
            error("pull request not found or duplicated")
          else
            $matches[0].commit.sha | strings
          end
      end
    ' <<<"${response}" 2>/dev/null)"; then
    return 1
  fi

  [[ "${analyzed_sha}" =~ ^[[:xdigit:]]{40}$ ]] || return 1
  printf '%s' "${analyzed_sha}"
}

assert_analysis_is_current() {
  local analyzed_sha

  if ! analyzed_sha="$(get_analyzed_pr_sha)"; then
    fail 'Could not verify the SonarCloud pull request analysis.'
  fi

  if [[ "${analyzed_sha,,}" != "${SONAR_EXPECTED_PR_SHA,,}" ]]; then
    fail "SonarCloud analysis is stale for pull request #${SONAR_PR_NUMBER}; refusing to check issues."
  fi
}

assert_analysis_is_current

if ! issues_response="$(api_get '/api/issues/search' \
  --data-urlencode "componentKeys=${project_key}" \
  --data-urlencode "pullRequest=${SONAR_PR_NUMBER}" \
  --data-urlencode 'resolved=false' \
  --data-urlencode 'ps=1')"; then
  fail 'Could not retrieve unresolved SonarCloud issues for the pull request.'
fi

if ! issue_count="$(jq --exit-status --raw-output '
  if ((.total | type) == "number"
    and (.total | floor) == .total
    and .total >= 0
    and (.issues | type) == "array") then
    .total
  else
    error("invalid issue search response")
  end
' <<<"${issues_response}" 2>/dev/null)"; then
  fail 'SonarCloud returned an invalid issue count.'
fi

assert_analysis_is_current

if [[ "${issue_count}" != '0' ]]; then
  fail "SonarCloud found ${issue_count} unresolved issue(s) in pull request #${SONAR_PR_NUMBER}."
fi

printf 'SonarCloud reports zero unresolved issues for pull request #%s.\n' "${SONAR_PR_NUMBER}"
