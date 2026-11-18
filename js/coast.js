"use strict";
/* Modèle côtier simplifié (grille 0,01° ≈ 1 km) qui transforme la houle du large (Météo-France MFWAM)
   en vagues près des côtes, à la manière des modèles « nearshore » :
   1. Ombre des îles : pour chaque point et chaque direction (24 secteurs de 15°), on lance un rayon vers
      le large ; s'il touche la terre (Ré, Oléron, Aix, continent), cette part de la houle est bloquée.
      L'étalement directionnel est en cos^2s, plus étroit pour les houles longues (s croît avec la période).
   2. Frottement sur les fonds traversés : exp(-L<12m / 12 km - L12-30m × f(T) / 40 km), f croissant avec la période.
   3. Levée (shoaling) et réfraction sur la bathymétrie EMODnet (théorie linéaire, loi de Snell).
   4. Déferlement : Hs limité à 0,55 × profondeur, profondeur = fond + niveau de marée.
   5. Mer du vent locale : croissance limitée par le fetch (SPM / JONSWAP), fetch = distance à la côte
      dans la direction du vent ; plafonnée par la mer du vent du large.
   6. Diffraction approchée : lissage du coefficient d'ombre sur les cellules voisines. */

const CM = { ready: false, LAT: 3.0, X0: -2.0, Y0: 45.3, X1: -0.85, Y1: 46.6, d: 0.01, NB: 24, RMAX: 60, STEP: 0.5 };
const G0 = 9.81;

function decodeBathy(b) {
  const bin = atob(b.depth), u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return { ...b, v: new Int16Array(u.buffer) };
}
/* masque terre par rastérisation des polygones OSM sur la grille du modèle */
function rasterLand(land, nx, ny) {
  const cv = document.createElement("canvas"); cv.width = nx; cv.height = ny;
  const c = cv.getContext("2d"); c.fillStyle = "#000"; c.beginPath();
  land.forEach(r => r.forEach(([lo, la], i) => { const x = (lo - CM.X0) / CM.d, y = ny - (la - CM.Y0) / CM.d; i ? c.lineTo(x, y) : c.moveTo(x, y); }));
  c.fill("evenodd");
  const a = c.getImageData(0, 0, nx, ny).data, m = new Uint8Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) m[j * nx + i] = a[((ny - 1 - j) * nx + i) * 4 + 3] > 127 ? 1 : 0;
  return m;
}
function buildCoast(land, bathyRaw) {
  const t0 = performance.now();
  const B = decodeBathy(bathyRaw);
  const nx = Math.round((CM.X1 - CM.X0) / CM.d), ny = Math.round((CM.Y1 - CM.Y0) / CM.d), n = nx * ny;
  Object.assign(CM, { nx, ny, n });
  CM.land = rasterLand(land, nx, ny);
  // profondeur moyenne (m, sous le niveau moyen) ; estran non renseigné = 0,3 m
  CM.depth = new Float32Array(n);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const k = j * nx + i; if (CM.land[k]) continue;
    const lon = CM.X0 + (i + 0.5) * CM.d, lat = CM.Y0 + (j + 0.5) * CM.d;
    let s = 0, c = 0;
    for (const [ox, oy] of [[-0.25, -0.25], [0.25, -0.25], [-0.25, 0.25], [0.25, 0.25]]) {
      const bi = Math.floor((lon + ox * CM.d - B.x0) / B.dx + 0.5), bj = Math.floor((lat + oy * CM.d - B.y0) / B.dy + 0.5);
      if (bi < 0 || bj < 0 || bi >= B.nx || bj >= B.ny) continue;
      const v = B.v[bj * B.nx + bi]; if (v !== B.land) { s += v / 10; c++; }
    }
    CM.depth[k] = c ? Math.max(0.3, s / c) : 0.3;
  }
  // direction du large (vers où le fond augmente), en degrés « d'où »
  CM.off = new Float32Array(n).fill(NaN);
  for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
    const k = j * nx + i; if (CM.land[k]) continue;
    const D = (a, b) => CM.land[(j + b) * nx + i + a] ? 0 : CM.depth[(j + b) * nx + i + a];
    const gx = (D(1, 0) - D(-1, 0)) / Math.cos((CM.Y0 + j * CM.d) * Math.PI / 180), gy = D(0, 1) - D(0, -1);
    if (Math.hypot(gx, gy) > 0.3) CM.off[k] = (Math.atan2(gx, gy) * 180 / Math.PI + 360) % 360;
  }
  // rayons : ouverture, fetch et longueur de petits fonds par secteur
  const NB = CM.NB; CM.open = new Uint8Array(n * NB); CM.fetch = new Float32Array(n * NB); CM.shal = new Float32Array(n * NB); CM.mid = new Float32Array(n * NB);
  for (let j = 0; j < ny; j++) {
    const lat0 = CM.Y0 + (j + 0.5) * CM.d, kx = 1 / (111.32 * Math.cos(lat0 * Math.PI / 180));
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i; if (CM.land[k]) continue;
      const lon0 = CM.X0 + (i + 0.5) * CM.d;
      for (let b = 0; b < NB; b++) {
        const a = b * 360 / NB * Math.PI / 180, dla = Math.cos(a) * CM.STEP / 111.32, dlo = Math.sin(a) * CM.STEP * kx;
        let la = lat0, lo = lon0, dist = 0, shal = 0, mid = 0, open = 1;
        while (dist < CM.RMAX) {
          la += dla; lo += dlo; dist += CM.STEP;
          if (lo < CM.X0) break;                                    // large à l'ouest
          if (lo > CM.X1 || la < CM.Y0 || la > CM.Y1) { open = lo < -1.6 ? 1 : 0; break; } // bord : continent à l'est
          const ii = Math.floor((lo - CM.X0) / CM.d), jj = Math.floor((la - CM.Y0) / CM.d), kk = jj * nx + ii;
          if (CM.land[kk]) { open = 0; break; }
          const dk = CM.depth[kk] + CM.LAT; if (dk < 12) shal += CM.STEP; else if (dk < 30) mid += CM.STEP;
        }
        const o = k * NB + b; CM.open[o] = open; CM.fetch[o] = open ? 200 : dist; CM.shal[o] = shal; CM.mid[o] = mid;
      }
    }
  }
  CM.ready = true;
  CM.buildMs = Math.round(performance.now() - t0);
}

