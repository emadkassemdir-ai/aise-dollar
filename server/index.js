#!/usr/bin/env node
'use strict';
/**
 * Start the AISE Dollar server.
 *   PORT=3000 AISE_DB=./data/aise.db node server/index.js
 */
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('./app.js');

const port = Number(process.env.PORT) || 3000;
const dbFile = path.resolve(process.env.AISE_DB || path.join(__dirname, '..', 'data', 'aise.db'));
fs.mkdirSync(path.dirname(dbFile), { recursive: true });

const quiet = { info: () => {}, error: console.error };
const app = createApp({ dbFile, log: process.env.LOG_REQUESTS === '1' ? console : quiet });

app.server.listen(port, () => {
  console.log(`AISE Dollar running on http://localhost:${port}  (database: ${dbFile})`);
  if (app.needsSetup()) {
    console.log('\n  First run! Open the site and create the Bank Office account with this setup code:');
    console.log(`\n      ${app.setupCode}\n`);
  }
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`\n${signal} received, shutting down…`);
    app.server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  });
}
