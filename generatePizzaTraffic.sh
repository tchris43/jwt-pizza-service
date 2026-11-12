#!/usr/bin/env bash

# Generate sample requests for a JWT Pizza Service deployment.
# Traffic users are registered if they do not already exist. The menu item,
# franchise, and store used by order requests must already exist.
# Stop the script with Ctrl+C. Use it only against a service you are allowed to test.

if [[ -z "${1:-}" ]]; then
  echo "Usage: $0 <host>"
  echo "Example: $0 https://your-pizza-service.example.com"
  exit 1
fi

for tool in curl jq; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "This script requires $tool." >&2
    exit 1
  fi
done

# Keep the host easy to pass with or without a trailing slash.
host=${1%/}

# These stable email addresses are registered once, then reused on later runs.
# Override them and their passwords if these addresses already belong to other users.
DINER_EMAIL=${DINER_EMAIL:-pizza-traffic-diner@example.com}
DINER_PASSWORD=${DINER_PASSWORD:-pizza-traffic-329}
SECOND_USER_EMAIL=${SECOND_USER_EMAIL:-pizza-traffic-user@example.com}
SECOND_USER_PASSWORD=${SECOND_USER_PASSWORD:-pizza-traffic-329}
INVALID_EMAIL=${INVALID_EMAIL:-unknown-traffic-user@invalid.example}
FRANCHISE_ID=${FRANCHISE_ID:-1}
STORE_ID=${STORE_ID:-1}
MENU_ID=${MENU_ID:-1}

# Return only the HTTP status code, while still printing network errors to stderr.
# Arguments are passed directly to curl; eval is deliberately avoided.
request_status() {
  curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
    --connect-timeout 10 --max-time 30 "$@"
}

# Log in and print just the token. A missing/invalid token makes this function fail.
login() {
  local email=$1
  local password=$2
  local payload response

  payload=$(jq -cn --arg email "$email" --arg password "$password" \
    '{email: $email, password: $password}')
  response=$(curl --silent --show-error --connect-timeout 10 --max-time 30 \
    -X PUT "$host/api/auth" \
    -H 'Content-Type: application/json' \
    --data "$payload") || return 1

  printf '%s' "$response" | jq -er '.token | select(type == "string" and length > 0)' 2>/dev/null
}

logout() {
  local token=$1
  request_status -X DELETE "$host/api/auth" \
    -H "Authorization: Bearer $token"
}

# Reuse an account if these credentials work. Otherwise, register it as a diner.
# Registration only creates the user; it does not create a franchise, store, or menu.
ensure_user() {
  local name=$1
  local email=$2
  local password=$3
  local token payload response status

  if token=$(login "$email" "$password"); then
    status=$(request_status "$host/api/user/me" \
      -H "Authorization: Bearer $token") || status="curl error"
    if [[ "$status" == "200" ]]; then
      logout "$token" >/dev/null 2>&1 || true
      echo "Using existing traffic account: $email"
      return 0
    fi
  fi

  payload=$(jq -cn --arg name "$name" --arg email "$email" --arg password "$password" \
    '{name: $name, email: $email, password: $password}')
  response=$(curl --silent --show-error --connect-timeout 10 --max-time 30 \
    -X POST "$host/api/auth" \
    -H 'Content-Type: application/json' \
    --data "$payload") || response=""
  token=$(printf '%s' "$response" | jq -er \
    '.token | select(type == "string" and length > 0)' 2>/dev/null) || token=""

  if [[ -n "$token" ]]; then
    status=$(request_status "$host/api/user/me" \
      -H "Authorization: Bearer $token") || status="curl error"
    logout "$token" >/dev/null 2>&1 || true
    if [[ "$status" == "200" ]]; then
      echo "Registered traffic account: $email"
      return 0
    fi
  fi

  echo "Could not log in or register $email." >&2
  echo "If this email already exists, set its correct password or choose a different email." >&2
  return 1
}

# Reuse the same valid order, and build a 21-pizza order for the expected
# factory rejection scenario. The latter still depends on the factory's limit.
order_payload=$(jq -cn \
  --argjson franchiseId "$FRANCHISE_ID" \
  --argjson storeId "$STORE_ID" \
  --argjson menuId "$MENU_ID" \
  '{franchiseId: $franchiseId, storeId: $storeId,
    items: [{menuId: $menuId, description: "Veggie", price: 0.05}]}') || exit 1

