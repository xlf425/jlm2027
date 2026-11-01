/* Relève le nombre de soutiens de melenchon2027.fr et met à jour l'historique.

Usage : node suivi_soutiens.js   (relevé seul, ex. tâche planifiée)
        node serveur.js          (interface web, relevé à chaque ouverture)
Historique : soutiens.csv (date,soutiens) ; dates clefs : evenements.csv
Une seule valeur par jour : relancer le même jour remplace la valeur du jour.
*/
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const DIR = path.dirname(fileURLToPath(import.meta.url));
export const CSV = path.join(DIR, "soutiens.csv");
const API = "https://actionpopulaire.fr/api/soutien/count/"; // source utilisée par la classe NbSoutiens

const pad = n => String(n).padStart(2, "0");
const fmt = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
const spaced = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " ");

async function fetchCount() {
  const r = await fetch(API, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const n = Number.parseInt((await r.json()).count, 10);
  if (!Number.isFinite(n)) throw new Error("réponse inattendue de l'API");
  return n;
}

export async function load() {
  let text;
  try { text = await readFile(CSV, "utf8"); }
  catch (e) { if (e.code === "ENOENT") return []; throw e; }
  return text.split(/\r?\n/).slice(1).filter(Boolean).map(l => {
    const [date, n] = l.split(",");
    return { date, soutiens: Number.parseInt(n, 10) };
  });
}

async function save(pts) {
  const lines = ["date,soutiens", ...pts.map(p => `${p.date},${p.soutiens}`)];
  await writeFile(CSV, lines.join("\r\n") + "\r\n", "utf8");
}

export async function record() {
  const now = new Date(); now.setSeconds(0, 0);
  const n = await fetchCount();
  const date = fmt(now);
  const pts = (await load()).filter(p => p.date.slice(0, 10) !== date.slice(0, 10));
  pts.push({ date, soutiens: n });
  pts.sort((a, b) => a.date.localeCompare(b.date));
  await save(pts);
  return { date, soutiens: n };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { date, soutiens } = await record();
    console.log(`${date} : ${spaced(soutiens)} soutiens`);
  } catch (e) {
    console.error(`Relevé impossible (${e.message}) : historique inchangé.`);
    process.exitCode = 1;
  }
}
