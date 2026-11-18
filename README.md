# Quel spot à Oléron ?

Classement des spots de surf d'Oléron et de la Côte Sauvage (Chassiron, Les Huttes, port de Saint-Denis,
L'Écuissière, Côte Sauvage) selon des critères éditables, avec fiche par spot, carte de houle et de vent,
et données réelles (bouées, vent, marée).

- `index.html`, `js/` : l'application (sans serveur, sans clé)
- `spots.json` : critères des spots (source éditable : le doc « Critères des spots »)
- `scripts/fetch_obs.py` : relève des bouées Candhis, lancée toutes les 30 min par GitHub Actions
- `scripts/build_land.py` : trait de côte (OpenStreetMap) pour masquer la terre sur la carte
- `scripts/build_bathy.py` : bathymétrie EMODnet pour le modèle côtier (`js/coast.js`)
- `data/` : mesures des bouées et polygones de terre

Sources : Open-Meteo (Météo-France MFWAM et AROME HD 1,3 km, DWD EWAM, ECMWF), Candhis/Cerema,
OpenWindMap/Pioupiou, SHOM, © contributeurs OpenStreetMap.
