const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// PROTOTIPA piezīme: faili tiek saglabāti LOKĀLI backend servera diskā
// (mapē backend/uploads/), lai viss būtu bezmaksas un bez trešo pušu kontiem.
// Tas der lokālai/dev lietošanai. Ja backend vēlāk pārceļas uz mākoņa
// hostingu ar īslaicīgu (ephemeral) disku (piem. Render bezmaksas plāns),
// faili pēc restarta pazudīs -- tad vajadzēs pāriet uz pastāvīgu glabātuvi,
// piem. bezmaksas Cloudinary vai Supabase Storage plānu.
const ALLOWED_MIME_PREFIXES = ['image/', 'video/', 'audio/'];
const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB -- pietiek foto/video/balss ziņai

// "uploads" mape var neeksistēt servera diskā (piem. GitHub necopē tukšas
// mapes, vai Render katru reizi sāk no tīra diska) -- tāpēc to IZVEIDOJAM
// PAŠI servera palaišanas brīdī, nevis paļaujamies, ka tā jau ir tur.
const uploadsDir = path.join(__dirname, '../../uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
  console.log('Izveidota uploads mape:', uploadsDir);
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '';
    const unique = crypto.randomBytes(8).toString('hex');
    cb(null, `${Date.now()}-${unique}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MIME_PREFIXES.some((p) => file.mimetype.startsWith(p))) cb(null, true);
    else cb(new Error('Atļauti tikai foto, video un audio faili'));
  },
});

// POST /api/uploads -- multipart/form-data, lauks "file"
// Atgriež relatīvu URL (/uploads/<fails>), ko tālāk sūta ticketa attachmentUrls masīvā.
router.post('/', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Fails nav saņemts (lauks "file")' });
  res.status(201).json({
    url: `/uploads/${req.file.filename}`,
    fileName: req.file.originalname,
    mimeType: req.file.mimetype,
  });
});

// Multer/faila kļūdu apstrāde (piem. par lielu failu)
router.use((err, req, res, next) => {
  res.status(400).json({ error: err.message || 'Augšupielādes kļūda' });
});

module.exports = router;
