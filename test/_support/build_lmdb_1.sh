#!/usr/bin/env bash
set -euo pipefail

readonly url='https://git.openldap.org/openldap/openldap/-/archive/LMDB_1.0.0/openldap-LMDB_1.0.0.tar.gz'
readonly archive_sha='a61ded12bd9c670038b77483dda13b50684a93a111e53421dfb979624ae9f72e'
readonly header_sha='b9267c09ade0147e224316d0195c8ee3e9b8cc130ba196fad020bccb7b1cd043'
readonly output_dir="${1:?usage: build_lmdb_1.sh ABSOLUTE_OUTPUT_DIRECTORY}"

case "$output_dir" in
  /*) ;;
  *) echo 'output directory must be absolute' >&2; exit 64 ;;
esac

canonicalize_destination() {
  local candidate="${1%/}"
  local component
  local canonical
  local -a suffix=()

  if [[ -z "$candidate" ]]; then candidate='/'; fi
  while [[ ! -e "$candidate" ]]; do
    component="$(basename "$candidate")"
    if ((${#suffix[@]} == 0)); then
      suffix=("$component")
    else
      suffix=("$component" "${suffix[@]}")
    fi
    candidate="$(dirname "$candidate")"
  done
  if [[ ! -d "$candidate" ]]; then
    echo 'output directory must descend from a directory' >&2
    exit 64
  fi

  canonical="$(cd -P -- "$candidate" && pwd -P)"
  if ((${#suffix[@]} > 0)); then
    for component in "${suffix[@]}"; do
      case "$component" in
        '' | '.') ;;
        '..')
          if [[ "$canonical" != '/' ]]; then
            canonical="${canonical%/*}"
            if [[ -z "$canonical" ]]; then canonical='/'; fi
          fi
          ;;
        *)
          if [[ "$canonical" = '/' ]]; then
            canonical="/$component"
          else
            canonical="$canonical/$component"
          fi
          ;;
      esac
    done
  fi
  printf '%s\n' "$canonical"
}

destination_ancestor_is_repository() {
  local candidate="${1%/}"
  local parent

  if [[ -z "$candidate" ]]; then candidate='/'; fi
  while [[ ! -e "$candidate" ]]; do
    candidate="$(dirname "$candidate")"
  done
  while true; do
    if [[ "$candidate" -ef "$repository_dir" ]]; then return 0; fi
    parent="$(dirname "$candidate")"
    if [[ "$parent" = "$candidate" ]]; then return 1; fi
    candidate="$parent"
  done
}

repository_dir="$(
  cd -P -- "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P
)"
readonly repository_dir
canonical_output_dir="$(canonicalize_destination "$output_dir")"
readonly canonical_output_dir
if destination_ancestor_is_repository "$output_dir"; then
  echo 'LMDB build output must stay outside the repository' >&2
  exit 64
fi
case "$canonical_output_dir/" in
  "$repository_dir/"*)
    echo 'LMDB build output must stay outside the repository' >&2
    exit 64
    ;;
esac

work_dir="$(mktemp -d "${TMPDIR:-/tmp}/deno-lmdb-1.0.0.XXXXXX")"
trap 'rm -rf "$work_dir"' EXIT
curl -fsSL "$url" -o "$work_dir/openldap-LMDB_1.0.0.tar.gz"

hash_file() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    sha256sum "$1" | awk '{print $1}'
  fi
}

test "$(hash_file "$work_dir/openldap-LMDB_1.0.0.tar.gz")" = "$archive_sha"
tar -xzf "$work_dir/openldap-LMDB_1.0.0.tar.gz" -C "$work_dir"
src="$work_dir/openldap-LMDB_1.0.0/libraries/liblmdb"
test "$(hash_file "$src/lmdb.h")" = "$header_sha"
mkdir -p "$canonical_output_dir"

case "$(uname -s)" in
  Darwin)
    cc -O2 -pthread -fPIC -dynamiclib \
      -Wl,-current_version,1.0 -Wl,-compatibility_version,1.0 \
      "$src/mdb.c" "$src/midl.c" "$src/module.c" \
      -o "$canonical_output_dir/liblmdb.dylib"
    library="$canonical_output_dir/liblmdb.dylib"
    ;;
  Linux)
    cc -O2 -pthread -fPIC -shared -Wl,-soname,liblmdb.so.1 \
      "$src/mdb.c" "$src/midl.c" "$src/module.c" -ldl \
      -o "$canonical_output_dir/liblmdb.so.1.0"
    ln -sfn liblmdb.so.1.0 "$canonical_output_dir/liblmdb.so.1"
    ln -sfn liblmdb.so.1.0 "$canonical_output_dir/liblmdb.so"
    library="$canonical_output_dir/liblmdb.so.1.0"
    ;;
  *)
    echo 'only macOS and Linux test builds are supported' >&2
    exit 69
    ;;
esac

printf '%s\n' "$library"
