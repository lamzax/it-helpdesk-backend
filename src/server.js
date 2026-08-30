require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');

const ticketsRouter = require('./routes/tickets');
const usersRouter = require('./routes/users');
const modulesRouter = require('./routes/modules');
const accessRequestsRouter = require('./routes/accessRequests');
const uploadsRouter = require('./routes/uploads');

const app = express();
app.use(helmet({ contentSecurityPolicy: false })); // atslegts CSP, lai admin panelis var ielādēt CDN skriptus (PapaParse)
app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(morgan('dev'));

app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

app.use('/api/tickets', ticketsRouter);
app.use('/api/users', usersRouter);
app.use('/api/modules', modulesRouter);
app.use('/api/access-requests', accessRequestsRouter);
app.use('/api/uploads', uploadsRouter);

// Augšupielādētie pielikumi (foto/video/balss ziņas) -- pieejami statiski
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// Web admin panelis -- statiski faili, pieejami http://localhost:3000/admin
// "Cache-Control: no-cache" -- lai pārlūks vienmēr pārbauda, vai admin
// JS/HTML fails nav mainījies, nevis rāda vecu versiju no kešatmiņas.
app.use('/admin', express.static(path.join(__dirname, '../public/admin'), {
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
}));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Servera kluda', detail: err.message });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`IT Helpdesk API klausas uz porta ${PORT}`));

// ============================================================
// DROŠĪBAS TĪKLS: nepieļauj, ka neapstrādāta kļūda avarē visu serveri.
// ============================================================
process.on('unhandledRejection', (reason) => {
  console.error('Neapstrādāts Promise noraidījums:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Neapstrādāta izņēmumsituācija:', err);
});
