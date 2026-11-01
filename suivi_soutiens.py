"""Relève le nombre de soutiens de melenchon2027.fr et met à jour le graphique.

Usage : python suivi_soutiens.py
Historique : soutiens.csv (date,soutiens) ; graphique : soutiens.png
Une seule valeur par jour : relancer le même jour remplace la valeur du jour.
"""
import csv, json, sys, urllib.request, datetime as dt
from pathlib import Path
import matplotlib; matplotlib.use("Agg")
import matplotlib.pyplot as plt, matplotlib.dates as md
from matplotlib.ticker import FuncFormatter

DIR = Path(__file__).parent
CSV = DIR / "soutiens.csv"
PNG = DIR / "soutiens.png"
URL = "https://actionpopulaire.fr/api/soutien/count/"  # source utilisée par la classe NbSoutiens
FMT = "%Y-%m-%d %H:%M"

def fetch():
    req = urllib.request.Request(URL, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return int(json.load(r)["count"])

def load():
    if not CSV.exists():
        return []
    with CSV.open(encoding="utf-8") as f:
        return [(dt.datetime.strptime(r["date"], FMT), int(r["soutiens"])) for r in csv.DictReader(f)]

def save(pts):
    with CSV.open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f); w.writerow(["date", "soutiens"])
        for d, n in pts: w.writerow([d.strftime(FMT), n])

def plot(pts):
    fig, ax = plt.subplots(figsize=(10, 5.5))
    ax.plot(*zip(*pts), marker="o", ms=3.5, color="#c9462c")
    ax.set_xlabel("Date"); ax.set_ylabel("Nombre de soutiens (NbSoutiens)")
    ax.set_title("melenchon2027.fr – soutiens")
    ax.xaxis.set_major_locator(md.AutoDateLocator()); ax.xaxis.set_major_formatter(md.DateFormatter("%d/%m/%Y"))
    ax.yaxis.set_major_formatter(FuncFormatter(lambda v, _: f"{int(v):,}".replace(",", " ")))
    ax.grid(alpha=.3); fig.autofmt_xdate(); fig.tight_layout(); fig.savefig(PNG, dpi=130)

def main():
    pts = load()
    try:
        now = dt.datetime.now().replace(second=0, microsecond=0)
        n = fetch()
        pts = [p for p in pts if p[0].date() != now.date()] + [(now, n)]
        pts.sort()
        save(pts)
        print(f"{now:{FMT}} : {n:,} soutiens".replace(",", " "))
    except Exception as e:
        print(f"Relevé impossible ({e}) : graphique régénéré avec l'historique existant.", file=sys.stderr)
    if pts:
        plot(pts); print(f"Graphique mis à jour : {PNG}")

if __name__ == "__main__":
    main()
