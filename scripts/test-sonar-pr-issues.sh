#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
guard_script="${repo_root}/scripts/check-sonar-pr-issues.sh"
temporary_dir="$(mktemp -d)"
trap 'rm -rf "${temporary_dir}"' EXIT

mock_bin="${temporary_dir}/bin"
mkdir -p "${mock_bin}"
cat >"${mock_bin}/curl" <<'MOCK_CURL'
#!/usr/bin/env bash
set -euo pipefail

endpoint=''
arguments="$*"
for argument in "$@"; do
  case "${argument}" in
    https://sonarcloud.io/api/project_pull_requests/list|https://sonarcloud.io/api/issues/search)
      endpoint="${argument}"
      ;;
  esac
done

if [[ -z "${endpoint}" ]]; then
  exit 90
fi

if [[ "${endpoint}" == 'https://sonarcloud.io/api/project_pull_requests/list' ]]; then
  [[ "${arguments}" == *'project=lekot_VScodePluginFor1CDev'* ]] || exit 91
else
  [[ "${arguments}" == *'componentKeys=lekot_VScodePluginFor1CDev'* ]] || exit 92
  [[ "${arguments}" == *'pullRequest=415'* ]] || exit 93
  [[ "${arguments}" == *'resolved=false'* ]] || exit 94
  [[ "${arguments}" == *'ps=1'* ]] || exit 95
fi

authorization_seen=false
for argument in "$@"; do
  if [[ "${argument}" == "Authorization: Bearer ${SONAR_TOKEN}" ]]; then
    authorization_seen=true
  fi
done
[[ "${authorization_seen}" == true ]] || exit 96

if [[ "${endpoint}" == 'https://sonarcloud.io/api/project_pull_requests/list' ]]; then
  call_file="${SONAR_TEST_STATE_DIR}/pr-call-count"
  call_count=0
  if [[ -f "${call_file}" ]]; then
    call_count="$(cat "${call_file}")"
  fi
  call_count=$((call_count + 1))
  printf '%s' "${call_count}" >"${call_file}"

  sha="${SONAR_EXPECTED_PR_SHA}"
  if [[ "${SONAR_TEST_SCENARIO}" == 'stale-before' ]] \
    || { [[ "${SONAR_TEST_SCENARIO}" == 'stale-after' ]] && (( call_count == 2 )); }; then
    sha='0000000000000000000000000000000000000000'
  fi
  printf '{"pullRequests":[{"key":"%s","commit":{"sha":"%s"}}]}' \
    "${SONAR_PR_NUMBER}" "${sha}"
  exit 0
fi

case "${SONAR_TEST_SCENARIO}" in
  api-error)
    exit 22
    ;;
  invalid-response)
    printf '{"errors":[{"msg":"unexpected API response"}]}'
    ;;
  issues)
    printf '{"total":2,"issues":[{}]}'
    ;;
  *)
    printf '{"total":0,"issues":[]}'
    ;;
esac
MOCK_CURL
chmod +x "${mock_bin}/curl"

expected_sha='511ee81f00112233445566778899aabbccddeeff'
fake_token='sonar-guard-test-token'

run_guard() {
  local scenario="$1"
  local state_dir="${temporary_dir}/${scenario}"
  mkdir -p "${state_dir}"

  env \
    SONAR_TOKEN="${fake_token}" \
    SONAR_PR_NUMBER='415' \
    SONAR_EXPECTED_PR_SHA="${expected_sha}" \
    SONAR_TEST_SCENARIO="${scenario}" \
    SONAR_TEST_STATE_DIR="${state_dir}" \
    PATH="${mock_bin}:${PATH}" \
    bash "${guard_script}" 2>&1
}

assert_success() {
  local scenario="$1"
  local output
  if ! output="$(run_guard "${scenario}")"; then
    printf 'Expected scenario %s to pass, but it failed.\n%s\n' "${scenario}" "${output}" >&2
    exit 1
  fi
  if [[ "${output}" == *"${fake_token}"* ]]; then
    printf 'Scenario %s exposed the token.\n' "${scenario}" >&2
    exit 1
  fi
}

assert_failure() {
  local scenario="$1"
  local expected_text="$2"
  local output
  if output="$(run_guard "${scenario}")"; then
    printf 'Expected scenario %s to fail.\n' "${scenario}" >&2
    exit 1
  fi
  if [[ "${output}" != *"${expected_text}"* ]]; then
    printf 'Scenario %s failed for an unexpected reason.\n%s\n' "${scenario}" "${output}" >&2
    exit 1
  fi
  if [[ "${output}" == *"${fake_token}"* ]]; then
    printf 'Scenario %s exposed the token.\n' "${scenario}" >&2
    exit 1
  fi
}

cd "${repo_root}"
assert_success 'success'
assert_failure 'issues' 'found 2 unresolved issue(s)'
assert_failure 'api-error' 'Could not retrieve unresolved SonarCloud issues'
assert_failure 'invalid-response' 'invalid issue count'
assert_failure 'stale-before' 'analysis is stale'
assert_failure 'stale-after' 'analysis is stale'

if env -u SONAR_TOKEN \
  SONAR_PR_NUMBER='415' \
  SONAR_EXPECTED_PR_SHA="${expected_sha}" \
  bash "${guard_script}" >"${temporary_dir}/missing-token.out" 2>&1; then
  printf 'Expected a missing Sonar token to fail.\n' >&2
  exit 1
fi
if ! grep -q 'SONAR_TOKEN is required' "${temporary_dir}/missing-token.out"; then
  printf 'Missing-token failure was not reported clearly.\n' >&2
  exit 1
fi

printf 'Sonar PR guard mock tests passed.\n'