/* nombre d'onde (approximation explicite de Fenton & McKee) et vitesse de groupe */
function cgRatio(T, h) {
  const w = 2 * Math.PI / T, k0 = w * w / G0, kh0 = k0 * h;
  const kh = kh0 * Math.pow(1 / Math.tanh(Math.pow(kh0, 0.75)), 2 / 3);
  const k = kh / h, c = w / k, n = 0.5 * (1 + 2 * kh / Math.sinh(2 * kh));
  return { cg: n * c, c, c0: G0 * T / (2 * Math.PI) };
}
/* champ côtier pour une heure : entrées = grille Météo-France (0,1°) interpolée + vent + marée */
function coastalField(src, tideLevel) {
  const { nx, ny, n, NB } = CM;
  const Hs = new Float32Array(n).fill(NaN), Tp = new Float32Array(n).fill(NaN), En = new Float32Array(n).fill(NaN), Kd = new Float32Array(n);
  for (let j = 0; j < ny; j++) {
    const lat = CM.Y0 + (j + 0.5) * CM.d, kx = 1 / (111.32 * Math.cos(lat * Math.PI / 180));
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i; if (CM.land[k]) continue;
      const lon = CM.X0 + (i + 0.5) * CM.d;
      const dirC = src.at("swd", lat, lon); if (dirC == null) continue;
      // houle de référence prise 25 km au large, dans la direction d'où elle vient
      const a = dirC * Math.PI / 180, rla = lat + Math.cos(a) * 25 / 111.32, rlo = lon + Math.sin(a) * 25 * kx;
      const H0 = src.at("swh", rla, rlo) ?? src.at("swh", lat, lon), T0 = src.at("swp", rla, rlo) ?? 10, th = src.at("swd", rla, rlo) ?? dirC;
      // étalement directionnel et ombre
      const s = clamp(2 + (T0 - 6) * 1.5, 2, 20), feel = clamp((T0 - 7) / 6, 0, 1); // une houle longue « sent » des fonds plus profonds
      let num = 0, den = 0;
      for (let b = 0; b < NB; b++) {
        const dd = angDiff(b * 360 / NB, th); if (dd > 80) continue;
        const w = Math.pow(Math.cos(dd * Math.PI / 360), 2 * s);
        den += w; num += w * CM.open[k * NB + b] * Math.exp(-CM.shal[k * NB + b] / 12 - CM.mid[k * NB + b] * feel / 40);
      }
      Kd[k] = den ? num / den : 0;
    }
  }
  // diffraction approchée : deux lissages du coefficient d'ombre sur la mer
  for (let pass = 0; pass < 2; pass++) {
    const K2 = Kd.slice();
    for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
      const k = j * nx + i; if (CM.land[k]) continue;
      let s = Kd[k] * 2, c = 2;
      for (const o of [1, -1, nx, -nx]) if (!CM.land[k + o]) { s += Kd[k + o]; c++; }
      K2[k] = s / c;
    }
    Kd.set(K2);
  }
  for (let j = 0; j < ny; j++) {
    const lat = CM.Y0 + (j + 0.5) * CM.d, kx = 1 / (111.32 * Math.cos(lat * Math.PI / 180));
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i; if (CM.land[k]) continue;
      const lon = CM.X0 + (i + 0.5) * CM.d;
      const h = CM.depth[k] + CM.LAT + tideLevel; if (h < 0.15) { Hs[k] = 0; Tp[k] = NaN; En[k] = 0; continue; }
      const dirC = src.at("swd", lat, lon); if (dirC == null) continue;
      const a = dirC * Math.PI / 180, rla = lat + Math.cos(a) * 25 / 111.32, rlo = lon + Math.sin(a) * 25 * kx;
      const H0 = src.at("swh", rla, rlo) ?? 0, T0 = src.at("swp", rla, rlo) ?? 10, th = src.at("swd", rla, rlo) ?? dirC;
      // levée + réfraction
      const r = cgRatio(T0, Math.max(0.3, h)), ks = Math.sqrt((r.c0 / 2) / r.cg);
      let kr = 1;
      if (!isNaN(CM.off[k])) { const t0 = angDiff(th, CM.off[k]) * Math.PI / 180; if (t0 < Math.PI / 2 * 0.97) { const st = Math.sin(t0) * r.c / r.c0; kr = Math.sqrt(Math.cos(t0) / Math.sqrt(Math.max(1e-3, 1 - st * st))); } }
      let hsw = H0 * Math.sqrt(Kd[k]) * clamp(ks, 0.8, 1.6) * clamp(kr, 0.4, 1.1);
      // mer du vent locale limitée par le fetch
      const U = (src.at("ws", lat, lon) ?? 0) / 3.6, ud = src.at("wd", lat, lon);
      let hww = 0, tww = NaN;
      if (U > 1 && ud != null) {
        const b = Math.round(ud / (360 / CM.NB)) % CM.NB, F = CM.fetch[k * CM.NB + b] * 1000;
        hww = Math.min(0.0016 * U * Math.sqrt(F / G0), 0.243 * U * U / G0);
        const off = src.at("wwh", rla, rlo); if (off != null) hww = Math.min(hww, Math.max(off, 0.05));
        tww = Math.max(2, 3.86 * Math.sqrt(hww));
      }
      let H = Math.sqrt(hsw * hsw + hww * hww);
      H = Math.min(H, 0.55 * h);
      const T = hsw >= hww ? T0 : tww;
      Hs[k] = H; Tp[k] = T; En[k] = 0.49 * H * H * (T || 0);
    }
  }
  // lissage léger du résultat (évite l'effet « pixels » de la grille de 1 km)
  for (const A of [Hs, En]) {
    const B = A.slice();
    for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
      const k = j * nx + i; if (CM.land[k] || isNaN(A[k])) continue;
      let sm = A[k] * 4, c = 4;
      for (const o of [1, -1, nx, -nx, nx + 1, nx - 1, -nx + 1, -nx - 1]) if (!CM.land[k + o] && !isNaN(A[k + o])) { sm += A[k + o]; c++; }
      B[k] = sm / c;
    }
    A.set(B);
  }
  return { Hs, Tp, En, Kd };
}
/* lecture bilinéaire d'un champ du modèle (cases terre ignorées) */
function coastSample(arrv, lat, lon) {
  const fx = (lon - CM.X0) / CM.d - 0.5, fy = (lat - CM.Y0) / CM.d - 0.5;
  const i0 = Math.floor(fx), j0 = Math.floor(fy), tx = fx - i0, ty = fy - j0;
  let s = 0, w = 0;
  for (const [di, dj, ww] of [[0, 0, (1 - tx) * (1 - ty)], [1, 0, tx * (1 - ty)], [0, 1, (1 - tx) * ty], [1, 1, tx * ty]]) {
    const i = i0 + di, j = j0 + dj; if (i < 0 || j < 0 || i >= CM.nx || j >= CM.ny) continue;
    const v = arrv[j * CM.nx + i]; if (CM.land[j * CM.nx + i] || isNaN(v)) continue;
    s += v * ww; w += ww;
  }
  return w > 0.05 ? s / w : null;
}
/* niveau de marée estimé (m par rapport au niveau moyen) à partir de la marée normalisée et du coefficient */
function tideLevelAt(t) {
  const tt = S.tide?.map.get(t); if (!tt || tt.n == null) return 0;
  const range = 2 + 3.5 * clamp(((tt.coef ?? 70) - 35) / 75, 0, 1);
  return (tt.n - 0.5) * range;
}
