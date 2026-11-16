// Lee el feed RSS de Substack y actualiza articulos.json para la web.
// Lo ejecuta GitHub Actions cada hora (.github/workflows/actualizar-articulos.yml).
// Sin dependencias: solo Node 20 o superior.
//
// Cómo decide el tema de cada artículo (en este orden):
//   1. Si ya está en articulos.json con un tema, se respeta (podéis corregirlo a mano).
//   2. Una etiqueta o sección de Substack con el nombre del tema.
//   3. El subtítulo empieza por el tema, por ejemplo "Geopolítica: ..." o "Economía · ...".
//   Si nada encaja, queda como "Tema libre".

import { readFile, writeFile } from "node:fs/promises";

const FEED = process.env.OTIUM_FEED || "https://otium3.substack.com/feed";
const SALIDA = new URL("../articulos.json", import.meta.url);
const TEMAS = ["Geopolítica", "Política", "Economía", "Actualidad", "Ocio"];

// Si en Substack firmáis con otro nombre, añadidlo aquí para que salga el nombre completo.
const AUTORES = {
  "adrian munoz": "Adrián Muñoz Rangil",
  "adrian munoz rangil": "Adrián Muñoz Rangil",
  "adrian portomarin": "Adrián Portomarín Castaño",
  "adrian portomarin castano": "Adrián Portomarín Castaño",
  "oscar del palacio": "Óscar del Palacio Gutiérrez",
  "oscar del palacio gutierrez": "Óscar del Palacio Gutiérrez",
};

const sinAcentos = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

function texto(xml, etiqueta) {
  const m = xml.match(new RegExp(`<${etiqueta}(?:\\s[^>]*)?>([\\s\\S]*?)</${etiqueta}>`, "i"));
  return m ? limpiar(m[1]) : "";
}
function todos(xml, etiqueta) {
  const re = new RegExp(`<${etiqueta}(?:\\s[^>]*)?>([\\s\\S]*?)</${etiqueta}>`, "gi");
  return [...xml.matchAll(re)].map((m) => limpiar(m[1]));
}
function limpiar(s) {
  return s
    .replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&amp;/g, "&")
    .trim();
}

function temaDe(categorias, subtitulo) {
  for (const c of categorias) {
    const t = TEMAS.find((x) => sinAcentos(x) === sinAcentos(c));
    if (t) return t;
  }
  const inicio = sinAcentos(subtitulo);
  return TEMAS.find((t) => new RegExp(`^${sinAcentos(t)}\\s*[:·|\\-–—]`).test(inicio)) || "";
}

function fechaIso(pubDate) {
  const d = new Date(pubDate);
  if (isNaN(d)) return "";
  // Fecha en hora de Madrid, para que un artículo de las 00:30 no salga el día anterior.
  return d.toLocaleDateString("sv-SE", { timeZone: "Europe/Madrid" });
}

function articulo({ titulo, autor, categorias, subtitulo, fecha, enlace }) {
  return {
    titulo,
    autor: AUTORES[sinAcentos(autor || "")] || autor || "Otium",
    tema: temaDe(categorias, subtitulo),
    fecha: fechaIso(fecha),
    enlace: (enlace || "").split("?")[0],
    subtitulo,
  };
}

const NAVEGADOR = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36",
  "Accept": "application/rss+xml, application/xml, text/xml, */*",
  "Accept-Language": "es-ES,es;q=0.9",
};

// Fuente 1: el feed RSS directo de Substack.
async function desdeFeed() {
  const res = await fetch(FEED, { headers: NAVEGADOR });
  if (!res.ok) throw new Error(`feed de Substack: ${res.status}`);
  const xml = await res.text();
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].map(([, item]) => articulo({
    titulo: texto(item, "title"),
    autor: texto(item, "dc:creator"),
    categorias: todos(item, "category"),
    subtitulo: texto(item, "description"),
    fecha: texto(item, "pubDate"),
    enlace: texto(item, "link"),
  }));
}

// Fuente 2: la API pública del archivo de Substack.
async function desdeArchivo() {
  const base = new URL(FEED).origin;
  const res = await fetch(`${base}/api/v1/archive?sort=new&limit=50`, { headers: { ...NAVEGADOR, Accept: "application/json" } });
  if (!res.ok) throw new Error(`archivo de Substack: ${res.status}`);
  return (await res.json()).map((p) => articulo({
    titulo: p.title,
    autor: (p.publishedBylines || [])[0]?.name,
    categorias: [p.section_name, ...(p.postTags || []).map((t) => t.name)].filter(Boolean),
    subtitulo: p.subtitle || p.description || "",
    fecha: p.post_date,
    enlace: p.canonical_url,
  }));
}

// Fuente 3: rss2json, un servicio gratuito que lee el feed desde otros servidores.
async function desdeRss2json() {
  const res = await fetch(`https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(FEED)}`);
  const datos = await res.json();
  if (datos.status !== "ok") throw new Error(`rss2json: ${datos.message || res.status}`);
  return datos.items.map((i) => articulo({
    titulo: limpiar(i.title || ""),
    autor: i.author,
    categorias: i.categories || [],
    subtitulo: limpiar(i.description || "").slice(0, 300),
    fecha: (i.pubDate || "").replace(" ", "T") + "Z",
    enlace: i.link,
  }));
}

async function main() {
  let nuevos = null;
  for (const fuente of [desdeFeed, desdeArchivo, desdeRss2json]) {
    try {
      nuevos = (await fuente()).filter((a) => a.titulo && a.enlace);
      console.log(`Leído con ${fuente.name}: ${nuevos.length} artículos.`);
      break;
    } catch (e) {
      console.log(`No se pudo con ${fuente.name} (${e.message}).`);
    }
  }
  if (!nuevos) throw new Error("Ninguna fuente respondió. Se mantiene la lista actual.");

  let actuales = [];
  try { actuales = JSON.parse(await readFile(SALIDA, "utf8")); } catch { /* primera vez */ }

  // El feed solo trae los últimos artículos: se conservan los antiguos y se actualizan los que vuelven a aparecer.
  const porEnlace = new Map(actuales.map((a) => [a.enlace, a]));
  for (const a of nuevos) {
    const previo = porEnlace.get(a.enlace);
    porEnlace.set(a.enlace, previo ? { ...a, tema: previo.tema || a.tema } : a);
  }
  const lista = [...porEnlace.values()].sort((a, b) => b.fecha.localeCompare(a.fecha));

  const json = JSON.stringify(lista, null, 2) + "\n";
  const antes = actuales.length ? JSON.stringify(actuales, null, 2) + "\n" : "";
  if (json === antes) { console.log("Sin cambios."); return; }
  await writeFile(SALIDA, json);
  console.log(`articulos.json actualizado: ${lista.length} artículos (${nuevos.length} en el feed).`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
