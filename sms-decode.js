// Decodes the short_message of a submit_sm for display: data_coding → alphabet name, UDH (concatenated parts) and text.
// Used by the built-in vendor's "Vendor messages" list so you can see exactly what your platform sent and how.

// GSM 03.38 default alphabet (unpacked, one septet per byte as SMPP carries it) and its extension table (after 0x1B)
const GSM7 = [
  '@', '£', '$', '¥', 'è', 'é', 'ù', 'ì', 'ò', 'Ç', '\n', 'Ø', 'ø', '\r', 'Å', 'å',
  'Δ', '_', 'Φ', 'Γ', 'Λ', 'Ω', 'Π', 'Ψ', 'Σ', 'Θ', 'Ξ', '\x1b', 'Æ', 'æ', 'ß', 'É',
  ' ', '!', '"', '#', '¤', '%', '&', "'", '(', ')', '*', '+', ',', '-', '.', '/',
  '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', ':', ';', '<', '=', '>', '?',
  '¡', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O',
  'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z', 'Ä', 'Ö', 'Ñ', 'Ü', '§',
  '¿', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o',
  'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z', 'ä', 'ö', 'ñ', 'ü', 'à',
];
const GSM7_EXT = { 0x0a: '\f', 0x14: '^', 0x28: '{', 0x29: '}', 0x2f: '\\', 0x3c: '[', 0x3d: '~', 0x3e: ']', 0x40: '|', 0x65: '€' };

// data_coding → { enc, label }. 0x00–0x0F follow the SMPP 3.4 table; higher values follow the GSM 03.38 coding groups
// (e.g. 0x10 = GSM7 class 0, 0x18 = UCS2 class 0, 0xF0 = GSM7 flash), which many platforms send instead.
function alphabet(dcs) {
  const SMPP = { 0: 'GSM7', 1: 'IA5', 2: 'BINARY', 3: 'LATIN1', 4: 'BINARY', 5: 'JIS', 6: 'CYRILLIC', 7: 'HEBREW', 8: 'UCS2', 9: 'PICTO', 10: 'ISO2022JP', 13: 'KANJI', 14: 'KSC5601' };
  if (dcs <= 0x0f) return SMPP[dcs] || 'OTHER';
  if ((dcs & 0xc0) === 0x00) { const a = (dcs >> 2) & 3; return a === 0 ? 'GSM7' : a === 1 ? 'BINARY' : a === 2 ? 'UCS2' : 'OTHER'; } // general data coding
  if ((dcs & 0xf0) === 0xf0) return dcs & 0x04 ? 'BINARY' : 'GSM7';  // data coding / message class
  if ((dcs & 0xf0) === 0xc0 || (dcs & 0xf0) === 0xd0) return 'GSM7'; // message waiting, GSM7
  if ((dcs & 0xf0) === 0xe0) return 'UCS2';                          // message waiting, UCS2
  return 'OTHER';
}
const LABEL = { GSM7: 'GSM7', IA5: 'IA5/ASCII', BINARY: 'Binary', LATIN1: 'Latin-1', JIS: 'JIS', CYRILLIC: 'Cyrillic', HEBREW: 'Hebrew', UCS2: 'UCS2', PICTO: 'Pictogram', ISO2022JP: 'ISO-2022-JP', KANJI: 'Kanji', KSC5601: 'KS C 5601', OTHER: 'Unknown' };
const encLabel = dcs => `${LABEL[alphabet(dcs)]} (${dcs})`;

function gsm7(buf) {
  let s = '';
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i] & 0x7f;
    if (b === 0x1b && i + 1 < buf.length) { const e = GSM7_EXT[buf[i + 1] & 0x7f]; if (e !== undefined) { s += e; i++; continue; } s += ' '; continue; }
    s += GSM7[b];
  }
  return s;
}
function ucs2(buf) {
  const le = Buffer.allocUnsafe(buf.length & ~1);
  for (let i = 0; i + 1 < buf.length; i += 2) { le[i] = buf[i + 1]; le[i + 1] = buf[i]; }
  return le.toString('utf16le');
}
function viaDecoder(label, buf) { try { return new TextDecoder(label).decode(buf); } catch { return buf.toString('latin1'); } }

// UDH: first byte is its length; 0x00 (8-bit reference) and 0x08 (16-bit reference) carry the concatenation info
function parseUdh(sm) {
  const l = sm[0]; if (!sm.length || l + 1 > sm.length) return { udh: null, rest: sm };
  let i = 1, part = null; const ies = [];
  while (i + 1 < 1 + l) {
    const id = sm[i], len = sm[i + 1], v = sm.subarray(i + 2, i + 2 + len); ies.push(id);
    if (id === 0x00 && len === 3) part = { ref: v[0], total: v[1], seq: v[2] };
    if (id === 0x08 && len === 4) part = { ref: (v[0] << 8) | v[1], total: v[2], seq: v[3] };
    i += 2 + len;
  }
  return { udh: { len: l, ies, part }, rest: sm.subarray(1 + l) };
}

// → { enc, encLabel, text, udh, parts: 'seq/total' | '', bytes, hex }
function decodeSm(dcs, esm, sm) {
  const a = alphabet(dcs);
  let body = sm, udh = null;
  if (esm & 0x40) ({ udh, rest: body } = parseUdh(sm));
  let text;
  switch (a) {
    case 'GSM7': text = gsm7(body); break;
    case 'UCS2': text = ucs2(body); break;
    case 'IA5': text = body.toString('latin1').replace(/[\x80-\xff]/g, '?'); break;
    case 'LATIN1': text = body.toString('latin1'); break;
    case 'CYRILLIC': text = viaDecoder('iso-8859-5', body); break;
    case 'HEBREW': text = viaDecoder('iso-8859-8', body); break;
    case 'KSC5601': text = viaDecoder('euc-kr', body); break;
    case 'JIS': case 'KANJI': text = viaDecoder('shift_jis', body); break;
    case 'ISO2022JP': text = viaDecoder('iso-2022-jp', body); break;
    default: text = ''; // binary / unknown: hex only
  }
  return {
    enc: a, encLabel: encLabel(dcs), text, udh,
    parts: udh && udh.part ? `${udh.part.seq}/${udh.part.total}` : '',
    bytes: sm.length, hex: sm.toString('hex'),
  };
}

module.exports = { decodeSm, alphabet, encLabel, gsm7, GSM7 };
