/* ═══════════════════════════════════════════════════════════════════════════
   app.js  –  DHC Thesis Registration
   ═══════════════════════════════════════════════════════════════════════════ */

// ── ① Configuration ─────────────────────────────────────────────────────────
//  Replace the URL below with your Power Automate HTTP-trigger URL after you
//  create the flow (see README.md, Step 4).
const POWER_AUTOMATE_URL = 'PASTE_YOUR_POWER_AUTOMATE_URL_HERE';

const PDF_TEMPLATE = 'assets/form-blank.pdf';
const STAMP_IMAGE  = 'assets/stamp.png';

// ── ② Fixed form values ──────────────────────────────────────────────────────
const FIXED = {
  studiengang:   'Medien und Kommunikation',
  erstpruefer:   'Sebastian Scherr',
  lehrstuhl:     'Digital Health Communication',
  zweitpruefer:  'Jeffrey Wimmer',
};

// ── ③ PDF coordinate map ─────────────────────────────────────────────────────
//  pdf-lib uses BOTTOM-LEFT origin (y=0 at bottom of page).
//  Page height = 842.5 pt.  Conversion from fitz (top-left): y_lib = 842.5 - y_fitz
//
//  All measurements verified against signed example PDFs (BA_GÖLLER, MA_ZHUK).
const PLACEMENT = {
  // Student hand-signature, page 1
  // fitz bbox of existing student sig in the signed PA form: (232.7, 678.0, 378.7, 720.7)
  studentSig: {
    page: 0,
    x: 175, y: 122,      // pdf-lib bottom-left of image rect
    w: 215, h: 42,
  },

  // Prof. Scherr stamp – Section II "Unterschrift Erstprüfer/in", page 2
  // Placed above the "Datum / Unterschrift" line at fitz-y ≈ 352
  stampII: {
    page: 1,
    x: 215, y: 492,      // pdf-lib: 842.5 - 350 ≈ 492
    w: 195, h: 65,
  },

  // Prof. Scherr stamp – Section III "Unterschrift Vorsitzende/r", page 2
  // sign_pdf.py SIG_RECT = fitz.Rect(214, 495, 370, 545)
  stampIII: {
    page: 1,
    x: 214, y: 297,      // pdf-lib: 842.5 - 545 ≈ 297
    w: 156, h: 50,
  },
};

// ── ④ Globals ────────────────────────────────────────────────────────────────
let pad = null;   // SignaturePad instance

// ── ⑤ Bootstrap ─────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initPad();
  document.getElementById('clear-btn').addEventListener('click', () => pad.clear());
  document.getElementById('thesis-form').addEventListener('submit', onSubmit);
});

// ── ⑥ Signature pad ──────────────────────────────────────────────────────────
function initPad() {
  const canvas = document.getElementById('sig-canvas');
  resizeCanvas(canvas);
  pad = new SignaturePad(canvas, {
    minWidth: 0.8,
    maxWidth: 2.5,
    penColor: '#111',
    backgroundColor: 'rgba(255,255,255,1)',
  });
  window.addEventListener('resize', () => { resizeCanvas(canvas); pad.clear(); });
}

function resizeCanvas(canvas) {
  const ratio = Math.max(window.devicePixelRatio || 1, 1);
  const rect  = canvas.getBoundingClientRect();
  canvas.width  = (rect.width  || canvas.offsetWidth)  * ratio;
  canvas.height = (rect.height || 160) * ratio;
  canvas.getContext('2d').scale(ratio, ratio);
}

// ── ⑦ Form submission ────────────────────────────────────────────────────────
async function onSubmit(e) {
  e.preventDefault();

  const err = validate();
  if (err) { showError(err); return; }

  setLoading(true);
  clearError();

  try {
    const data     = collectData();
    const pdfBytes = await buildPDF(data);
    await sendToOneDrive(pdfBytes, data);
    showSuccess();
  } catch (ex) {
    console.error(ex);
    showError(
      'Fehler beim Senden. Bitte versuchen Sie es erneut oder wenden Sie ' +
      'sich direkt an Prof. Dr. Scherr.\n\nDetails: ' + ex.message
    );
  } finally {
    setLoading(false);
  }
}

// ── ⑧ Validation ─────────────────────────────────────────────────────────────
function validate() {
  const abschluss = document.querySelector('input[name="abschluss"]:checked');
  const name      = document.getElementById('name').value.trim();
  const matrikel  = document.getElementById('matrikel').value.trim();
  const thema     = document.getElementById('thema').value.trim();
  const confirm   = document.getElementById('confirm').checked;

  if (!abschluss)              return 'Bitte wählen Sie Bachelor oder Master aus.';
  if (!name)                   return 'Bitte geben Sie Ihren Namen ein.';
  if (!/^\d{7}$/.test(matrikel))
                               return 'Bitte geben Sie Ihre 7-stellige Matrikelnummer ein.';
  if (!thema)                  return 'Bitte geben Sie das Thema Ihrer Arbeit ein.';
  if (pad.isEmpty())           return 'Bitte unterschreiben Sie im Unterschriftsfeld.';
  if (!confirm)                return 'Bitte bestätigen Sie die Datenkontrolle in Studis / VIBS.';
  return null;
}

