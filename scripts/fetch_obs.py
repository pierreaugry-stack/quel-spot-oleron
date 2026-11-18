"""Récupère les mesures des bouées Candhis (Cerema) et les écrit dans data/obs.json.

Candhis n'a pas d'API publique et ses pages ne sont pas lisibles depuis un navigateur
d'un autre site : ce script tourne dans GitHub Actions (toutes les 30 min) et publie
le résultat à côté de la page. Une seule requête par bouée et par passage.
"""
import base64
import json
import os
import re
import sys
import urllib.error
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
# Positions officielles (page « cartes » de Candhis). 01704 est muette depuis le 18/04/2026 :
# gardée pour reprendre automatiquement si elle revient.
BUOYS = [
    {"id": "01704", "name": "Oléron Large", "lat": 45.9163, "lon": -1.8336, "depth": 50},
    {"id": "08504", "name": "Île d'Yeu Nord", "lat": 46.8332, "lon": -2.2950, "depth": 9},
    {"id": "08505", "name": "Noirmoutier", "lat": 46.9238, "lon": -2.4679, "depth": 18},
    {"id": "01705", "name": "Royan", "lat": 45.6100, "lon": -1.0317, "depth": 14},
    {"id": "03302", "name": "Cap Ferret", "lat": 44.6525, "lon": -1.4467, "depth": 54},
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


# Anémomètres Météo-France (API « Données d'observation », clé dans le secret MF_API_KEY).
MF_STATIONS = [
    {"id": "17323001", "name": "Chassiron", "lat": 46.0468, "lon": -1.4117},
    {"id": "17318001", "name": "Phare des Baleines", "lat": 46.2430, "lon": -1.5617},
    {"id": "17300009", "name": "La Rochelle – Île de Ré", "lat": 46.1780, "lon": -1.1932},
    {"id": "17306004", "name": "Royan – Médis", "lat": 45.6330, "lon": -0.9747},
]
# « Package Observations » : 24 h de mesures 6 min pour tout le département en une requête.
MF_URL = "https://public-api.meteofrance.fr/public/DPPaquetObs/v1/paquet/infrahoraire-6m?id-departement=17&format=json"
# « Données d'observation » : dernière mesure d'une station (repli si le paquet n'est pas souscrit).
MF_STATION_URL = "https://public-api.meteofrance.fr/public/DPObs/v1/station/infrahoraire-6m?id_station={id}&format=json"


def num(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def fetch_mf(key: str) -> list:
    """24 h d'observations toutes les 6 min pour la Charente-Maritime (une seule requête)."""
    def get(url):
        req = urllib.request.Request(url, headers={"apikey": key, "accept": "*/*", "User-Agent": UA})
        with urllib.request.urlopen(req, timeout=60) as r:
            data = json.loads(r.read().decode("utf-8"))
        return data if isinstance(data, list) else [data]
    try:
        try:
            rows = get(MF_URL.replace("/v1/", "/v2/"))  # le portail affiche la version 2
        except urllib.error.HTTPError as e0:
            if e0.code in (401, 403):
                raise
            rows = get(MF_URL)
    except urllib.error.HTTPError as e:
        print(f"Package Observations : erreur {e.code}, repli sur Données d'observation")
        rows = []
        for st in MF_STATIONS:
            try:
                rows += get(MF_STATION_URL.format(id=st["id"]))
            except urllib.error.HTTPError as e2:
                if e2.code in (401, 403):
                    raise
                print(f"Station {st['id']} : erreur {e2.code}")
    out = []
    for st in MF_STATIONS:
        series = []
        for row in rows:
            if str(row.get("geo_id_insee")) != st["id"]:
                continue
            ff, dd = num(row.get("ff")), num(row.get("dd"))
            gust = num(row.get("fxi10")) or num(row.get("fxi"))
            t = row.get("validity_time") or row.get("reference_time")
            if t is None or ff is None:
                continue
            series.append({"t": t[:19] + "Z" if not t.endswith("Z") else t,
                           "v": round(ff * 3.6, 1), "g": None if gust is None else round(gust * 3.6, 1),
                           "d": dd, "temp": num(row.get("t"))})
        series.sort(key=lambda r: r["t"])
        out.append(dict(st, series=series[-240:]))
    return out


def main(out: Path) -> int:
    result = {"generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "buoys": [], "stations": [], "stationsNote": None}
    key = os.environ.get("MF_API_KEY", "").strip()
    if key:
        try:
            result["stations"] = fetch_mf(key)
            print(f"Météo-France : {sum(bool(s['series']) for s in result['stations'])}/{len(MF_STATIONS)} stations")
        except urllib.error.HTTPError as e:
            result["stationsNote"] = f"API Météo-France : erreur {e.code}"
            print(result["stationsNote"])
        except Exception as e:
            result["stationsNote"] = "API Météo-France injoignable"
            print(result["stationsNote"], str(e)[:200])
    else:
        result["stationsNote"] = "Clé Météo-France absente"
    ok = 0
    for b in BUOYS:
        entry = dict(b, series=[], error=None)
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
