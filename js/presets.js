/* =====================================================================
 * presets.js
 * Photo specifications grouped by country / document type.
 *
 * Each spec describes the required physical size of an ID photo. The
 * pixel dimensions are either given explicitly (px) or derived from the
 * physical size + dpi at runtime (see specPixels() in app.js).
 *
 *   widthMM / heightMM : physical size of a single photo
 *   px                 : { w, h } explicit pixel size (overrides dpi math)
 *   dpi                : print resolution used when px is not supplied
 *   bg                 : recommended background colour (hex)
 *   head               : { minPct, maxPct } head height as % of photo height
 *                        (used to draw the face-positioning guides)
 * ===================================================================== */

const PRESETS = {
  India: [
    { name: "Passport 35 x 45 mm (630 x 810 px)", widthMM: 35, heightMM: 45, px: { w: 630, h: 810 }, dpi: 457, bg: "#ffffff", head: { minPct: 62, maxPct: 75 } },
    { name: "Passport 51 x 51 mm (2 x 2 inch)",    widthMM: 51, heightMM: 51, dpi: 300, bg: "#ffffff", head: { minPct: 50, maxPct: 69 } },
    { name: "Passport / OCI / PCC 35 x 35 mm",     widthMM: 35, heightMM: 35, dpi: 300, bg: "#ffffff", head: { minPct: 62, maxPct: 75 } },
    { name: "Driving License 35 x 45 mm",          widthMM: 35, heightMM: 45, dpi: 300, bg: "#ffffff", head: { minPct: 62, maxPct: 75 } },
    { name: "PAN Card 25 x 35 mm",                 widthMM: 25, heightMM: 35, dpi: 300, bg: "#ffffff", head: { minPct: 60, maxPct: 75 } },
    { name: "Visa 2 x 2 inch (VFS Global)",        widthMM: 51, heightMM: 51, px: { w: 600, h: 600 }, dpi: 300, bg: "#ffffff", head: { minPct: 50, maxPct: 69 } },
  ],
  "United States": [
    { name: "Passport / Visa 2 x 2 inch (600 x 600 px)", widthMM: 51, heightMM: 51, px: { w: 600, h: 600 }, dpi: 300, bg: "#ffffff", head: { minPct: 50, maxPct: 69 } },
    { name: "Green Card 2 x 2 inch",                     widthMM: 51, heightMM: 51, dpi: 300, bg: "#ffffff", head: { minPct: 50, maxPct: 69 } },
  ],
  "United Kingdom": [
    { name: "Passport 35 x 45 mm",        widthMM: 35, heightMM: 45, dpi: 300, bg: "#dfe6ee", head: { minPct: 64, maxPct: 80 } },
    { name: "Visa 35 x 45 mm",            widthMM: 35, heightMM: 45, dpi: 300, bg: "#dfe6ee", head: { minPct: 64, maxPct: 80 } },
  ],
  "Schengen / EU": [
    { name: "Visa / Passport 35 x 45 mm", widthMM: 35, heightMM: 45, dpi: 300, bg: "#dfe6ee", head: { minPct: 70, maxPct: 80 } },
  ],
  Canada: [
    { name: "Passport 50 x 70 mm",        widthMM: 50, heightMM: 70, dpi: 300, bg: "#ffffff", head: { minPct: 44, maxPct: 51 } },
    { name: "Visa / PR 35 x 45 mm",       widthMM: 35, heightMM: 45, dpi: 300, bg: "#ffffff", head: { minPct: 62, maxPct: 75 } },
  ],
  Australia: [
    { name: "Passport / Visa 35 x 45 mm", widthMM: 35, heightMM: 45, dpi: 300, bg: "#ffffff", head: { minPct: 64, maxPct: 80 } },
  ],
  China: [
    { name: "Visa 33 x 48 mm",            widthMM: 33, heightMM: 48, dpi: 300, bg: "#ffffff", head: { minPct: 60, maxPct: 72 } },
    { name: "Passport 33 x 48 mm",        widthMM: 33, heightMM: 48, dpi: 300, bg: "#ffffff", head: { minPct: 60, maxPct: 72 } },
  ],
  Custom: [
    { name: "Custom size (set below)", custom: true, widthMM: 35, heightMM: 45, dpi: 300, bg: "#ffffff", head: { minPct: 62, maxPct: 75 } },
  ],
};

/* Print sheet papers (physical size in mm). */
const PAPERS = [
  { id: "4x6",  name: '4" x 6" photo paper', widthMM: 152.4, heightMM: 101.6 },
  { id: "5x7",  name: '5" x 7" photo paper', widthMM: 177.8, heightMM: 127.0 },
  { id: "a4",   name: "A4 paper",            widthMM: 297.0, heightMM: 210.0 },
  { id: "letter", name: "US Letter",         widthMM: 279.4, heightMM: 215.9 },
];
