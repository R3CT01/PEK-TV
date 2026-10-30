#!/data/data/com.termux/files/usr/bin/sh
# Deploys a JavaScript file to a Cloudflare Worker (only the code; variables, secrets and bindings stay as they are).
#
#   deploy-worker.sh <file.js> <worker-name>
#   deploy-worker.sh billing-worker.js pek-billing
#   deploy-worker.sh cloud/worker.js pek-sync
#
# Leave out the worker name and it uses CF_WORKER from ~/.cf.
# Leave out both and it deploys ./worker.js to CF_WORKER (the old behaviour).
# ~/.cf must set CF_ACCOUNT and CF_TOKEN, and CF_WORKER if you want a default worker.
. ~/.cf

file="${1:-worker.js}"
worker="${2:-$CF_WORKER}"

# old habit: a folder as the first argument means "deploy worker.js from that folder"
if [ -d "$file" ]; then cd "$file" || exit 1; file=worker.js; fi

[ -f "$file" ] || { echo "File not found: $file"; exit 1; }
[ -n "$worker" ] || { echo "No worker name. Use: deploy-worker.sh $file <worker-name>"; exit 1; }
{ [ -n "$CF_ACCOUNT" ] && [ -n "$CF_TOKEN" ]; } || { echo "CF_ACCOUNT or CF_TOKEN is missing in ~/.cf"; exit 1; }

case "$worker" in *[!A-Za-z0-9_-]*) echo "Worker names can only use letters, numbers, - and _ : $worker"; exit 1;; esac
base=$(basename "$file")
case "$base" in *[!A-Za-z0-9._-]*) echo "Rename the file so it only uses letters, numbers, . - and _ : $base"; exit 1;; esac

out=$(curl -s -X PUT \
  "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT/workers/scripts/$worker/content" \
  -H "Authorization: Bearer $CF_TOKEN" \
  -F "metadata={\"main_module\":\"$base\"};type=application/json" \
  -F "$base=@$file;type=application/javascript+module")

if echo "$out" | grep -Eq '"success": ?true'; then
  echo "Deployed $file to $worker"
else
  echo "Failed to deploy $file to $worker:"
  echo "$out"
  exit 1
fi
