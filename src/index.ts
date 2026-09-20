import dotenv from 'dotenv';
import { createServer } from './server';
import { store, GuestRequest } from './store';
import { UnifiClient } from './unifi';
import { SlackIntegration } from './slack';
import { logger } from './logger';

dotenv.config({ path: process.env.CONFIG_PATH || '.env' });

export const appVersion = '1.0.0-alpha.6';

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

const slack = new SlackIntegration({
  botToken: process.env.SLACK_BOT_TOKEN || '',
  appToken: process.env.SLACK_APP_TOKEN || '',
  channelId: process.env.SLACK_CHANNEL_ID || '',
  guestAuthDuration
}, store, unifi);

const app = createServer(store);

// Hook guest_registered event to trigger Slack message
(app as any).on('guest_registered', async (request: GuestRequest) => {
  try {
    await slack.postApprovalMessage(request);
  } catch (err: any) {
    logger.error(`Failed to post Slack approval message: ${err.message || err}`);
  }
});

async function main() {
  // Start Slack client gracefully
  try {
    await slack.start();
  } catch (err: any) {
    logger.error('CRITICAL WARNING: Failed to start Slack Socket Mode client. Check that your SLACK_BOT_TOKEN (xoxb-...) and SLACK_APP_TOKEN (xapp-...) are set correctly inside /etc/unifi-guest-portal/config.env.');
    logger.error(err.message || err);
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
