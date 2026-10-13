// -----------------------------------------------------------------------------
// Entry point of the Tapo external integration.
//
// Only the wiring lives here: build the SDK instance, register every handler
// (src/app.js, BEFORE connect()), then connect. The SDK handles the connection
// to Gladys, its authentication and its reconnection.
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { createApp } from './src/app.js';

const gladys = new GladysIntegration();
const app = createApp(gladys);

// --- Graceful shutdown -------------------------------------------------------
gladys.handleShutdown(async (signal) => {
  logger.info(`Received ${signal} -> graceful shutdown`);
  await app.shutdown();
});

// --- Last-resort guards ------------------------------------------------------
// A camera socket dying at the wrong moment must never take the integration
// down: the supervisor would restart it and every camera would lose its images
// until the next round. These handlers keep the process alive and leave a trace.
process.on('uncaughtException', (err) => {
  logger.error(`Uncaught exception, the integration keeps running: ${err.message}`, err);
});
process.on('unhandledRejection', (reason) => {
  logger.error(`Unhandled rejection, the integration keeps running: ${reason}`);
});

// --- Startup -----------------------------------------------------------------
logger.info('Starting the Tapo integration...');
gladys.connect().catch((err) => {
  logger.error('Initial connection failed', err);
  process.exit(1);
});
