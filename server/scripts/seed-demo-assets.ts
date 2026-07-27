// Mídia da base de demonstração, GERADA em código (docs/DEMO_DATA.md §8).
//
// As conversas do WhatsApp semeado precisam de foto, PDF e áudio para exercitar
// o visualizador, o proxy de mídia e o player. Binário de verdade não entra no
// repositório (peso, licença, revisão impossível), e base64 colado num .ts é
// pior ainda — ninguém sabe o que está lá dentro. Então cada arquivo é montado
// aqui, com o formato mínimo válido: PNG via zlib, WAV PCM e PDF a mão.
//
// Todos os mimes gerados estão na allowlist inline do proxy de mídia
// (INLINE_MEDIA_MIME em routes/whatsapp.ts) — imagem, PDF e áudio abrem no
// browser em vez de virar download.
import { deflateSync } from 'node:zlib';

// ---------------------------------------------------------------- PNG

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

// PNG RGB de 8 bits, sem filtro por linha (byte 0 no começo de cada scanline).
// `pixel` devolve [r,g,b] — é o gerador da "foto".
export function png(w: number, h: number, pixel: (x: number, y: number) => [number, number, number]): Buffer {
  const raw = Buffer.alloc(h * (1 + w * 3));
  let o = 0;
  for (let y = 0; y < h; y++) {
    raw[o++] = 0; // filter type: none
    for (let x = 0; x < w; x++) {
      const [r, g, b] = pixel(x, y);
      raw[o++] = r; raw[o++] = g; raw[o++] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // color type: truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// "Foto de gôndola": prateleiras horizontais com caixas de produto em cima.
// Não é fotografia, mas lê como uma foto de loja no balão de 260px — que é o
// papel dela na demo. `tint` varia a paleta entre as conversas.
export function fotoGondola(tint: number): Buffer {
  const W = 480, H = 320;
  const shelfY = [70, 150, 230];        // topo de cada prateleira
  const boxW = 46, boxH = 58, gap = 12;
  const hue = (n: number): [number, number, number] => {
    const base: [number, number, number][] = [
      [214, 96, 84], [232, 176, 74], [126, 172, 118], [96, 134, 200], [206, 122, 158],
    ];
    return base[(n + tint) % base.length]!;
  };
  return png(W, H, (x, y) => {
    // parede/fundo
    let px: [number, number, number] = [238, 234, 226];
    for (let s = 0; s < shelfY.length; s++) {
      const top = shelfY[s]!;
      // tábua da prateleira
      if (y >= top + boxH && y < top + boxH + 8) px = [150, 122, 92];
      // caixas
      if (y >= top && y < top + boxH) {
        const col = Math.floor((x - 16) / (boxW + gap));
        const inCol = (x - 16) % (boxW + gap);
        if (x >= 16 && col >= 0 && col < 7 && inCol < boxW) {
          const c = hue(col + s * 2);
          // rótulo claro no meio da caixa
          const label = y > top + 18 && y < top + 34 && inCol > 6 && inCol < boxW - 6;
          px = label ? [246, 244, 240] : c;
          if (inCol < 2 || inCol > boxW - 3 || y < top + 2) px = [c[0] * 0.7 | 0, c[1] * 0.7 | 0, c[2] * 0.7 | 0];
        }
      }
    }
    // vinheta suave nos cantos (dá cara de foto tirada no celular)
    const dx = (x - W / 2) / (W / 2), dy = (y - H / 2) / (H / 2);
    const v = 1 - 0.28 * (dx * dx + dy * dy);
    return [px[0] * v | 0, px[1] * v | 0, px[2] * v | 0];
  });
}

// ---------------------------------------------------------------- WAV

// Áudio PCM 16 bits mono 8 kHz — o "áudio curto" que o comprador manda. Uma
// senoide com envelope de decaimento: não é voz, mas toca no <audio> do balão.
export function wavNota(segundos: number, freq: number): Buffer {
  const rate = 8000;
  const n = Math.floor(rate * segundos);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const env = Math.min(1, t * 12) * Math.exp(-t * 1.6);
    // dois harmônicos: soa menos "bipe de teste" que a senoide pura
    const s = Math.sin(2 * Math.PI * freq * t) * 0.7 + Math.sin(4 * Math.PI * freq * t) * 0.3;
    data.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(s * env * 22000))), i * 2);
  }
  const head = Buffer.alloc(44);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVEfmt ', 8, 'latin1');
  head.writeUInt32LE(16, 16);           // tamanho do bloco fmt
  head.writeUInt16LE(1, 20);            // PCM
  head.writeUInt16LE(1, 22);            // mono
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28);     // byte rate
  head.writeUInt16LE(2, 32);            // block align
  head.writeUInt16LE(16, 34);           // bits por amostra
  head.write('data', 36, 'latin1');
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

// ---------------------------------------------------------------- PDF

const pdfEscape = (s: string): string => s.replace(/([\\()])/g, '\\$1');

