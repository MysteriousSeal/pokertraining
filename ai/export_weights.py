"""Export a checkpoint's weights to JSON for the Chrome extension.

    ai/.venv/bin/python ai/export_weights.py [--checkpoint ai/checkpoints/best.pt]
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import torch

from common import ACTIONS, CHECKPOINTS, ROOT, load

OUT = ROOT / "extension" / "model.json"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--checkpoint", type=Path, default=CHECKPOINTS / "best.pt")
    args = ap.parse_args()

    policy = load(args.checkpoint)
    meta = torch.load(args.checkpoint, map_location="cpu").get("meta", {})
    linears = [m for m in policy.body if isinstance(m, torch.nn.Linear)] + [policy.pi]

    def layer(lin: torch.nn.Linear) -> dict:
        return {
            "in": lin.in_features,
            "out": lin.out_features,
            # Row-major [out][in], rounded to keep the file small.
            "w": [round(v, 6) for v in lin.weight.detach().flatten().tolist()],
            "b": [round(v, 6) for v in lin.bias.detach().tolist()],
        }

    model = {
        "checkpoint": args.checkpoint.name,
        "games": meta.get("games", 0),
        "win": meta.get("win", 0),
        "actions": ACTIONS,
        "activation": "tanh",
        # Hidden layers use tanh; the last layer gives the action logits.
        "layers": [layer(l) for l in linears],
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(model, separators=(",", ":")))
    print(f"Exported {args.checkpoint} ({model['games']:,} games, {model['win'] * 100:.1f}%) → {OUT} ({OUT.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
