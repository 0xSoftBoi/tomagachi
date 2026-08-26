#!/usr/bin/env bash
# Walk-forward evaluation across folds and seeds.
#
# Each (fold, seed) is an independent process pinned to one torch thread, so
# running them concurrently uses the cores without breaking determinism.
set -u
DATA="${DATA:-../data/market.npz}"
OUT="${OUT:-../runs/bench}"
FOLDS="${FOLDS:-4}"
SEEDS="${SEEDS:-1 2}"
PRE="${PRE:-500}"
STEPS="${STEPS:-900}"
CONC="${CONC:-4}"

mkdir -p "$OUT"
first_seed=$(echo $SEEDS | awk '{print $1}')

for seed in $SEEDS; do
  # The ablation doubles the cost, so run it once per fold on the first seed.
  ablation=""
  [ "$seed" = "$first_seed" ] && ablation="--ablation"

  running=0
  for ((fold=0; fold<FOLDS; fold++)); do
    python3 benchmark.py --data "$DATA" --fold "$fold" --n-folds "$FOLDS" \
      --seed "$seed" --pretrain-steps "$PRE" --steps "$STEPS" \
      $ablation --out "$OUT" > "$OUT/fold${fold}_seed${seed}.log" 2>&1 &
    running=$((running+1))
    if [ "$running" -ge "$CONC" ]; then wait; running=0; fi
  done
  wait
  echo "seed $seed complete"
done

python3 aggregate.py --dir "$OUT"
