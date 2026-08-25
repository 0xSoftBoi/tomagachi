# Released weights

The current SUWA-WM release, committed so a fresh clone works without training.

| file | what |
|---|---|
| `execution.pt` | the shipped model: world-model backbone + execution heads |
| `backbone.pt` | the JEPA-pretrained backbone alone, for fine-tuning |
| `metrics.json` | measured test-set results, benchmarks, and the ablation |
| `pretrain.json` | pretraining history and representation-health checks |

Canonical weights hash of `execution.pt` — this is the value the chain attests
to for a release, and what `verify.py` recomputes:

```
0xfe782b9fa76ee9e0afbdbafa88e1ae1aac18082540c06ed36c71506f414c2ffb
```

```bash
python3 model/verify.py model/weights/execution.pt \
  fe782b9fa76ee9e0afbdbafa88e1ae1aac18082540c06ed36c71506f414c2ffb
```

Trained on `data/market.npz` (sha256 `d285ba1943e9b0b1573eedd8ae34883177854a84ddb3fdc115f7ea8a63e36aab`),
1,941 hours x 19 assets. Licence: **Apache-2.0**.