// PDF 1.4 de uma página, fonte base Helvetica (não precisa embutir). Só o que a
// tabela de preços da demo exige: título, subtítulo e linhas de produto/valor.
// A xref é montada com os offsets reais — PDF com xref torta não abre.
export function pdfTabela(titulo: string, subtitulo: string, linhas: [string, string][]): Buffer {
  const out: string[] = [];
  out.push('BT /F2 16 Tf 56 782 Td (' + pdfEscape(titulo) + ') Tj ET');
  out.push('BT /F1 10 Tf 56 764 Td (' + pdfEscape(subtitulo) + ') Tj ET');
  out.push('0.8 w 0.6 0.6 0.6 RG 56 752 m 539 752 l S');
  let y = 730;
  for (const [nome, valor] of linhas) {
    out.push('BT /F1 11 Tf 56 ' + y + ' Td (' + pdfEscape(nome) + ') Tj ET');
    out.push('BT /F1 11 Tf 470 ' + y + ' Td (' + pdfEscape(valor) + ') Tj ET');
    y -= 20;
  }
  out.push('BT /F1 8 Tf 56 60 Td (' + pdfEscape('Documento gerado para demonstracao — Rovva') + ') Tj ET');
  const content = Buffer.from(out.join('\n'), 'latin1');

  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] '
      + '/Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>',
    `<< /Length ${content.length} >>\nstream\n${content.toString('latin1')}\nendstream`,
  ];

  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n', 'latin1')];
  const offsets: number[] = [];
  let pos = parts[0]!.length;
  objs.forEach((body, i) => {
    offsets.push(pos);
    const b = Buffer.from(`${i + 1} 0 obj\n${body}\nendobj\n`, 'latin1');
    parts.push(b);
    pos += b.length;
  });
  const xrefPos = pos;
  const xref = [`xref\n0 ${objs.length + 1}\n`, '0000000000 65535 f \n']
    .concat(offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`))
    .join('');
  parts.push(Buffer.from(
    `${xref}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`,
    'latin1',
  ));
  return Buffer.concat(parts);
}

// Avatar de conversa: quadrado com as iniciais em bloco de cor. Serve o cache de
// foto (whatsapp_chats.foto_b64) sem sair para o CDN da Meta.
export function avatar(iniciais: string, tint: number): Buffer {
  const S = 96;
  const cores: [number, number, number][] = [
    [72, 118, 196], [26, 148, 122], [196, 118, 46], [166, 82, 140], [86, 106, 138], [188, 82, 74],
  ];
  const bg = cores[tint % cores.length]!;
  // Máscara 5x7 dos caracteres usados nas iniciais (A-Z), desenhada como blocos.
  const glyphs: Record<string, string[]> = {
    A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
    B: ['11110', '10001', '11110', '10001', '10001', '10001', '11110'],
    C: ['01111', '10000', '10000', '10000', '10000', '10000', '01111'],
    D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
    E: ['11111', '10000', '11110', '10000', '10000', '10000', '11111'],
    F: ['11111', '10000', '11110', '10000', '10000', '10000', '10000'],
    G: ['01111', '10000', '10000', '10011', '10001', '10001', '01110'],
    H: ['10001', '10001', '11111', '10001', '10001', '10001', '10001'],
    I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
    J: ['00111', '00010', '00010', '00010', '10010', '10010', '01100'],
    K: ['10001', '10010', '11100', '10010', '10001', '10001', '10001'],
    L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
    M: ['10001', '11011', '10101', '10001', '10001', '10001', '10001'],
    N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
    O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
    P: ['11110', '10001', '11110', '10000', '10000', '10000', '10000'],
    Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
    R: ['11110', '10001', '11110', '10100', '10010', '10001', '10001'],
    S: ['01111', '10000', '01110', '00001', '00001', '10001', '01110'],
    T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
    U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
    V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
    W: ['10001', '10001', '10001', '10101', '10101', '11011', '10001'],
    X: ['10001', '01010', '00100', '00100', '00100', '01010', '10001'],
    Y: ['10001', '01010', '00100', '00100', '00100', '00100', '00100'],
    Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
  };
  const letras = [...iniciais.toUpperCase()].filter((c) => glyphs[c]).slice(0, 2);
  const cell = 6;                                  // lado do bloco de um pixel do glifo
  const gw = letras.length * (5 * cell + cell) - cell;
  const x0 = (S - gw) >> 1, y0 = (S - 7 * cell) >> 1;
  return png(S, S, (x, y) => {
    const gi = Math.floor((x - x0) / (6 * cell));
    const g = letras[gi] ? glyphs[letras[gi]!] : undefined;
    if (g && x >= x0 && y >= y0) {
      const cx = Math.floor(((x - x0) % (6 * cell)) / cell);
      const cy = Math.floor((y - y0) / cell);
      if (cx < 5 && cy < 7 && g[cy]?.[cx] === '1') return [255, 255, 255];
    }
    return bg;
  });
}