too_many_items=$(jq -cn --argjson menuId "$MENU_ID" \
  '[range(0; 21) | {menuId: $menuId, description: "Veggie", price: 0.05}]') || exit 1
failed_order_payload=$(jq -cn \
  --argjson franchiseId "$FRANCHISE_ID" \
  --argjson storeId "$STORE_ID" \
  --argjson items "$too_many_items" \
  '{franchiseId: $franchiseId, storeId: $storeId, items: $items}') || exit 1

pids=()

cleanup() {
  trap - INT TERM
  echo "Terminating background traffic loops..."
  if ((${#pids[@]})); then
    kill "${pids[@]}" 2>/dev/null || true
    wait "${pids[@]}" 2>/dev/null || true
  fi
  exit 0
}
trap cleanup INT TERM

# Public requests increment HTTP request metrics, but do not make a user active.
request_menu_loop() {
  while true; do
    result=$(request_status "$host/api/order/menu") || result="curl error"
    echo "Requesting menu... $result"
    sleep 3
  done
}

# Failed logins exercise the failed-authentication counter.
invalid_login_loop() {
  local payload result
  payload=$(jq -cn --arg email "$INVALID_EMAIL" '{email: $email, password: "bad"}')
  while true; do
    result=$(request_status -X PUT "$host/api/auth" \
      -H 'Content-Type: application/json' --data "$payload") || result="curl error"
    echo "Logging in with invalid credentials... $result"
    sleep 25
  done
}

# Keep a second authenticated user active during the session.
second_user_loop() {
  local token result i
  while true; do
    if token=$(login "$SECOND_USER_EMAIL" "$SECOND_USER_PASSWORD"); then
      echo "Login second user... true"
      for ((i = 0; i < 4; i++)); do
        result=$(request_status "$host/api/user/me" \
          -H "Authorization: Bearer $token") || result="curl error"
        echo "Second user authenticated activity... $result"
        sleep 30
      done
      result=$(logout "$token") || result="curl error"
      echo "Logging out second user... $result"
    else
      echo "Login second user... false (the account setup or authentication failed)"
      sleep 30
    fi
  done
}

# A successful login plus an authenticated order generates active-user,
# request, auth, and purchase metrics. The order needs valid seeded IDs.
diner_order_loop() {
  local token result
  while true; do
    if token=$(login "$DINER_EMAIL" "$DINER_PASSWORD"); then
      echo "Login diner... true"
      result=$(request_status -X POST "$host/api/order" \
        -H 'Content-Type: application/json' \
        -H "Authorization: Bearer $token" \
        --data "$order_payload") || result="curl error"
      echo "Buying a pizza... $result"
      sleep 20
      result=$(logout "$token") || result="curl error"
      echo "Logging out diner... $result"
    else
      echo "Login diner... false (check the account and service response)"
    fi
    sleep 30
  done
}

# Submit an oversized order occasionally to exercise the factory-failure path.
failed_order_loop() {
  local token result
  while true; do
    if token=$(login "$DINER_EMAIL" "$DINER_PASSWORD"); then
      echo "Login hungry diner... true"
      result=$(request_status -X POST "$host/api/order" \
        -H 'Content-Type: application/json' \
        -H "Authorization: Bearer $token" \
        --data "$failed_order_payload") || result="curl error"
      echo "Submitting oversized pizza order... $result"
      result=$(logout "$token") || result="curl error"
      echo "Logging out hungry diner... $result"
    else
      echo "Login hungry diner... false (check the account and service response)"
    fi
    sleep 300
  done
}

# Confirm both accounts can make authenticated requests before starting the
# endless traffic loops. This avoids silently generating only public traffic.
ensure_user "Pizza Traffic Diner" "$DINER_EMAIL" "$DINER_PASSWORD" || exit 1
ensure_user "Pizza Traffic User" "$SECOND_USER_EMAIL" "$SECOND_USER_PASSWORD" || exit 1

request_menu_loop &
pids+=("$!")
invalid_login_loop &
pids+=("$!")
second_user_loop &
pids+=("$!")
diner_order_loop &
pids+=("$!")
failed_order_loop &
pids+=("$!")

echo "Traffic is being sent to $host. Press Ctrl+C to stop."
wait "${pids[@]}"
