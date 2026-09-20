import dotenv from 'dotenv';
import { createServer } from './server';
import { store, GuestRequest } from './store';
import { UnifiClient } from './unifi';
import { SlackIntegration } from './slack';

dotenv.config({ path: process.env.CONFIG_PATH || '.env' });

export const appVersion = '1.0.0-alpha';

const port = parseInt(process.env.PORT || '3000', 10);

const unifi = new UnifiClient({
  url: process.env.UNIFI_CONTROLLER_URL || '',
  username: process.env.UNIFI_USERNAME || '',
  password: process.env.UNIFI_PASSWORD || '',
  site: process.env.UNIFI_SITE || 'default'
});

const slack = new SlackIntegration({
  botToken: process.env.SLACK_BOT_TOKEN || '',
  appToken: process.env.SLACK_APP_TOKEN || '',
  channelId: process.env.SLACK_CHANNEL_ID || ''
}, store, unifi);

const app = createServer(store);

// Hook guest_registered event to trigger Slack message
(app as any).on('guest_registered', async (request: GuestRequest) => {
  try {
    await slack.postApprovalMessage(request);
  } catch (err) {
    console.error('Failed to post Slack approval message:', err);
  }
});

async function main() {
  // Start Slack client
  await slack.start();

  // Start Express server
  app.listen(port, '0.0.0.0', () => {
    console.log(`unifi-guest-portal server running on port ${port}`);
  });
}

if (require.main === module) {
  main().catch(console.error);
}
