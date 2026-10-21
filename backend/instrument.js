'use strict';

// Sentry tiene que cargarse antes que http. Si SENTRY_DSN no está, no se
// inicializa: los tests y QA arrancan igual y no mandan eventos.
const Sentry = require('@sentry/node');

const dsn = process.env.SENTRY_DSN;
if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT || 'production',
    release: process.env.SENTRY_RELEASE || undefined,
    tracesSampleRate: 1.0,
    sendDefaultPii: true,
  });
}

module.exports = Sentry;
