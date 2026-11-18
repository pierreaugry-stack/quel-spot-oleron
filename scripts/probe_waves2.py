"""Exploration (2) : échéances disponibles et contenu d'un fichier pour WW3-WARP, WW3-MARO et MFWAM 0.025.
Vérifie l'emprise (couvre-t-elle Oléron ?), les variables et la valeur près de Chassiron."""
import json
import os
import sys
import urllib.error
import urllib.request

BASE = "https://public-api.meteofrance.fr/previnum/DPPaquetWAVESMODELS/v1"
KEY = os.environ.get("MF_API_KEY", "").strip()
CASES = [("WW3-WARP", "0.01", "productWWARP", "nc"), ("WW3-MARO", "0.01", "productWMARO", "nc"), ("MFWAM", "0.025", "productMFWAM", "grib2")]


def get(path, raw=False):
    req = urllib.request.Request(BASE + path, headers={"apikey": KEY, "accept": "*/*", "User-Agent": "quel-spot-oleron/probe"})
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            b = r.read()
            return b if raw else json.loads(b.decode("utf-8"))
    except urllib.error.HTTPError as e:
        return {"_error": e.code, "_body": e.read()[:300].decode("utf-8", "replace").replace(KEY, "***")}


def main():
    for model, grid, prod, fmt in CASES:
        print(f"\n===== {model} {grid} =====")
        pk = get(f"/models/{model}/grids/{grid}/packages/SP1")
        refs = [l["href"].split("referencetime=")[-1] for l in pk.get("links", []) if "referencetime=" in l.get("href", "")]
        print("réseaux :", refs[-4:])
        if not refs:
            print(json.dumps(pk)[:500]); continue
        ref = refs[-1]
        d = get(f"/models/{model}/grids/{grid}/packages/SP1?referencetime={ref}")
        txt = json.dumps(d, ensure_ascii=False)
        print("description réseau :", txt[:600])
        times = sorted(set(l["href"].split("time=")[-1].split("&")[0] for l in d.get("links", []) if "time=" in l.get("href", "")))
        print(f"{len(times)} échéances :", times[:3], "…", times[-3:])
        if not times:
            # certains documents listent les échéances autrement
            print(txt[600:2500]); continue
        t = "000H999H" if "000H999H" in times else times[min(6, len(times) - 1)]
        b = get(f"/{prod}?grid={grid}&package=SP1&referencetime={ref}&time={t}&format={fmt}", raw=True)
        if isinstance(b, dict):
            print("téléchargement :", b); continue
        fn = f"/tmp/{model}.{fmt}"
        open(fn, "wb").write(b)
        print(f"fichier {t} : {len(b) / 1e6:.1f} Mo")
        try:
            if fmt == "nc":
                import netCDF4
                ds = netCDF4.Dataset(fn)
                print("dimensions :", {k: len(v) for k, v in ds.dimensions.items()})
                print("variables :", {k: (v.dimensions, getattr(v, "long_name", "")[:40]) for k, v in ds.variables.items()})
                la = ds.variables.get("latitude") or ds.variables.get("lat"); lo = ds.variables.get("longitude") or ds.variables.get("lon")
                tv = ds.variables.get("time")
                if tv is not None:
                    print("temps :", len(tv), getattr(tv, "units", ""), float(tv[0]), float(tv[-1]))
                if la is not None:
                    import numpy as np
                    lat_a, lon_a = la[:], lo[:]
                    sw = ds.variables.get("SWH") or ds.variables.get("swh") or ds.variables.get("hs")
                    if sw is not None and lat_a.ndim == 1:
                        i = int(np.abs(lat_a - 46.08).argmin()); j = int(np.abs(lon_a + 1.46).argmin())
                        print("Hs près de Chassiron :", sw.dimensions, float(sw[6, i, j]) if sw.ndim == 3 else "?")
                    print("emprise lat", float(la[:].min()), float(la[:].max()), "lon", float(lo[:].min()), float(lo[:].max()), "pas", float(la[1] - la[0]))
            else:
                import cfgrib
                for dsx in cfgrib.open_datasets(fn):
                    print("jeu :", {k: (v.dims, v.attrs.get("long_name", "")[:40]) for k, v in dsx.data_vars.items()})
                    if "swh" in dsx:
                        print("Hs près de Chassiron :", float(dsx["swh"].sel(latitude=46.08, longitude=-1.46, method="nearest")))
        except Exception as e:
            print("lecture impossible :", repr(e)[:300])
    return 0


if __name__ == "__main__":
    sys.exit(main())
