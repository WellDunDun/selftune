#!/usr/bin/env bash

set -euo pipefail

image_ref="${1:-}"
platform="${2:-}"

if [[ ! "$image_ref" =~ @sha256:[a-f0-9]{64}$ ]]; then
  echo "Expected an immutable image digest reference, got: $image_ref" >&2
  exit 2
fi

for required_command in curl docker jq openssl sha256sum; do
  command -v "$required_command" >/dev/null
done

case "$platform" in
  linux/amd64)
    expected_machine="x86_64"
    ;;
  linux/arm64)
    expected_machine="aarch64"
    ;;
  *)
    echo "Unsupported smoke-test platform: $platform" >&2
    exit 2
    ;;
esac

container="selftune-release-proof-${platform#linux/}-$$"
work_dir="$(mktemp -d)"
read -r token < <(openssl rand -hex 32)
read -r member_token < <(openssl rand -hex 32)
if [[ ! "$token" =~ ^[a-f0-9]{64}$ ]]; then
  echo "Self-host image proof failed (admin token generation): expected 64 lowercase hex characters." >&2
  exit 1
fi
if [[ ! "$member_token" =~ ^[a-f0-9]{64}$ ]]; then
  echo "Self-host image proof failed (member token generation): expected 64 lowercase hex characters." >&2
  exit 1
fi
if [[ "$token" == "$member_token" ]]; then
  echo "Self-host image proof failed (token isolation): generated duplicate credentials." >&2
  exit 1
fi
member_email="release-proof-recipient@example.com"
users_json="$(jq --null-input --compact-output \
  --arg email "$member_email" \
  --arg token "$member_token" \
  '[{email: $email, name: "Release Proof Recipient", org_name: "Release Proof Recipient", role: "member", token: $token}]')"
base_url="http://127.0.0.1:8787"

cleanup() {
  docker rm --force --volumes "$container" >/dev/null 2>&1 || true
  rm -rf "$work_dir"
}
trap cleanup EXIT

dump_logs() {
  docker inspect \
    --format 'container status={{.State.Status}} exit_code={{.State.ExitCode}} error={{json .State.Error}}' \
    "$container" >&2 2>/dev/null || true
  docker logs "$container" >&2 || true
}
trap dump_logs ERR

wait_for_readiness() {
  for _attempt in {1..90}; do
    if curl --fail --silent --max-time 2 "$base_url/readyz" >"$work_dir/readiness.json"; then
      jq --exit-status '.ok == true and .check == "readiness"' \
        "$work_dir/readiness.json" >/dev/null
      return 0
    fi
    sleep 2
  done
  echo "Self-host image did not become ready: $image_ref ($platform)" >&2
  dump_logs
  return 1
}

request_status() {
  local output_path="$1"
  shift
  curl --silent --show-error --max-time 10 --output "$output_path" --write-out '%{http_code}' "$@"
}

assert_equal() {
  local check="$1"
  local expected="$2"
  local actual="$3"
  if [[ "$actual" == "$expected" ]]; then
    return 0
  fi
  printf 'Self-host image proof failed (%s): expected %q, got %q\n' \
    "$check" "$expected" "$actual" >&2
  return 1
}

assert_json_array_singleton() {
  local check="$1"
  local expected="$2"
  local actual="$3"
  if jq --exit-status --arg expected "$expected" \
    'type == "array" and length == 1 and (.[0] | ascii_downcase) == ($expected | ascii_downcase)' \
    <<<"$actual" >/dev/null; then
    return 0
  fi
  printf 'Self-host image proof failed (%s): expected only %q, got %s\n' \
    "$check" "$expected" "$actual" >&2
  return 1
}

docker pull --platform "$platform" "$image_ref"

docker run --detach \
  --platform "$platform" \
  --name "$container" \
  --init \
  --read-only \
  --tmpfs /tmp:size=64m,mode=1777 \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --publish 127.0.0.1:8787:8787 \
  --env "SELFTUNE_AUTH_TOKEN=$token" \
  --env "SELFTUNE_SELFHOST_USERS_JSON=$users_json" \
  --env "SELFTUNE_PUBLIC_URL=$base_url" \
  "$image_ref" >/dev/null

expected_image_id="$(docker image inspect --format '{{.Id}}' "$image_ref")"
container_image_id="$(docker inspect --format '{{.Image}}' "$container")"
assert_equal "immutable container image ID" "$expected_image_id" "$container_image_id"
assert_equal \
  "read-only root filesystem" \
  "true" \
  "$(docker inspect --format '{{.HostConfig.ReadonlyRootfs}}' "$container")"
