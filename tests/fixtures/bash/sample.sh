#!/usr/bin/env bash
# Sample script.
set -euo pipefail

source ./lib/common.sh
. "$(dirname "$0")/helpers.sh"
source lib/other.sh

# Global config.
export API_TOKEN="abc"
readonly MAX_RETRIES=3
LOG_LEVEL=info
declare -r FOO=1
local_thing=2

# Logs a message.
log() {
  echo "[$LOG_LEVEL] $*" >&2
}

# Fetches a user.
function fetch_user() {
  local id="$1"
  local name=$(get_name "$id")
  curl -s "$BASE_URL/users/$id" | jq .
  log "fetched $id ${HOME}"
  if [ -n "$API_TOKEN" ]; then
    retry 3 fetch_user "$id"
  fi
}

fetch_user 42
log "done"