// ── ⑨ Data collection ────────────────────────────────────────────────────────
function collectData() {
  const today   = new Date();
  const dd      = String(today.getDate()).padStart(2, '0');
  const mm      = String(today.getMonth() + 1).padStart(2, '0');
  const yyyy    = today.getFullYear();
  const dateStr = `${dd}.${mm}.${yyyy}`;

  const abschluss = document.querySelector('input[name="abschluss"]:checked').value;

  return {
    abschluss,
    // PDF radio export values: Auswahl1 = BA, Auswahl2 = MA
    radioValue:     abschluss === 'BA' ? 'Auswahl1' : 'Auswahl2',
    name:           document.getElementById('name').value.trim(),
    matrikel:       document.getElementById('matrikel').value.trim(),
    thema:          document.getElementById('thema').value.trim(),
    ...FIXED,
    studentDate:    dateStr,
    supervisorDate: dateStr,
    sigDataUrl:     pad.toDataURL('image/png'),
  };
}

// ── ⑩ PDF generation (pdf-lib) ───────────────────────────────────────────────
async function buildPDF(data) {
  const { PDFDocument } = PDFLib;

  // Load assets in parallel
  const [templateBuf, stampBuf] = await Promise.all([
    fetch(PDF_TEMPLATE).then(r => r.arrayBuffer()),
    fetch(STAMP_IMAGE).then(r => r.arrayBuffer()),
  ]);

  const pdfDoc   = await PDFDocument.load(templateBuf);
  const form     = pdfDoc.getForm();
  const pages    = pdfDoc.getPages();

  // Embed images
  const stampImg   = await pdfDoc.embedPng(stampBuf);
  const studentSig = await pdfDoc.embedPng(dataUrlToBytes(data.sigDataUrl));

  // ── Fill form fields ───────────────────────────────────────────────────────
  // Radio button: BA = Auswahl1, MA = Auswahl2
  try { form.getRadioGroup('BA MA').select(data.radioValue); }
  catch (e) { console.warn('Radio:', e.message); }

  setTextField(form, 'Studiengang',                     data.studiengang);
  setTextField(form, 'Name, Vornamen',                  data.name);
  setTextField(form, 'Matrikelnummer',                  data.matrikel);
  setTextField(form, 'Erstprüfer',                      data.erstpruefer);
  setTextField(form, 'Lehrstuhl',                       data.lehrstuhl);
  setTextField(form, 'Datum Studi_af_date',             data.studentDate);
  setTextField(form, 'Thema',                           data.thema);
  setTextField(form, 'Name Zweitprüfer',                data.zweitpruefer);
  setTextField(form, 'Datum Erstprüfer_af_date',        data.supervisorDate);
  setTextField(form, 'Datum Prüfungssausschuss_af_date',data.supervisorDate);

  // Flatten so fields become static text (non-editable final PDF)
  form.flatten();

  // ── Draw student signature on page 1 ──────────────────────────────────────
  const p = PLACEMENT;
  pages[p.studentSig.page].drawImage(studentSig, {
    x: p.studentSig.x, y: p.studentSig.y,
    width: p.studentSig.w, height: p.studentSig.h,
  });

  // ── Draw supervisor stamp on page 2 — twice ────────────────────────────────
  // Section II (Erstprüfer)
  pages[p.stampII.page].drawImage(stampImg, {
    x: p.stampII.x, y: p.stampII.y,
    width: p.stampII.w, height: p.stampII.h,
  });
  // Section III (Prüfungsausschuss)
  pages[p.stampIII.page].drawImage(stampImg, {
    x: p.stampIII.x, y: p.stampIII.y,
    width: p.stampIII.w, height: p.stampIII.h,
  });

  return pdfDoc.save();
}

function setTextField(form, name, value) {
  try { form.getTextField(name).setText(value); }
  catch (e) { console.warn(`Field "${name}":`, e.message); }
}

// ── ⑪ Power Automate submission ──────────────────────────────────────────────
async function sendToOneDrive(pdfBytes, data) {
  // Filename mirrors your existing convention: TYPE_YEAR_SURNAME_SCHERR.pdf
  const year    = new Date().getFullYear();
  const surname = data.name.split(',')[0].trim()
                       .replace(/\s+/g, '_')
                       .toUpperCase()
                       .replace(/[^A-ZÄÖÜ_]/g, '');
  const filename = `${data.abschluss}_${year}_${surname}_SCHERR.pdf`;

  const payload = {
    filename,
    abschluss:   data.abschluss,
    studentName: data.name,
    matrikel:    data.matrikel,
    thema:       data.thema,
    date:        data.studentDate,
    pdfBase64:   bytesToBase64(pdfBytes),
  };

  const res = await fetch(POWER_AUTOMATE_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(payload),
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

// ── ⑫ Helpers ────────────────────────────────────────────────────────────────
function dataUrlToBytes(dataUrl) {
  const b64    = dataUrl.split(',')[1];
  const binary = atob(b64);
  const bytes  = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes) {
  let bin = '';
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

// ── ⑬ UI state helpers ───────────────────────────────────────────────────────
function showError(msg) {
  const el = document.getElementById('error-banner');
  el.textContent = msg;
  el.classList.remove('hidden');
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
function clearError() {
  document.getElementById('error-banner').classList.add('hidden');
}

function setLoading(on) {
  const btn = document.getElementById('submit-btn');
  btn.querySelector('.btn-label').classList.toggle('hidden', on);
  btn.querySelector('.btn-spinner').classList.toggle('hidden', !on);
  btn.disabled = on;
}

function showSuccess() {
  document.getElementById('form-screen').classList.add('hidden');
  document.getElementById('success-screen').classList.remove('hidden');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