assert_json_array_singleton \
  "dropped capabilities" \
  "ALL" \
  "$(docker inspect --format '{{json .HostConfig.CapDrop}}' "$container")"
security_options="$(docker inspect --format '{{json .HostConfig.SecurityOpt}}' "$container")"
if ! jq --exit-status \
  'type == "array" and length == 1 and
    (.[0] == "no-new-privileges" or .[0] == "no-new-privileges:true")' \
  <<<"$security_options" >/dev/null; then
  printf 'Self-host image proof failed (security options): expected only no-new-privileges, got %s\n' \
    "$security_options" >&2
  exit 1
fi
assert_equal "container state" "running" "$(docker inspect --format '{{.State.Status}}' "$container")"
assert_equal "runtime user" "10001" "$(docker exec "$container" id -u)"
assert_equal "runtime architecture" "$expected_machine" "$(docker exec "$container" uname -m)"

wait_for_readiness

status="$(request_status \
  "$work_dir/unauthorized.json" \
  "$base_url/api/v1/remote-library/capabilities")"
[[ "$status" == "401" ]]
jq --exit-status '.error.code == "AUTH_MISSING"' "$work_dir/unauthorized.json" >/dev/null

curl --fail --silent --show-error --max-time 10 \
  --header "Authorization: Bearer $token" \
  "$base_url/api/v1/remote-library/capabilities" >"$work_dir/capabilities.json"
jq --exit-status \
  '.protocol == "selftune.remote-library.v1" and .raw_transcripts_synced == false' \
  "$work_dir/capabilities.json" >/dev/null

curl --fail --silent --show-error --max-time 10 \
  --header "Authorization: Bearer $token" \
  "$base_url/settings" >"$work_dir/dashboard.html"
grep --quiet '<div id="root"></div>' "$work_dir/dashboard.html"

printf '%s\n' "selftune release proof for $platform" >"$work_dir/object.bin"
object_sha256="$(sha256sum "$work_dir/object.bin" | awk '{print $1}')"
artifact_id="skill/release-proof-${platform#linux/}/$object_sha256"

status="$(request_status \
  "$work_dir/put.json" \
  --request PUT \
  --header "Authorization: Bearer $token" \
  --header 'Content-Type: application/octet-stream' \
  --data-binary "@$work_dir/object.bin" \
  "$base_url/api/v1/remote-library/objects/$object_sha256")"
[[ "$status" == "201" ]]
jq --exit-status \
  --arg sha "$object_sha256" \
  '.created == true and .sha256 == $sha' \
  "$work_dir/put.json" >/dev/null

jq --null-input \
  --arg artifact_id "$artifact_id" \
  --arg object_sha256 "$object_sha256" \
  '{
    schema_version: "selftune.remote-library.snapshot.v1",
    expected_parent_id: null,
    artifacts: [{
      artifact_id: $artifact_id,
      artifact_type: "skill_revision",
      object_sha256: $object_sha256,
      revision: $object_sha256,
      metadata: {release_proof: true}
    }]
  }' >"$work_dir/snapshot-request.json"

status="$(request_status \
  "$work_dir/commit.json" \
  --request POST \
  --header "Authorization: Bearer $token" \
  --header 'Content-Type: application/json' \
  --data-binary "@$work_dir/snapshot-request.json" \
  "$base_url/api/v1/remote-library/snapshots")"
[[ "$status" == "201" ]]
snapshot_id="$(jq --raw-output '.snapshot.id' "$work_dir/commit.json")"
[[ "$snapshot_id" =~ ^[0-9a-f-]{36}$ ]]

status="$(request_status \
  "$work_dir/member-object-before-import.json" \
  --header "Authorization: Bearer $member_token" \
  "$base_url/api/v1/remote-library/objects/$object_sha256")"
[[ "$status" == "404" ]]

jq --null-input \
  --arg snapshot_id "$snapshot_id" \
  --arg artifact_id "$artifact_id" \
  --arg recipient_email "$member_email" \
  '{
    snapshot_id: $snapshot_id,
    artifact_id: $artifact_id,
    recipient_email: $recipient_email
  }' >"$work_dir/share-request.json"
status="$(request_status \
  "$work_dir/share-created.json" \
  --request POST \
  --header "Authorization: Bearer $token" \
  --header 'Content-Type: application/json' \
  --data-binary "@$work_dir/share-request.json" \
  "$base_url/api/v1/remote-library/shares")"
[[ "$status" == "201" ]]
share_id="$(jq --raw-output '.share.id' "$work_dir/share-created.json")"
[[ "$share_id" =~ ^[0-9a-f-]{36}$ ]]
jq --exit-status \
  --arg email "$member_email" \
  '.share.status == "pending" and .share.recipient.email == $email' \
  "$work_dir/share-created.json" >/dev/null

