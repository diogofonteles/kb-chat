"""Print the OpenRouter balance (real balance = total credits minus usage).

The key is read from the OPENROUTER_API_KEY environment variable and only goes into the request header;
it is never printed or written.

Usage:
  python openrouter_balance.py
"""

import json
import os
import urllib.request


def balance() -> dict:
    req = urllib.request.Request(
        "https://openrouter.ai/api/v1/credits",
        headers={"Authorization": "Bearer " + os.environ["OPENROUTER_API_KEY"]},
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        d = json.load(r)["data"]
    return {
        "total_credits": d["total_credits"],
        "total_usage": round(d["total_usage"], 6),
        "balance": round(d["total_credits"] - d["total_usage"], 6),
    }


if __name__ == "__main__":
    print(json.dumps(balance()))
