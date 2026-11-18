"""Archive les mesures réelles (anémomètres Météo-France, bouées Candhis) mois par mois.

Usage : python scripts/archive_obs.py data/obs.json archive/obs
Chaque passage fusionne les dernières 24-48 h de data/obs.json dans archive/obs/AAAA-MM.json,
au pas de 30 min, pour retrouver plus tard les conditions réelles d'une session.
Format : {"wind": {id: {"t": [v, g, d]}}, "buoy": {id: {"t": [hs, hmax, tp, dir]}}}
"""
import json
import sys
from pathlib import Path


def slot(t: str):
    # garde :00 et :30 (UTC), ignore les autres pas de 6 min
    return t[:16] if t[14:16] in ("00", "30") else None


def main(src: str, dst: str) -> int:
    obs = json.load(open(src, encoding="utf-8"))
    out_dir = Path(dst)
    out_dir.mkdir(parents=True, exist_ok=True)
    months = {}

    def month(t):
        m = t[:7]
        if m not in months:
            f = out_dir / f"{m}.json"
            months[m] = json.load(open(f, encoding="utf-8")) if f.exists() else {"wind": {}, "buoy": {}}
        return months[m]

    n = 0
    for st in obs.get("stations") or []:
        for r in st.get("series", []):
            k = slot(r["t"])
            if k:
                month(k)["wind"].setdefault(st["id"], {})[k] = [r.get("v"), r.get("g"), r.get("d")]
                n += 1
    for b in obs.get("buoys") or []:
        for r in b.get("series", []):
            k = slot(r["t"])
            if k and r.get("hs") is not None:
                month(k)["buoy"].setdefault(b["id"], {})[k] = [r.get("hs"), r.get("hmax"), r.get("tp", r.get("th")), r.get("dir")]
                n += 1
    for m, data in months.items():
        (out_dir / f"{m}.json").write_text(json.dumps(data, separators=(",", ":"), sort_keys=True), encoding="utf-8")
    print(f"{n} mesures fusionnées dans {', '.join(sorted(months)) or 'aucun mois'}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1], sys.argv[2]))