curl --fail --silent --show-error --max-time 10 \
  --header "Authorization: Bearer $member_token" \
  "$base_url/api/v1/remote-library/shares" >"$work_dir/member-shares.json"
jq --exit-status \
  --arg share_id "$share_id" \
  '.inbox | any(.id == $share_id and .status == "pending")' \
  "$work_dir/member-shares.json" >/dev/null

status="$(request_status \
  "$work_dir/share-accepted.json" \
  --request POST \
  --header "Authorization: Bearer $member_token" \
  "$base_url/api/v1/remote-library/shares/$share_id/accept")"
[[ "$status" == "200" ]]
jq --exit-status '.share.status == "accepted"' "$work_dir/share-accepted.json" >/dev/null

status="$(request_status \
  "$work_dir/share-imported.json" \
  --request POST \
  --header "Authorization: Bearer $member_token" \
  "$base_url/api/v1/remote-library/shares/$share_id/import")"
[[ "$status" == "200" ]]
jq --exit-status \
  '.share.status == "imported" and .snapshot != null' \
  "$work_dir/share-imported.json" >/dev/null

curl --fail --silent --show-error --max-time 10 \
  --header "Authorization: Bearer $member_token" \
  "$base_url/api/v1/remote-library/objects/$object_sha256" >"$work_dir/member-object.bin"
cmp "$work_dir/object.bin" "$work_dir/member-object.bin"

status="$(request_status \
  "$work_dir/conflict.json" \
  --request POST \
  --header "Authorization: Bearer $token" \
  --header 'Content-Type: application/json' \
  --data-binary "@$work_dir/snapshot-request.json" \
  "$base_url/api/v1/remote-library/snapshots")"
[[ "$status" == "409" ]]
jq --exit-status \
  --arg current "$snapshot_id" \
  '.error.code == "RemoteLibraryHeadConflict" and .error.current_head_id == $current' \
  "$work_dir/conflict.json" >/dev/null

curl --fail --silent --show-error --max-time 10 \
  --header "Authorization: Bearer $token" \
  "$base_url/api/v1/remote-library/snapshots/head" >"$work_dir/head.json"
jq --exit-status \
  --arg snapshot "$snapshot_id" \
  --arg sha "$object_sha256" \
  '.snapshot.id == $snapshot and .snapshot.artifacts[0].object_sha256 == $sha' \
  "$work_dir/head.json" >/dev/null

curl --fail --silent --show-error --max-time 10 \
  --header "Authorization: Bearer $token" \
  "$base_url/api/v1/remote-library/objects/$object_sha256" >"$work_dir/downloaded.bin"
cmp "$work_dir/object.bin" "$work_dir/downloaded.bin"

curl --fail --silent --show-error --max-time 10 \
  --header "Authorization: Bearer $token" \
  "$base_url/api/v1/remote-library/diagnostics" >"$work_dir/diagnostics.json"
jq --exit-status \
  '.status == "ok" and .object_count == 1 and .snapshot_count == 1 and .missing_objects == []' \
  "$work_dir/diagnostics.json" >/dev/null

docker restart "$container" >/dev/null
wait_for_readiness

curl --fail --silent --show-error --max-time 10 \
  --header "Authorization: Bearer $token" \
  "$base_url/api/v1/remote-library/snapshots/head" >"$work_dir/restarted-head.json"
jq --exit-status \
  --arg snapshot "$snapshot_id" \
  '.snapshot.id == $snapshot' \
  "$work_dir/restarted-head.json" >/dev/null

curl --fail --silent --show-error --max-time 10 \
  --header "Authorization: Bearer $token" \
  "$base_url/api/v1/remote-library/objects/$object_sha256" >"$work_dir/restarted-object.bin"
cmp "$work_dir/object.bin" "$work_dir/restarted-object.bin"

curl --fail --silent --show-error --max-time 10 \
  --header "Authorization: Bearer $member_token" \
  "$base_url/api/v1/remote-library/snapshots/head" >"$work_dir/restarted-member-head.json"
jq --exit-status \
  --arg sha "$object_sha256" \
  '.snapshot.artifacts | any(.object_sha256 == $sha)' \
  "$work_dir/restarted-member-head.json" >/dev/null

curl --fail --silent --show-error --max-time 10 \
  --header "Authorization: Bearer $member_token" \
  "$base_url/api/v1/remote-library/objects/$object_sha256" \
  >"$work_dir/restarted-member-object.bin"
cmp "$work_dir/object.bin" "$work_dir/restarted-member-object.bin"

echo "Verified $image_ref on $platform"
