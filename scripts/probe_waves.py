"""Exploration de l'API « Package Modèles de vague et surcote » (Météo-France).

Liste, pour chaque modèle, les grilles (emprise, résolution), les paquets et les produits
disponibles. Lancé à la main dans GitHub Actions (la clé MF_API_KEY n'existe que là).
Aucune clé n'est affichée dans le journal.
"""
import json
import os
import sys
import urllib.error
import urllib.request

BASE = "https://public-api.meteofrance.fr/previnum/DPPaquetWAVESMODELS/v1"
KEY = os.environ.get("MF_API_KEY", "").strip()
MODELS = ["MFWAM", "WW3-MARP", "WW3-WARP", "WW3-MARO"]


def get(path):
    req = urllib.request.Request(BASE + path, headers={"apikey": KEY, "accept": "*/*", "User-Agent": "quel-spot-oleron/probe"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            raw = r.read()
            try:
                return json.loads(raw.decode("utf-8"))
            except Exception:
                return {"_raw": raw[:300].decode("utf-8", "replace")}
    except urllib.error.HTTPError as e:
        return {"_error": e.code, "_body": e.read()[:300].decode("utf-8", "replace").replace(KEY, "***")}


def short(x, n=1500):
    s = json.dumps(x, ensure_ascii=False)
    return s if len(s) <= n else s[:n] + "…"


def main():
    if not KEY:
        print("MF_API_KEY absente"); return 1
    for m in MODELS:
        print(f"\n===== {m} =====")
        print("modèle :", short(get(f"/models/{m}"), 800))
        grids = get(f"/models/{m}/grids")
        print("grilles :", short(grids, 1200))
        ids = []
        if isinstance(grids, list):
            ids = [g.get("grid", g.get("id", g)) if isinstance(g, dict) else g for g in grids]
        elif isinstance(grids, dict):
            for k in ("grids", "links", "items"):
                if isinstance(grids.get(k), list):
                    ids = [g.get("grid", g.get("id", g)) if isinstance(g, dict) else g for g in grids[k]]
        for g in ids[:6]:
            print(f"\n--- {m} grille {g}")
            print("description :", short(get(f"/models/{m}/grids/{g}"), 900))
            pk = get(f"/models/{m}/grids/{g}/packages")
            print("paquets :", short(pk, 900))
            names = []
            if isinstance(pk, list):
                names = [p.get("package", p.get("id", p)) if isinstance(p, dict) else p for p in pk]
            elif isinstance(pk, dict):
                for k in ("packages", "links", "items"):
                    if isinstance(pk.get(k), list):
                        names = [p.get("package", p.get("id", p)) if isinstance(p, dict) else p for p in pk[k]]
            for p in names[:4]:
                print(f"paquet {p} :", short(get(f"/models/{m}/grids/{g}/packages/{p}"), 1500))
    return 0


if __name__ == "__main__":
    sys.exit(main())
