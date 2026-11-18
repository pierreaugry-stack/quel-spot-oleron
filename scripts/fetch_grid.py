"""Précalcule la grille de prévision de la carte (houle MFWAM + vent AROME HD) et l'écrit dans data/grid.json.

Lancé par GitHub Actions toutes les 3 heures : les visiteurs chargent ce fichier au lieu d'interroger
Open-Meteo eux-mêmes (carte instantanée, et une seule série d'appels pour tout le monde).
Même grille que js/map.js (FGRID) : 0,1° de 45,3 à 46,6 N et de 2,4 à 0,85 O.
"""
import json
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timezone

LAT = (45.3, 46.6, 0.1)
LON = (-2.4, -0.85, 0.1)
DAYS = 5
UA = "quel-spot-oleron/4 (GitHub Actions)"


def frange(a, b, s):
    out, x = [], a
    while x <= b + 1e-9:
        out.append(round(x, 3))
        x += s
    return out


def get(url, params):
    q = urllib.parse.urlencode(params)
    req = urllib.request.Request(f"{url}?{q}", headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=120) as r:
        d = json.loads(r.read().decode("utf-8"))
    return d if isinstance(d, list) else [d]


def rnd(v, n):
    return None if v is None else round(v, n)


def main(dst):
    lats, lons = frange(*LAT), frange(*LON)
    pts = [(la, lo) for la in lats for lo in lons]
    lat, lon = ",".join(str(p[0]) for p in pts), ",".join(str(p[1]) for p in pts)
    m = get("https://marine-api.open-meteo.com/v1/marine", {
        "latitude": lat, "longitude": lon, "models": "meteofrance_wave", "timezone": "Europe/Paris", "forecast_days": DAYS,
        "hourly": "swell_wave_height,swell_wave_direction,swell_wave_period,wind_wave_height"})
    w = get("https://api.open-meteo.com/v1/forecast", {
        "latitude": lat, "longitude": lon, "models": "meteofrance_arome_france_hd,meteofrance_seamless", "timezone": "Europe/Paris",
        "forecast_days": DAYS, "wind_speed_unit": "kmh", "hourly": "wind_speed_10m,wind_direction_10m"})
    times = w[0]["hourly"]["time"]
    out = {"generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "lats": lats, "lons": lons, "times": times,
           "swh": [], "swd": [], "swp": [], "wwh": [], "ws": [], "wd": []}
    for t in range(len(times)):
        row = {k: [] for k in ("swh", "swd", "swp", "wwh", "ws", "wd")}
        for i in range(len(pts)):
            mh = m[i].get("hourly", {}) if i < len(m) else {}
            wh = w[i]["hourly"]
            pick = lambda a, b: a[t] if a and a[t] is not None else (b[t] if b else None)
            row["swh"].append(rnd((mh.get("swell_wave_height") or [None] * len(times))[t], 2))
            row["swd"].append(rnd((mh.get("swell_wave_direction") or [None] * len(times))[t], 0))
            row["swp"].append(rnd((mh.get("swell_wave_period") or [None] * len(times))[t], 1))
            row["wwh"].append(rnd((mh.get("wind_wave_height") or [None] * len(times))[t], 2))
            row["ws"].append(rnd(pick(wh.get("wind_speed_10m_meteofrance_arome_france_hd"), wh.get("wind_speed_10m_meteofrance_seamless")), 1))
            row["wd"].append(rnd(pick(wh.get("wind_direction_10m_meteofrance_arome_france_hd"), wh.get("wind_direction_10m_meteofrance_seamless")), 0))
        for k, v in row.items():
            out[k].append(v)
    with open(dst, "w", encoding="utf-8") as f:
        json.dump(out, f, separators=(",", ":"))
    print(f"grille {len(lats)}x{len(lons)} sur {len(times)} h -> {dst}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "data/grid.json"))
