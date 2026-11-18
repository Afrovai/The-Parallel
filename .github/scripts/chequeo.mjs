// Chequeo automático de The Parallel (corre en GitHub Actions a las 5:00 y 17:00 hora de Perth).
// 1. Lee nombres y precios de la tienda online de Square (como la ve cualquier cliente) y
//    actualiza en index.html cada precio marcado con data-sq="<nombre en Square>".
// 2. Si hay credenciales de la API de Instagram (secrets IG_USER_ID e IG_TOKEN), actualiza
//    el número de seguidores. Sin credenciales, este paso se salta.
// Nunca agrega ni borra productos: si algo no calza, lo informa para que lo decida una persona.
//   node .github/scripts/chequeo.mjs            → aplica cambios
//   node .github/scripts/chequeo.mjs --dry      → solo informa
// Escribe el resumen en chequeo-resumen.md (para el aviso) y termina.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STORE = "https://theparallelonline.square.site/";
const CATEGORIAS = ["Toast", "Cold Drinks", "Hot Drinks"];   // las que muestra el sitio
const DRY = process.argv.includes("--dry");
const FILE = "index.html";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => s.toLowerCase().replace(/&/g, " & ").replace(/\s+/g, " ").trim();

// ---------- 1. leer la tienda ----------
async function leerTienda() {
  const chrome = [process.env.CHROME_PATH, "/usr/bin/google-chrome", "/usr/bin/chromium", "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"].filter(Boolean).find(existsSync);
  if (!chrome) throw new Error("No encontré Chrome");
  const port = 9400 + Math.floor(Math.random() * 300);
  const profile = mkdtempSync(join(tmpdir(), "chequeo-"));
  const proc = spawn(chrome, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-sandbox", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
  try {
    let target;
    for (let i = 0; i < 80 && !target; i++) { try { target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json(); } catch { await sleep(250); } }
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r) => ws.addEventListener("open", r, { once: true }));
    let id = 0; const pend = new Map();
    ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
    const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    const ev = async (expression) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;
    await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await send("Page.navigate", { url: STORE });
    // esperar a que carguen los productos y recorrer la página para que aparezcan todos
    for (let i = 0; i < 60; i++) { if ((await ev(`[...document.querySelectorAll('button,[role=button],a')].filter(b => /A\\$\\s?\\d/.test(b.textContent)).length`)) >= 10) break; await sleep(500); }
    for (let i = 0; i < 25; i++) { await ev("window.scrollBy(0, 900); true"); await sleep(200); }
    await sleep(1500);
    const items = await ev(`(() => {
      const out = []; let cat = "";
      const cats = ${JSON.stringify(["Toast", "Sweet Options", "Cold Drinks", "Hot Drinks"])};
      for (const el of document.querySelectorAll("h1,h2,h3,button,[role=button]")) {
        const t = (el.textContent || "").replace(/\\s+/g, " ").trim();
        if (/^H[1-3]$/.test(el.tagName)) { if (cats.includes(t)) cat = t; continue; }
        const m = t.match(/A\\$\\s?(\\d+(?:\\.\\d{2})?)(?:\\s*-\\s*A\\$\\s?(\\d+(?:\\.\\d{2})?))?/);
        if (!m || t.length > 700) continue;
        out.push({ cat, text: t, lo: +m[1], hi: m[2] ? +m[2] : +m[1], agotado: /out of stock/i.test(t) });
      }
      return out;
    })()`);
    ws.close();
    return items;
  } finally { proc.kill(); await sleep(300); try { rmSync(profile, { recursive: true, force: true }); } catch {} }
}

// ---------- formato de precios como los muestra el sitio ----------
const money = (v, dec) => "$" + (dec === 0 ? String(Math.round(v)) : (Number.isInteger(v * 10) ? v.toFixed(1) : v.toFixed(2)));
function formato(clase, fmt, prods) {
  if (clase === "item-price") return money(prods[0].lo, Number.isInteger(prods[0].lo) ? 0 : 2);
  if (fmt === "each") return prods.map((p) => money(p.lo)).join(" / ");
  const p = prods[0];
  return p.hi !== p.lo ? `${money(p.lo)} / ${money(p.hi)}` : money(p.lo);
}

