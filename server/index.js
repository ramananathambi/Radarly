require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const { startScheduler } = require('./jobs/scheduler');

const app = express();
const PORT = process.env.PORT || 3000;

// Trust reverse proxy (Hostinger / nginx)
app.set('trust proxy', 1);

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Serve static frontend files
app.use(express.static(path.join(__dirname, '../client')));

// API Routes
app.use('/api/auth',      require('./routes/auth'));
app.use('/api/stocks',    require('./routes/stocks'));
app.use('/api/user',      require('./routes/user'));
app.use('/api/dividends', require('./routes/dividends'));
app.use('/api/webhooks',  require('./routes/webhooks'));
app.use('/api/admin',     require('./routes/admin'));

// Catch-all — serve index.html for client-side routing
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../client/index.html'));
});

// Start server
const server = app.listen(PORT, () => {
  console.log(`[Radarly] Server running on http://localhost:${PORT}`);
  startScheduler();
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[Radarly] Port ${PORT} is already in use. Kill the existing process and restart.`);
    process.exit(1);
  } else {
    throw err;
  }
});
