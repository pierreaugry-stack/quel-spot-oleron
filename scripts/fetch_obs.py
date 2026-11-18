"""Récupère les mesures des bouées Candhis (Cerema) et les écrit dans data/obs.json.

Candhis n'a pas d'API publique et ses pages ne sont pas lisibles depuis un navigateur
d'un autre site : ce script tourne dans GitHub Actions (toutes les 30 min) et publie
le résultat à côté de la page. Une seule requête par bouée et par passage.
"""
import base64
import json
import re
import sys
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path


def _last_sunday(year: int, month: int) -> datetime:
    d = datetime(year, month + 1, 1) - timedelta(days=1) if month < 12 else datetime(year, 12, 31)
    return d - timedelta(days=(d.weekday() + 1) % 7)


def paris_to_utc(local: datetime) -> datetime:
    """Heure de Paris -> UTC (heure d'été du dernier dimanche de mars au dernier d'octobre)."""
    start = _last_sunday(local.year, 3).replace(hour=2)
    end = _last_sunday(local.year, 10).replace(hour=3)
    offset = 2 if start <= local < end else 1
    return (local - timedelta(hours=offset)).replace(tzinfo=timezone.utc)
# Positions approximatives (Candhis ne les publie pas dans la page de la campagne).
BUOYS = [
    {"id": "08504", "name": "Île d'Yeu Nord", "lat": 46.83, "lon": -2.29},
    {"id": "08505", "name": "Noirmoutier", "lat": 46.92, "lon": -2.45},
    {"id": "01705", "name": "Royan", "lat": 45.62, "lon": -1.12},
    {"id": "03302", "name": "Cap Ferret", "lat": 44.65, "lon": -1.45},
]
FIELDS = {
    "H1/3 (m)": "hs",
    "Hmax (m)": "hmax",
    "Th1/3 (s)": "th",
    "T. au pic (s)": "tp",
    "Dir. au pic (°)": "dir",
    "Temp. mer (°C)": "sst",
}
UA = "Mozilla/5.0 (compatible; quel-spot-oleron/2.0; +https://github.com/)"


def fetch(code: str) -> str:
    q = base64.b64encode(f"camp={code}".encode()).decode()
    req = urllib.request.Request(
        f"https://candhis.cerema.fr/_public_/campagne.php?{q}", headers={"User-Agent": UA}
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8", errors="replace")


def parse(html: str) -> list:
    rows = {}
    for m in re.finditer(r"arrDataPHP\[\d+\]\s*=\s*eval\('(\[.*?\])'\);", html, re.S):
        raw = m.group(1)
        try:
            data = json.loads(raw)
        except ValueError:
            continue
        for point in data:
            if len(point) < 3:
                continue
            label_html = point[2] if isinstance(point[2], str) else ""
            lab = re.search(r"<b>([^<]+)</b>", label_html.replace("\\/", "/"))
            if not lab:
                continue
            key = FIELDS.get(lab.group(1).replace("\\/", "/").strip())
            if not key:
                continue
            t = paris_to_utc(datetime.strptime(point[0], "%Y-%m-%d %H:%M")).strftime("%Y-%m-%dT%H:%M:%SZ")
            rows.setdefault(t, {"t": t})[key] = point[1]
            # Hmax est dans la même série que H1/3 (colonnes 3 et 4)
            if key == "hs" and len(point) >= 5 and isinstance(point[3], (int, float)):
                rows[t]["hmax"] = point[3]
    return sorted(rows.values(), key=lambda r: r["t"])


def main(out: Path) -> int:
    result = {"generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "buoys": []}
    ok = 0
    for b in BUOYS:
        entry = dict(b, approx=True, series=[], error=None)
        try:
            entry["series"] = parse(fetch(b["id"]))[-96:]
            ok += bool(entry["series"])
        except Exception as e:  # une bouée en panne ne bloque pas les autres
            entry["error"] = str(e)[:200]
        result["buoys"].append(entry)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"{ok}/{len(BUOYS)} bouées avec des données -> {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main(Path(sys.argv[1] if len(sys.argv) > 1 else "data/obs.json")))