const resumen = { cambios: [], problemas: [], nuevos: [], seguidores: null };
let html = readFileSync(FILE, "utf8");
const tienda = await leerTienda();
if (tienda.length < 10) { resumen.problemas.push(`No pude leer la tienda (solo ${tienda.length} productos). No cambié nada.`); }
else {
  const usados = new Set();
  const buscar = (nombre) => tienda.find((it) => norm(it.text).startsWith(norm(nombre)));
  html = html.replace(/<div class="(item-price|c-price)" data-sq="([^"]+)"(?: data-fmt="([^"]+)")?>([^<]*)<\/div>/g, (full, clase, sq, fmt, actual) => {
    const nombres = sq.split(/[|,]/).map((s) => s.trim());
    const prods = nombres.map(buscar);
    const faltan = nombres.filter((_, i) => !prods[i]);
    if (faltan.length) { resumen.problemas.push(`En la tienda no encontré: ${faltan.join(", ")} (el sitio sigue mostrando ${actual}).`); return full; }
    prods.forEach((p) => usados.add(p.text));
    if (sq.includes(",") && new Set(prods.map((p) => p.lo + "-" + p.hi)).size > 1) {
      resumen.problemas.push(`Los productos de la fila "${nombres.join(" / ")}" ya no tienen el mismo precio en la tienda (${prods.map((p, i) => nombres[i] + " " + money(p.lo) + (p.hi !== p.lo ? "–" + money(p.hi) : "")).join(", ")}). Hay que separarlos a mano.`);
      return full;
    }
    const nuevo = formato(clase, fmt, prods);
    if (nuevo === actual.trim()) return full;
    resumen.cambios.push(`${nombres.join(" / ")}: ${actual.trim()} → ${nuevo}`);
    return full.replace(`>${actual}</div>`, `>${nuevo}</div>`);
  });
  for (const it of tienda) if (CATEGORIAS.includes(it.cat) && !usados.has(it.text)) resumen.nuevos.push(`${it.cat}: ${it.text.replace(/\s*A\$.*$/, "").slice(0, 80)} (A$${it.lo}${it.hi !== it.lo ? "–" + it.hi : ""})`);
}

// ---------- 2. seguidores de Instagram (API oficial de Meta) ----------
if (process.env.IG_USER_ID && process.env.IG_TOKEN) {
  try {
    const r = await (await fetch(`https://graph.facebook.com/v21.0/${process.env.IG_USER_ID}?fields=followers_count&access_token=${process.env.IG_TOKEN}`)).json();
    const n = r.followers_count;
    if (Number.isInteger(n) && n > 0) {
      const m = html.match(/const INSTAGRAM_FOLLOWERS = (\d+);/);
      if (m && +m[1] !== n) { html = html.replace(m[0], `const INSTAGRAM_FOLLOWERS = ${n};`); resumen.cambios.push(`Seguidores de Instagram: ${m[1]} → ${n}`); }
      resumen.seguidores = n;
    } else resumen.problemas.push("La API de Instagram no devolvió el número de seguidores (¿token vencido?).");
  } catch (e) { resumen.problemas.push("No pude consultar la API de Instagram: " + e.message); }
}

if (!DRY && resumen.cambios.length) writeFileSync(FILE, html);
const md = [
  resumen.cambios.length ? "**Actualizado en el sitio:**\n" + resumen.cambios.map((c) => "- " + c).join("\n") : "",
  resumen.problemas.length ? "**Para revisar (no cambié nada de esto):**\n" + resumen.problemas.map((c) => "- " + c).join("\n") : "",
  resumen.nuevos.length ? "**Productos de la tienda que el sitio no muestra:**\n" + resumen.nuevos.map((c) => "- " + c).join("\n") : "",
].filter(Boolean).join("\n\n");
writeFileSync("chequeo-resumen.md", md);
console.log(md || "Todo coincide.");
console.log(`\n(${tienda.length} productos leídos de la tienda${DRY ? ", modo prueba: no se escribió nada" : ""})`);
