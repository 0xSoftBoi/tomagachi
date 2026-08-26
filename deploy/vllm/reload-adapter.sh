#!/usr/bin/env bash
# Swap in a newly trained epoch without restarting vLLM or dropping traffic.
#
#   ./deploy/vllm/reload-adapter.sh suwa-tide
#
# The creature trains an epoch every tick, so a restart per epoch would mean
# permanent downtime — and uptime below 95% costs routing priority.
set -euo pipefail

CHARACTER="${1:?usage: reload-adapter.sh <character-id>}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VLLM="${VLLM_BASE_URL:-http://localhost:8000}"

python3 "$REPO/deploy/vllm/prepare.py" >/dev/null
ADAPTER_DIR="${SERVING_DIR:-$REPO/serving}/$CHARACTER"
[ -f "$ADAPTER_DIR/adapter_config.json" ] || { echo "no adapter at $ADAPTER_DIR"; exit 1; }

curl -fsS -X POST "$VLLM/v1/load_lora_adapter" \
  -H 'content-type: application/json' \
  -d "{\"lora_name\":\"$CHARACTER\",\"lora_path\":\"$ADAPTER_DIR\",\"load_inplace\":true}"
echo
echo "[vllm] $CHARACTER reloaded from $ADAPTER_DIR"
