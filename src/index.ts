import dotenv from 'dotenv';
import { createServer } from './server';
import { store, GuestRequest } from './store';
import { UnifiClient } from './unifi';
import { SlackIntegration } from './slack';

dotenv.config({ path: process.env.CONFIG_PATH || '.env' });

export const appVersion = '1.0.0-alpha';

const parsedPort = parseInt(process.env.PORT || '3000', 10);
const port = isNaN(parsedPort) ? 3000 : parsedPort;

const parsedGuestAuthDuration = parseInt(process.env.GUEST_AUTH_DURATION || '1440', 10);
const guestAuthDuration = isNaN(parsedGuestAuthDuration) ? 1440 : parsedGuestAuthDuration;

const unifi = new UnifiClient({
  url: process.env.UNIFI_CONTROLLER_URL || '',
  username: process.env.UNIFI_USERNAME || '',
  password: process.env.UNIFI_PASSWORD || '',
  site: process.env.UNIFI_SITE || 'default'
});

const slack = new SlackIntegration({
  botToken: process.env.SLACK_BOT_TOKEN || '',
  appToken: process.env.SLACK_APP_TOKEN || '',
  channelId: process.env.SLACK_CHANNEL_ID || '',
  guestAuthDuration
}, store, unifi);

const app = createServer(store);

const host = process.env.HOST || '0.0.0.0';

// Hook guest_registered event to trigger Slack message
(app as any).on('guest_registered', async (request: GuestRequest) => {
  try {
    await slack.postApprovalMessage(request);
  } catch (err) {
    console.error('Failed to post Slack approval message:', err);
  }
});

async function main() {
  // Start Slack client gracefully
  try {
    await slack.start();
  } catch (err) {
    console.error('CRITICAL WARNING: Failed to start Slack Socket Mode client. Check that your SLACK_BOT_TOKEN (xoxb-...) and SLACK_APP_TOKEN (xapp-...) are set correctly inside /etc/unifi-guest-portal/config.env.');
    console.error(err);
  }

  // Start Express server
  app.listen(port, host, () => {
    console.log(`unifi-guest-portal server running on ${host}:${port}`);
  });
}

if (require.main === module) {
  main().catch(console.error);
}
