// Job description PDF on the Nimbl.ai letterhead.
// Recreates the "Nimbl.ai Letterhead" design canvas (A4, 794 x 1123 CSS px) with pdf-lib, so the
// PDF has real, selectable text. Layout is written in CSS px from the top-left like the design,
// and converted to PDF points (0.75 pt per px, origin bottom-left) by the helpers below.
const fs = require("fs");
const path = require("path");
const { PDFDocument, rgb, setCharacterSpacing, LineCapStyle } = require("pdf-lib");
const fontkit = require("@pdf-lib/fontkit");

const PX = 0.75;
const W = 794, H = 1123;
const FONT_DIR = path.join(__dirname, "..", "assets", "fonts");
const fontBytes = {
  regular: fs.readFileSync(path.join(FONT_DIR, "manrope-latin-400-normal.woff")),
  bold: fs.readFileSync(path.join(FONT_DIR, "manrope-latin-800-normal.woff")),
};

function hex(h) {
  const n = parseInt(h.replace("#", ""), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}
const C = {
  band: hex("#b6b0a7"), navy: hex("#1a2740"), accent: hex("#ec6035"), rust: hex("#ba6241"),
  ink: hex("#1a2740"), body: hex("#2c3547"), soft: hex("#4a5262"), rule: hex("#d5d9e0"), white: rgb(1, 1, 1),
};

// Content box from the design: left 77, width 640, from y 152 down to just above the footer rule.
const BOX = { x: 77, w: 640, top: 152, bottom: 1000 };

// Characters the latin subset of Manrope can't draw are swapped for close equivalents.
function clean(s) {
  return String(s == null ? "" : s)
    .replace(/[‘’‛]/g, "'").replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-").replace(/…/g, "...").replace(/•/g, "-")
    .replace(/ /g, " ").replace(/[\t\r]/g, " ")
    .replace(/[^\x0A\x20-\x7E¡-ÿ€]/g, "");
}

class Writer {
  constructor(doc, fonts, opts) {
    this.doc = doc; this.f = fonts; this.opts = opts;
    this.page = null; this.y = 0; this.pageNo = 0;
  }

  // ---- low-level drawing in design px ----
  rect(x, y, w, h, color, page) {
    (page || this.page).drawRectangle({ x: x * PX, y: (H - y - h) * PX, width: w * PX, height: h * PX, color });
  }
  roundRect(x, y, w, h, r, color, page) {
    const p = `M${r},0 H${w - r} A${r},${r} 0 0 1 ${w},${r} V${h - r} A${r},${r} 0 0 1 ${w - r},${h} H${r} A${r},${r} 0 0 1 0,${h - r} V${r} A${r},${r} 0 0 1 ${r},0 Z`;
    this.svg(p, x, y, 1, { color }, page);
  }
  // Draws an SVG path given in its own units, placed at (x, y) px with a scale.
  svg(d, x, y, scale, style, page) {
    (page || this.page).drawSvgPath(d, {
      x: x * PX, y: (H - y) * PX, scale: scale * PX,
      color: style.color, borderColor: style.stroke, borderWidth: style.strokeWidth ? style.strokeWidth : undefined,
      borderLineCap: LineCapStyle.Round,
    });
  }
  textWidth(t, font, size, ls) { return font.widthOfTextAtSize(t, size) + (ls || 0) * size * t.length; }
  text(t, x, y, size, font, color, ls, page) {
    const pg = page || this.page;
    if (ls) pg.pushOperators(setCharacterSpacing(ls * size * PX));
    // y is the top of the line box; place the baseline using the font's ascent.
    const asc = font.heightAtSize(size, { descender: false });
    pg.drawText(t, { x: x * PX, y: (H - y - asc) * PX, size: size * PX, font, color });
    if (ls) pg.pushOperators(setCharacterSpacing(0));
  }
  wrap(t, font, size, maxW, ls) {
    const out = [];
    clean(t).split("\n").forEach((para) => {
      const words = para.split(/ +/).filter(Boolean);
      let line = "";
      words.forEach((w) => {
        const test = line ? line + " " + w : w;
        if (this.textWidth(test, font, size, ls) <= maxW || !line) { line = test; } else { out.push(line); line = w; }
      });
      out.push(line);
    });
    return out;
  }

  // ---- page chrome: header band, logo, tagline, footer ----
  newPage() {
    this.page = this.doc.addPage([W * PX, H * PX]);
    this.pageNo += 1;
    const pg = this.page;
    this.rect(0, 0, W, 78, C.band);
    // Logo: rounded square with the "n" and the rust dot (design units 305 -> 91 px).
    const s = 91 / 305;
    this.roundRect(27, 19, 91, 91, 62 * s, C.navy);
    this.svg("M80 273 V108 H115 V122 C130 112 145 106 160 106 C200 106 225 128 225 168 V273 H190 V172 C190 150 177 138 158 138 C132 138 115 152 115 180 V273 Z", 27, 19, s, { color: C.white });
    pg.drawCircle({ x: (27 + 207 * s) * PX, y: (H - 19 - 76 * s) * PX, size: 21 * s * PX, color: C.rust });
    // Tagline with accent rules either side.
    const tag = "NIMBL.AI - NEARSHORE PARTNER";
    const tx = 141 + 22 + 10;
    this.rect(141, 89 + 6.5, 22, 3, C.accent);
    this.text(tag, tx, 89 - 0.5, 13, this.f.bold, C.ink, 0.1);
    const tw = this.textWidth(tag, this.f.bold, 13, 0.1);
    this.rect(tx + tw + 10, 89 + 6.5, 774 - (tx + tw + 10), 3, C.accent);
    // Footer rule and contact row.
    this.rect(20, H - 81 - 3, W - 40, 3, C.rust);
    this.footer();
    this.y = BOX.top;
  }

  footer() {
    const items = [
      { icon: "phone", text: this.opts.phone || "" },
      { icon: "mail", text: this.opts.email || "" },
      { icon: "web", text: "nimbl.ai" },
      { icon: "pin", text: "London & Malaga" },
    ].filter((i) => i.text);
    const size = 12, ls = 0.04, gap = 10, iconW = 28;
    const widths = items.map((i) => iconW + gap + this.textWidth(clean(i.text), this.f.bold, size, ls));
    const left = 77, right = W - 71;
    const free = right - left - widths.reduce((a, b) => a + b, 0);
    const between = items.length > 1 ? free / (items.length - 1) : 0;
    let x = items.length > 1 ? left : left;
    const top = H - 29 - 28;
    items.forEach((it, i) => {
      this.icon(it.icon, x, top);
      this.text(clean(it.text), x + iconW + gap, top + 6, size, this.f.bold, C.soft, ls);
      x += widths[i] + between;
    });
  }

  icon(kind, x, y) {
    this.roundRect(x + 1, y + 1, 26, 26, 6, C.accent);
    const st = { stroke: C.white, strokeWidth: 1.4 * PX };
    const P = (d) => this.svg(d, x, y, 1, st);
    if (kind === "phone") P("M9.5 9c0 5.5 3.5 9.5 9 9.5l1.4-3-2.8-1.4-1.2 1.2c-1.6-.7-2.7-1.8-3.4-3.4l1.2-1.2L11.3 8z");
    if (kind === "mail") { P("M9.5 9.5 H18.5 A1 1 0 0 1 19.5 10.5 V17.5 A1 1 0 0 1 18.5 18.5 H9.5 A1 1 0 0 1 8.5 17.5 V10.5 A1 1 0 0 1 9.5 9.5 Z"); P("M8.8 10.5 L14 15 L19.2 10.5"); }
    if (kind === "web") {
      P("M8.5 14 A5.5 5.5 0 1 0 19.5 14 A5.5 5.5 0 1 0 8.5 14 Z");
      P("M11.6 14 A2.4 5.5 0 1 0 16.4 14 A2.4 5.5 0 1 0 11.6 14 Z");
      P("M8.5 14 H19.5");
    }
    if (kind === "pin") {
      P("M14 20s-4.8-4.2-4.8-8a4.8 4.8 0 0 1 9.6 0c0 3.8-4.8 8-4.8 8z");
      this.page.drawCircle({ x: (x + 14) * PX, y: (H - y - 12) * PX, size: 1.7 * PX, color: C.white });
    }
  }

  // ---- flowing content ----
  ensure(h) {
    if (this.y + h > BOX.bottom) {
      this.newPage();
      // Continuation pages carry the role title as an eyebrow, like page 2 of the design.
      this.eyebrow(this.opts.title, 26);
    }
  }
  eyebrow(t, after) {
    if (!t) return;
    const lines = this.wrap(t.toUpperCase(), this.f.bold, 12, BOX.w, 0.08);
    lines.forEach((ln) => { this.text(ln, BOX.x, this.y, 12, this.f.bold, C.rust, 0.08); this.y += 16; });
    this.y += after || 0;
  }
  heading1(t) {
    const lines = this.wrap(t, this.f.bold, 36, BOX.w, -0.02);
    lines.forEach((ln) => { this.text(ln, BOX.x, this.y, 36, this.f.bold, C.ink, -0.02); this.y += 36 * 1.1; });
  }
  metaRow(cols) {
    cols = cols.filter((c) => c.value);
    if (!cols.length) return;
    this.y += 10;
    this.rect(BOX.x, this.y, BOX.w, 1, C.rule);
    this.y += 15;
    // Columns sit 32px apart, as in the design; when they don't fit the 640px box they wrap
    // onto another row instead of running past the margin.
    const colW = cols.map((c) => Math.min(BOX.w, Math.max(this.textWidth(c.label, this.f.bold, 14), this.textWidth(clean(c.value), this.f.regular, 14))));
    const rows = [[]];
    let used = 0;
    cols.forEach((c, i) => {
      const need = (rows[rows.length - 1].length ? 32 : 0) + colW[i];
      if (rows[rows.length - 1].length && used + need > BOX.w) { rows.push([]); used = 0; }
      used += (rows[rows.length - 1].length ? 32 : 0) + colW[i];
      rows[rows.length - 1].push(i);
    });
    rows.forEach((row, ri) => {
      if (ri) this.y += 50;
      let x = BOX.x;
      row.forEach((i) => {
        this.text(cols[i].label, x, this.y, 14, this.f.bold, C.ink);
        this.text(clean(cols[i].value), x, this.y + 21, 14, this.f.regular, C.soft);
        x += colW[i] + 32;
      });
    });
    this.y += 42;
  }
  section(title, paragraphs, bullets) {
    const hasP = paragraphs && String(paragraphs).trim();
    const items = (bullets || []).map((b) => String(b).trim()).filter(Boolean);
    if (!hasP && !items.length) return;
    this.y += 26;
    // keep the heading with at least its first line of content
    this.ensure(19 * 1.3 + 8 + 26);
    this.text(clean(title), BOX.x, this.y, 19, this.f.bold, C.ink, -0.01);
    this.y += 19 * 1.3 + 8;
    const lh = 16 * 1.6;
    if (hasP) {
      String(paragraphs).split(/\n\s*\n/).forEach((para, pi) => {
        if (pi) this.y += 8;
        this.wrap(para.replace(/\n/g, " "), this.f.regular, 16, BOX.w).forEach((ln) => {
          this.ensure(lh);
          this.text(ln, BOX.x, this.y + 3, 16, this.f.regular, C.body);
          this.y += lh;
        });
      });
    }
    items.forEach((b, i) => {
      if (i || hasP) this.y += 4;
      const lines = this.wrap(b.replace(/^[-*•]\s*/, ""), this.f.regular, 16, BOX.w - 22);
      lines.forEach((ln, li) => {
        this.ensure(lh);
        if (li === 0) this.page.drawCircle({ x: (BOX.x + 7) * PX, y: (H - this.y - 3 - 7) * PX, size: 2.6 * PX, color: C.rust });
        this.text(ln, BOX.x + 22, this.y + 3, 16, this.f.regular, C.body);
        this.y += lh;
      });
    });
  }
}

function lines(v) {
  if (Array.isArray(v)) return v;
  return String(v || "").split("\n").map((s) => s.trim()).filter(Boolean);
}

// jd: { content: {title, practice, location, type, level, about, responsibilities, requirements, niceToHave, language, apply},
//       showClient, clientLabel, company, contactEmail, contactPhone }
async function renderJobDescriptionPdf(jd) {
  const c = jd.content || {};
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const fonts = {
    regular: await doc.embedFont(fontBytes.regular, { subset: true }),
    bold: await doc.embedFont(fontBytes.bold, { subset: true }),
  };
  const title = clean(c.title || "Open role");
  doc.setTitle(title + " - Nimbl.ai");
  doc.setAuthor("Nimbl.ai");
  doc.setCreator("Nimbl Radar");
  const w = new Writer(doc, fonts, { title, email: jd.contactEmail, phone: jd.contactPhone });
  w.newPage();
  w.eyebrow("Open role", 10);
  w.heading1(title);
  const client = jd.showClient ? jd.company : (jd.clientLabel || "");
  w.metaRow([
    { label: "Client", value: client },
    { label: "Practice area", value: c.practice },
    { label: "Location", value: c.location },
    { label: "Type", value: c.type },
    { label: "Level", value: c.level },
  ]);
  w.section("About the role", c.about);
  w.section("What you will do", null, lines(c.responsibilities));
  w.section("What we are looking for", null, lines(c.requirements));
  w.section("Nice to have", null, lines(c.niceToHave));
  w.section("Language", c.language);
  w.section("How to apply", c.apply);
  return Buffer.from(await doc.save());
}

module.exports = { renderJobDescriptionPdf };
