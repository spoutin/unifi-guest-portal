import { App } from '@slack/bolt';
import { Store, GuestRequest } from './store';
import { UnifiClient } from './unifi';

export interface SlackConfig {
  botToken: string;
  appToken: string;
  channelId: string;
}

export class SlackIntegration {
  private app: App;
  private config: SlackConfig;
  private store: Store;
  private unifi: UnifiClient;

  constructor(config: SlackConfig, store: Store, unifi: UnifiClient) {
    this.config = config;
    this.store = store;
    this.unifi = unifi;

    this.app = new App({
      token: config.botToken,
      appToken: config.appToken,
      socketMode: true
    });

    this.registerActions();
  }

  public async start(): Promise<void> {
    await this.app.start();
    console.log('Slack Socket Mode client started.');
  }

  public async postApprovalMessage(request: GuestRequest): Promise<void> {
    await this.app.client.chat.postMessage({
      channel: this.config.channelId,
      text: `New WiFi Guest Request from ${request.name}`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*New WiFi Access Request*\n*Name:* ${request.name}\n*Reason:* ${request.reason}\n*MAC Address:* \`${request.mac}\``
          }
        },
        {
          type: 'actions',
          block_id: `approve_actions_${request.mac}`,
          elements: [
            {
              type: 'button',
              action_id: 'approve_btn',
              text: { type: 'plain_text', text: 'Approve' },
              style: 'primary',
              value: request.mac
            },
            {
              type: 'button',
              action_id: 'deny_btn',
              text: { type: 'plain_text', text: 'Deny' },
              style: 'danger',
              value: request.mac
            }
          ]
        }
      ]
    });
  }

  private registerActions(): void {
    // Approve Button Action Handler
    this.app.action('approve_btn', async ({ ack, action, body, respond }) => {
      await ack();
      if (action.type !== 'button') return;
      const mac = action.value;
      if (!mac) return;
      const admin = (body as any).user.name;

      this.store.updateRequestStatus(mac, 'approved');
      
      // Authorize on UniFi (defaulting to 24 hours / 1440 mins)
      const success = await this.unifi.authorizeGuest(mac, 1440);

      await respond({
        text: `Approved guest ${mac}`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `✅ *WiFi Request Approved*\n*MAC Address:* \`${mac}\`\n*Approved By:* @${admin}\n*UniFi Status:* ${success ? 'Authorized' : 'Failed to Auth'}`
            }
          }
        ]
      });
    });

    // Deny Button Action Handler
    this.app.action('deny_btn', async ({ ack, action, body, respond }) => {
      await ack();
      if (action.type !== 'button') return;
      const mac = action.value;
      if (!mac) return;
      const admin = (body as any).user.name;

      this.store.updateRequestStatus(mac, 'denied');

      await respond({
        text: `Denied guest ${mac}`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `❌ *WiFi Request Denied*\n*MAC Address:* \`${mac}\`\n*Denied By:* @${admin}`
            }
          }
        ]
      });
    });
  }
}
