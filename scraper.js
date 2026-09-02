import { chromium } from "playwright";
import fs from "node:fs";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function radiusToZoom(radiusMeters) {
  if (radiusMeters <= 300) return 17;
  if (radiusMeters <= 600) return 16;
  if (radiusMeters <= 1200) return 15;
  if (radiusMeters <= 2500) return 14;
  if (radiusMeters <= 5000) return 13;
  if (radiusMeters <= 10000) return 12;
  if (radiusMeters <= 20000) return 11;
  if (radiusMeters <= 40000) return 10;
  return 9;
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function normalizePhoneID(raw) {
  if (!raw) return null;
  let digits = raw.replace(/\D/g, "");
  if (!digits) return null;
  if (digits.startsWith("0")) digits = "62" + digits.slice(1);
  else if (!digits.startsWith("62")) digits = "62" + digits;
  return digits;
}

function csvEscape(v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function toCSV(rows, headers) {
  const lines = [headers.join(",")];
  for (const r of rows) {
    lines.push(headers.map((h) => csvEscape(r[h])).join(","));
  }
  return lines.join("\n");
}

async function collectPlaceLinks(page, targetCount) {
  const seen = new Set();
  let stagnant = 0;
  while (seen.size < targetCount && stagnant < 6) {
    const hrefs = await page
      .$$eval('a[href*="/maps/place/"]', (as) => as.map((a) => a.href))
      .catch(() => []);
    const before = seen.size;
    hrefs.forEach((h) => seen.add(h));
    if (seen.size === before) stagnant++;
    else stagnant = 0;

    await page.evaluate(() => {
      const feed = document.querySelector('div[role="feed"]');
      if (feed) feed.scrollTop = feed.scrollHeight;
      else window.scrollBy(0, 2000);
    });
    await page.waitForTimeout(1400);
  }
  return [...seen];
}

const clean = (s) =>
  (s || "")
    .replace(/\s*\n\s*/g, " ")
    .replace(/^[^\p{L}\p{N}+]+/u, "")
    .trim();

async function extractDetail(page) {
  const name = clean(
    await page
      .locator("h1")
      .first()
      .innerText()
      .catch(() => "")
  );

  const address = clean(
    await page
      .locator('button[data-item-id="address"]')
      .first()
      .innerText()
      .catch(() => "")
  );

  let phone = "";
  const phoneBtn = page.locator('button[data-item-id^="phone:tel:"]').first();
  if (await phoneBtn.count()) {
    phone = clean(await phoneBtn.innerText().catch(() => ""));
  }

  let website = null;
  const siteEl = page.locator('a[data-item-id="authority"]').first();
  if (await siteEl.count()) {
    website = await siteEl.getAttribute("href").catch(() => null);
  }

  let rating = "";
  let reviewCount = "";
  const ratingEl = page
    .locator('span[role="img"][aria-label*="bintang"], span[role="img"][aria-label*="star"]')
    .first();
  if (await ratingEl.count()) {
    const label = (await ratingEl.getAttribute("aria-label")) || "";
    const m1 = label.match(/([\d.,]+)\s*(bintang|star)/i);
    const m2 = label.match(/([\d.,]+)\s*(ulasan|review)/i);
    if (m1) rating = m1[1];
    if (m2) reviewCount = m2[1];
  }

  const url = page.url();
  let lat = null;
  let lng = null;
  const m = url.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
  if (m) {
    lat = parseFloat(m[1]);
    lng = parseFloat(m[2]);
  } else {
    const m2 = url.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
    if (m2) {
      lat = parseFloat(m2[1]);
      lng = parseFloat(m2[2]);
    }
  }

  return { name, address, phone, website, rating, reviewCount, lat, lng, mapsUrl: url };
}

async function checkWhatsapp(context, phoneIntl) {
  const p = await context.newPage();
  try {
    await p.goto(`https://wa.me/${phoneIntl}`, {
      waitUntil: "domcontentloaded",
      timeout: 15000,
    });
    await p.waitForTimeout(1200);
    const text = await p.locator("body").innerText().catch(() => "");
    const invalid = /tidak valid|invalid|not.*found/i.test(text);
    return invalid ? "Tidak" : "Kemungkinan Ya";
  } catch {
    return "Tidak diketahui";
  } finally {
    await p.close();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.query || !args.lat || !args.lng) {
    console.log(
      "Pakai: node scraper.js --query \"warung makan\" --lat -6.200000 --lng 106.816666 --radius 2000 --limit 30 --output hasil.csv [--check-wa] [--no-headless]"
    );
    process.exit(1);
  }

  const query = args.query;
  const centerLat = parseFloat(args.lat);
  const centerLng = parseFloat(args.lng);
  const radius = args.radius ? parseFloat(args.radius) : 3000;
  const limit = args.limit ? parseInt(args.limit, 10) : 30;
  const output = args.output || "hasil.csv";
  const checkWA = !!args["check-wa"];
  const headless = !args["no-headless"];

  const zoom = radiusToZoom(radius);
  const searchUrl = `https://www.google.com/maps/search/${encodeURIComponent(
    query
  )}/@${centerLat},${centerLng},${zoom}z?hl=id`;

  console.log(`Buka pencarian: ${searchUrl}`);

  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({ locale: "id-ID" });
  const page = await context.newPage();

  await page.goto(searchUrl, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('div[role="feed"]', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1500);

  const links = await collectPlaceLinks(page, limit * 4);
  console.log(`Kandidat ditemukan: ${links.length}`);

  const results = [];
  for (const href of links) {
    if (results.length >= limit) break;
    try {
      await page.goto(href, { waitUntil: "domcontentloaded", timeout: 20000 });
      await page.waitForTimeout(900);
      const d = await extractDetail(page);

      if (d.lat != null && d.lng != null) {
        const dist = haversineMeters(centerLat, centerLng, d.lat, d.lng);
        if (dist > radius) continue;
        d.distanceMeters = Math.round(dist);
      } else {
        d.distanceMeters = "";
      }

      if (!d.name) continue;

      let waLink = "";
      let waStatus = "";
      const phoneIntl = normalizePhoneID(d.phone);
      if (phoneIntl) {
        waLink = `https://wa.me/${phoneIntl}`;
        if (checkWA) {
          waStatus = await checkWhatsapp(context, phoneIntl);
          await page.waitForTimeout(500);
        }
      }

      results.push({
        Nama: d.name,
        Alamat: d.address,
        Telepon: d.phone,
        "Link WhatsApp": waLink,
        "Status WA": waStatus,
        "Punya Website": d.website ? "Ya" : "Tidak",
        Website: d.website || "",
        Rating: d.rating,
        Ulasan: d.reviewCount,
        "Jarak (m)": d.distanceMeters,
        Latitude: d.lat,
        Longitude: d.lng,
        "Link Maps": d.mapsUrl,
      });

      console.log(`[${results.length}/${limit}] ${d.name}`);
    } catch (e) {
      console.log(`Lewati (error): ${href} -> ${e.message}`);
    }
  }

  await browser.close();

  const headers = [
    "Nama",
    "Alamat",
    "Telepon",
    "Link WhatsApp",
    "Status WA",
    "Punya Website",
    "Website",
    "Rating",
    "Ulasan",
    "Jarak (m)",
    "Latitude",
    "Longitude",
    "Link Maps",
  ];
  fs.writeFileSync(output, toCSV(results, headers), "utf8");
  console.log(`Selesai. ${results.length} usaha disimpan ke ${output}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
