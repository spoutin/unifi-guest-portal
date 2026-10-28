import dotenv from 'dotenv';
import { createServer } from './server';
import { store, GuestRequest } from './store';
import { UnifiClient } from './unifi';
import { SlackIntegration } from './slack';
import { logger } from './logger';

dotenv.config({ path: process.env.CONFIG_PATH || '.env' });

export const appVersion = '1.0.14';

export const slackEnabled = process.env.SLACK_ENABLED !== 'false' && process.env.SLACK_ENABLED !== '0';

if (!slackEnabled) {
  logger.info('Slack integration is DISABLED (SLACK_ENABLED=' + process.env.SLACK_ENABLED + '). Skipping Slack client startup and notifications.');
}

process.on('unhandledRejection', (reason: any) => {
  logger.error(`Unhandled Rejection: ${reason?.stack || reason}`);
});

process.on('uncaughtException', (err: any) => {
  if (err?.message?.includes("Unhandled event 'server explicit disconnect'")) {
    logger.warn(`Handled Slack Socket Mode reconnect glitch gracefully: ${err.message}`);
    return;
  }
  logger.error(`Uncaught Exception: ${err?.stack || err}`);
  process.exit(1);
});

const parsedPort = parseInt(process.env.PORTAL_PORT || process.env.PORT || '3000', 10);
const port = isNaN(parsedPort) ? 3000 : parsedPort;

const parsedGuestAuthDuration = parseInt(process.env.GUEST_AUTH_DURATION || '1440', 10);
const guestAuthDuration = isNaN(parsedGuestAuthDuration) ? 1440 : parsedGuestAuthDuration;

const unifi = new UnifiClient({
  url: process.env.UNIFI_CONTROLLER_URL || '',
  username: process.env.UNIFI_USERNAME || '',
  password: process.env.UNIFI_PASSWORD || '',
  site: process.env.UNIFI_SITE || 'default',
  apiKey: process.env.UNIFI_API_KEY || ''
});

export const slack = new SlackIntegration({
  botToken: process.env.SLACK_BOT_TOKEN || '',
  appToken: process.env.SLACK_APP_TOKEN || '',
  channelId: process.env.SLACK_CHANNEL_ID || '',
  guestAuthDuration,
  pkiInternalUrl: process.env.PKI_INTERNAL_URL || 'http://127.0.0.1:8000',
  internalApiSecret: process.env.INTERNAL_API_SECRET || '',
  enabled: slackEnabled
}, store, unifi);

export const app = createServer(store);

// Hook guest_registered event to trigger Slack message and forward to PKI dashboard
(app as any).on('guest_registered', async (request: GuestRequest) => {
  if (slackEnabled) {
    try {
      await slack.postApprovalMessage(request);
    } catch (err: any) {
      logger.error(`Failed to post Slack approval message: ${err.message || err}`);
    }
  } else {
    logger.info('Slack notifications disabled. Skipping message dispatch for MAC: ' + request.mac);
  }

  // Forward pending request to PKI internal backend
  const pkiUrl = process.env.PKI_INTERNAL_URL || 'http://127.0.0.1:8000';
  const secret = process.env.INTERNAL_API_SECRET || '';
  if (pkiUrl) {
    const endpoint = `${pkiUrl.replace(/\/+$/, '')}/api/internal/guest-requested`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (secret) headers['X-Internal-Secret'] = secret;

    const axios = require('axios');
    axios.post(endpoint, {
      mac: request.mac,
      name: request.name,
      reason: request.reason,
      duration_minutes: request.durationMinutes || 1440,
      requested_at: Math.floor(request.createdAt / 1000)
    }, { headers, timeout: 5000 }).catch((err: any) => {
      logger.warn(`Failed to notify PKI of pending guest registration: ${err.message || err}`);
    });
  }
});

(app as any).on('guest_resolved_remotely', async (data: any) => {
  if (!slackEnabled) return;
  try {
    await slack.updateRemoteResolution(data.mac, data.status, data.processedBy, data.durationMinutes);
  } catch (err: any) {
    logger.warn(`Failed to update Slack for remotely resolved guest: ${err.message || err}`);
  }
});

async function main() {
  // Start Slack client gracefully
  if (slackEnabled) {
    try {
      await slack.start();
    } catch (err: any) {
      logger.error('CRITICAL WARNING: Failed to start Slack Socket Mode client. Check that your SLACK_BOT_TOKEN (xoxb-...) and SLACK_APP_TOKEN (xapp-...) are set correctly inside /etc/unifi-guest-portal/config.env.');
      logger.error(err.message || err);
    }
  }

  // Start Express server
  const host = process.env.PORTAL_HOST || process.env.HOST || '0.0.0.0';
  app.listen(port, host, () => {
    logger.info(`unifi-guest-portal server running on ${host}:${port}`);
  });
}

if (require.main === module) {
  main().catch(err => logger.error(`Fatal startup error: ${err}`));
}
