# Released weights

The current SUWA-WM release, committed so a fresh clone works without training.

| file | what |
|---|---|
| `execution.pt` | the shipped model: world-model backbone + execution heads |
| `backbone.pt` | the JEPA-pretrained backbone alone, for fine-tuning |
| `metrics.json` | held-out results for this exact checkpoint |
| `walkforward.json` | the headline evaluation: 4 folds x 2 seeds, aggregated |

Canonical weights hash — the value the chain attests to for a release, and what
`verify.py` recomputes:

```
0xa6ef2c399de54426b346e00b115f049893916a9447087c61063ea49e565e5f6f
```

```bash
python3 model/verify.py model/weights/execution.pt a6ef2c399de54426b346e00b115f049893916a9447087c61063ea49e565e5f6f
```

Trained on `data/market.npz` (sha256 `546fd9038f30da8469c19df29e0ee1e955ef8252c5609ed620cc25bbf4102cec`),
17,520 hours x 43 assets of hourly Coinbase OHLCV. Licence: **Apache-2.0**.
