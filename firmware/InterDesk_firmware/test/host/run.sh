#!/usr/bin/env bash
set -euo pipefail
project_dir="$(cd -- "$(dirname -- "$0")/../.." && pwd)"
test_binary="$(mktemp /tmp/interdesk-firmware-test.XXXXXX)"
trap 'rm -f "$test_binary"' EXIT
c++ -std=c++17 -Wall -Wextra -Werror \
    -I"$project_dir/test/host/stubs" -I"$project_dir/src" \
    "$project_dir/test/host/ble_server_test.cpp" \
    "$project_dir/src/ble/ble_server.cpp" "$project_dir/src/ble/ble_callbacks.cpp" \
    -o "$test_binary"
"$test_binary"
c++ -std=c++17 -Wall -Wextra -Werror -I"$project_dir/src" \
    "$project_dir/test/host/pairing_code_test.cpp" -o "$test_binary"
"$test_binary"
