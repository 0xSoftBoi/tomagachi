#!/usr/bin/env bash
# Launch vLLM with the shared base and every trained character adapter.
#
#   ./deploy/vllm/serve.sh
#
# One base model, one LoRA per character, one GPU. That arrangement is the
# whole margin story: the second character is served out of capacity the first
# already paid for (research/operating-plan.md).
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BASE_MODEL="${BASE_MODEL:-$(python3 -c "import json;print(json.load(open('$REPO/model/characters.json'))['base'])")}"
PORT="${VLLM_PORT:-8000}"
MAX_LEN="${MAX_MODEL_LEN:-32768}"
DTYPE="${DTYPE:-bfloat16}"
GPU_FRACTION="${GPU_MEMORY_UTILIZATION:-0.90}"

# Let the creature hot-swap a freshly trained epoch in without dropping traffic.
export VLLM_ALLOW_RUNTIME_LORA_UPDATING="${VLLM_ALLOW_RUNTIME_LORA_UPDATING:-True}"

echo "[vllm] base: $BASE_MODEL"
LORA_FLAGS="$(python3 "$REPO/deploy/vllm/prepare.py")"
echo "[vllm] adapters: ${LORA_FLAGS#*--lora-modules }"

# shellcheck disable=SC2086 -- the flags are generated as one argument string
exec vllm serve "$BASE_MODEL" \
  --port "$PORT" \
  --dtype "$DTYPE" \
  --max-model-len "$MAX_LEN" \
  --gpu-memory-utilization "$GPU_FRACTION" \
  --served-model-name base \
  $LORA_FLAGS \
  "$@"
