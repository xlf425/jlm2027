/* Serveur local de l'interface (aucune dépendance, Node 18+).

Usage : node serveur.js   puis ouvrir http://localhost:8000
  POST /api/releve          relève le compteur et met à jour soutiens.csv
  GET  /data/soutiens.csv   historique des relevés
  GET  /data/evenements.csv dates clefs (date_debut,date_fin,titre,lien,illustration)
  GET  /*                   fichiers de public/
L'API actionpopulaire.fr n'autorise pas les appels depuis un navigateur (pas de CORS) :
le relevé passe donc par ce serveur.
*/
import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { CSV, record } from "./suivi_soutiens.js";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(DIR, "public");
const PORT = Number(process.env.PORT) || 8000;
const DATA = { "/data/soutiens.csv": CSV, "/data/evenements.csv": path.join(DIR, "evenements.csv") };
const TYPES = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".csv": "text/csv; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
};

let pending = null; // un seul relevé à la fois : deux onglets ne doivent pas écrire le CSV en même temps
const recordOnce = () => (pending ??= record().finally(() => { pending = null; }));

function send(res, code, body, type = "text/plain; charset=utf-8") {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-cache" });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, "http://localhost");
    if (pathname === "/api/releve") {
      if (req.method !== "POST") return send(res, 405, "POST attendu");
      try {
        const r = await recordOnce();
        console.log(`${r.date} : ${r.soutiens} soutiens`);
        return send(res, 200, JSON.stringify(r), TYPES[".json"]);
      } catch (e) {
        console.error(`Relevé impossible (${e.message})`);
        return send(res, 502, JSON.stringify({ erreur: e.message }), TYPES[".json"]);
      }
    }
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "Méthode non autorisée");
    let file = DATA[pathname];
    if (!file) {
      file = path.join(PUBLIC, decodeURIComponent(pathname === "/" ? "/index.html" : pathname));
      if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, "Interdit");
    }
    send(res, 200, await readFile(file), TYPES[path.extname(file).toLowerCase()] || "application/octet-stream");
  } catch (e) {
    if (e.code === "ENOENT" || e.code === "EISDIR") return send(res, 404, "Introuvable");
    console.error(e);
    send(res, 500, "Erreur serveur");
  }
});

server.listen(PORT, () => console.log(`Interface : http://localhost:${PORT}`));
