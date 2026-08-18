require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');

const ticketsRouter = require('./routes/tickets');
const assetsRouter = require('./routes/assets');
const categoriesRouter = require('./routes/categories');
const usersRouter = require('./routes/users');
const applicationsRouter = require('./routes/applications');
const phoneNumbersRouter = require('./routes/phoneNumbers');
const accessRightsRouter = require('./routes/accessRights');
const importRouter = require('./routes/importData');
const uploadsRouter = require('./routes/uploads');
const customFieldsRouter = require('./routes/customFields');
const subcategoriesRouter = require('./routes/subcategories');

const app = express();
app.use(helmet({ contentSecurityPolicy: false })); // atslegts CSP, lai admin panelis var ielādēt CDN skriptus (PapaParse)
app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(morgan('dev'));

app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

app.use('/api/tickets', ticketsRouter);
app.use('/api/assets', assetsRouter);
app.use('/api/categories', categoriesRouter);
app.use('/api/users', usersRouter);
app.use('/api/applications', applicationsRouter);
app.use('/api/phone-numbers', phoneNumbersRouter);
app.use('/api/access-rights', accessRightsRouter);
app.use('/api/import', importRouter);
app.use('/api/uploads', uploadsRouter);
app.use('/api/custom-fields', customFieldsRouter);
app.use('/api/subcategories', subcategoriesRouter);

// Augšupielādētie pielikumi (foto/video/balss ziņas) -- pieejami statiski
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// Web admin panelis -- statiski faili, pieejami http://localhost:3000/admin
app.use('/admin', express.static(path.join(__dirname, '../public/admin')));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Servera kluda', detail: err.message });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`IT Helpdesk API klausas uz porta ${PORT}`));

// ============================================================
// DROŠĪBAS TĪKLS: ja kādā vietā koda pieprasījums pret datubāzi izmet
// kļūdu, ko konkrētais maršruts (nepilnīgi) nenoķer ar try/catch, tas
// NEDRĪKST avarēt VISU serveri (kas citādi nozīmētu 502 kļūdu VISIEM
// lietotājiem, kamēr Render to automātiski restartē). Šie divi handleri
// tikai pieraksta kļūdu žurnālā un ļauj serverim turpināt darboties.
// Tas nav aizstājējs pareizai try/catch katrā maršrutā (skat. kā tas
// izdarīts categories.js), bet ir papildu drošība pret nepamanītām vietām.
// ============================================================
process.on('unhandledRejection', (reason) => {
  console.error('Neapstrādāts Promise noraidījums:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Neapstrādāta izņēmumsituācija:', err);
});
