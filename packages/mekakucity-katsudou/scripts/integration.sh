#!/bin/sh
set -eu

package_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
port=43119
log_file="$package_dir/target/katsudou-integration.log"

pnpm --dir "$package_dir" build >/dev/null
cargo test --manifest-path "$package_dir/Cargo.toml" invalid_routes_do_not_create_actor_workers >/dev/null
cargo build --manifest-path "$package_dir/Cargo.toml" >/dev/null
"$package_dir/target/debug/katsudou" \
  --listen "127.0.0.1:$port" \
  --app "demo=$package_dir/fixtures/counter/dist/counter.iife.js" \
  >"$log_file" 2>&1 &
server_pid=$!
trap 'kill "$server_pid" 2>/dev/null || true; wait "$server_pid" 2>/dev/null || true' EXIT INT TERM

until curl --silent --output /dev/null "http://127.0.0.1:$port/apps/missing/_actors/Counter/a/increment"; do
  if ! kill -0 "$server_pid" 2>/dev/null; then
    sed -n '1,120p' "$log_file"
    exit 1
  fi
done

post() {
  curl --silent --show-error --request POST --header 'Content-Type: application/json' --data '[]' "http://127.0.0.1:$port$1"
}

post_with_status() {
  curl --silent --show-error --request POST --header 'Content-Type: application/json' --data '[]' \
    --write-out '|%{http_code}' "http://127.0.0.1:$port$1"
}

assert_response() {
  label=$1
  expected=$2
  actual=$3
  if [ "$actual" != "$expected" ]; then
    printf '%s: expected %s, got %s\n' "$label" "$expected" "$actual" >&2
    exit 1
  fi
  printf '%s: %s\n' "$label" "$actual"
}

thread_count() {
  pid=$1
  if [ -d "/proc/$pid/task" ]; then
    set -- "/proc/$pid/task"/*
    printf '%s' "$#"
    return
  fi

  count=$(ps -M "$pid" 2>/dev/null | wc -l | tr -d ' ')
  if [ "$count" -gt 0 ]; then
    printf '%s' "$count"
    return
  fi
  return 1
}

assert_response 'Counter/a increment #1' '1' "$(post '/apps/demo/_actors/Counter/a/increment')"
assert_response 'Counter/a increment #2' '2' "$(post '/apps/demo/_actors/Counter/a/increment')"
assert_response 'Counter/b increment #1' '1' "$(post '/apps/demo/_actors/Counter/b/increment')"
assert_response 'Counter/b moduleCalls' '1' "$(post '/apps/demo/_actors/Counter/b/moduleCalls')"
assert_response 'Counter/a increment #3' '3' "$(post '/apps/demo/_actors/Counter/a/increment')"
assert_response 'Counter/a moduleCalls' '3' "$(post '/apps/demo/_actors/Counter/a/moduleCalls')"
assert_response 'unknown app' '{"error":"unknown app","appId":"missing"}|404' "$(post_with_status '/apps/missing/_actors/Counter/a/increment')"
assert_response 'unknown actor type' '{"error":"unknown actor type","actorType":"Missing"}|404' "$(post_with_status '/apps/demo/_actors/Missing/a/increment')"
assert_response 'unknown action' '{"error":"unknown action","action":"missing"}|404' "$(post_with_status '/apps/demo/_actors/Counter/a/missing')"

if threads_before=$(thread_count "$server_pid"); then
  index=0
  while [ "$index" -lt 20 ]; do
    assert_response "unknown actor type x$index" '{"error":"unknown actor type","actorType":"Missing"}|404' \
      "$(post_with_status "/apps/demo/_actors/Missing/x$index/go")" >/dev/null
    assert_response "unknown action x$index" '{"error":"unknown action","action":"missing"}|404' \
      "$(post_with_status "/apps/demo/_actors/Counter/x$index/missing")" >/dev/null
    index=$((index + 1))
  done
  threads_after=$(thread_count "$server_pid")
  assert_response 'threads after invalid routes' "$threads_before" "$threads_after"
else
  printf '%s\n' 'threads after invalid routes: OS thread inspection unavailable; worker-map regression passed'
fi

python3 - "$port" <<'PY'
import socket
import struct
import sys

port = int(sys.argv[1])
sock = socket.create_connection(("127.0.0.1", port))
sock.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))
sock.sendall(b"POST /apps/missing/_actors/Counter/a/increment HTTP/1.1\r\nHost: localhost\r\nContent-Length: 2\r\n\r\n[]")
sock.close()
PY

assert_response 'Counter/a moduleCalls after reset' '3' "$(post '/apps/demo/_actors/Counter/a/moduleCalls')"
