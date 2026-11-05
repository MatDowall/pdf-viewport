// Generates an A1 landscape "drawing" with hairlines and 1pt text — a stress test
// for sharpness at deep zoom. Run: node test/makeFixture.mjs
import { writeFileSync } from 'node:fs';
const W = 2384, H = 1684;
let s = '0.2 w\n';
for (let x = 20; x < W; x += 10) s += `${x} 20 m ${x} ${H - 20} l S\n`;
for (let y = 20; y < H; y += 10) s += `20 ${y} m ${W - 20} ${y} l S\n`;
s += '0.05 w 1 0 0 RG\n';
for (let i = 0; i < 400; i++) s += `${100 + i * 5} 100 m ${300 + i * 5} 1500 l S\n`;
s += '0 0 0 RG BT /F1 1 Tf\n';
for (let y = 30; y < H - 30; y += 40) for (let x = 30; x < W - 60; x += 120) s += `1 0 0 1 ${x} ${y} Tm (x${x} y${y} tiny text) Tj\n`;
s += 'ET\nBT /F1 60 Tf 1 0 0 1 900 820 Tm (PdfViewport test sheet) Tj ET\n';
const objs = [
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>`,
  `<< /Length ${s.length} >>\nstream\n${s}endstream`,
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
];
let out = '%PDF-1.4\n', offs = [];
objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
const xref = out.length;
out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
writeFileSync(new URL('./fixtures/a1-test-sheet.pdf', import.meta.url), out, 'latin1');
console.log('wrote', out.length, 'bytes');
