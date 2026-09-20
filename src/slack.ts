import { App } from '@slack/bolt';
import { Store, GuestRequest } from './store';
import { UnifiClient } from './unifi';
import { logger } from './logger';

export function escapeSlack(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export interface SlackConfig {
  botToken: string;
  appToken: string;
  channelId: string;
  guestAuthDuration?: number;
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
    logger.info('Slack Socket Mode client successfully connected.');
  }

  public async postApprovalMessage(request: GuestRequest): Promise<void> {
    const escapedName = escapeSlack(request.name);
    const escapedReason = escapeSlack(request.reason);

    logger.info(`Posting guest Wi-Fi approval request to Slack for MAC: ${request.mac}`);
    await this.app.client.chat.postMessage({
      channel: this.config.channelId,
      text: `New WiFi Guest Request from ${escapedName}`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*New WiFi Access Request*\n*Name:* ${escapedName}\n*Reason:* ${escapedReason}\n*MAC Address:* \`${request.mac}\``
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
      const admin = (body as any).user?.name || 'unknown';

      logger.info(`Slack interactive button 'approve_btn' clicked for MAC: ${mac} by Admin: @${admin}`);

      // Run heavy UniFi and network response tasks asynchronously in the background
      // to guarantee the Slack ack() frame is dispatched and received instantly (within 3s)
      const task = (async () => {
        // Authorize on UniFi (defaulting to 24 hours / 1440 mins)
        const duration = this.config.guestAuthDuration || 1440;
        const success = await this.unifi.authorizeGuest(mac, duration);

        if (success) {
          this.store.updateRequestStatus(mac, 'approved');
          logger.info(`MAC ${mac} successfully approved by @${admin} and authorized on the UniFi Controller.`);
          await respond({
            text: `Approved guest ${mac}`,
            blocks: [
              {
                type: 'section',
                text: {
                  type: 'mrkdwn',
                  text: `✅ *WiFi Request Approved*\n*MAC Address:* \`${mac}\`\n*Approved By:* @${admin}\n*UniFi Status:* Authorized successfully`
                }
              }
            ]
          });
        } else {
          this.store.updateRequestStatus(mac, 'denied');
          logger.warn(`MAC ${mac} authorization FAILED on the UniFi Controller. Reverting state to denied.`);
          await respond({
            text: `WiFi Approval Failed for ${mac}`,
            blocks: [
              {
                type: 'section',
                text: {
                  type: 'mrkdwn',
                  text: `⚠️ *WiFi Approval Failed*\n*MAC Address:* \`${mac}\`\n*Attempted By:* @${admin}\n*Error:* Could not authorize client on the UniFi Controller. Check the container's logs (\`journalctl -u unifi-guest-portal\`) for timing details.`
                }
              }
            ]
          });
        }
      })();

      (this.app as any).lastActionTask = task;
      task.catch(err => logger.error(`Error in Slack approve action background task: ${err}`));
    });

    // Deny Button Action Handler
    this.app.action('deny_btn', async ({ ack, action, body, respond }) => {
      await ack();
      if (action.type !== 'button') return;
      const mac = action.value;
      if (!mac) return;
      const admin = (body as any).user?.name || 'unknown';

      logger.info(`Slack interactive button 'deny_btn' clicked for MAC: ${mac} by Admin: @${admin}`);

      // Run asynchronously in background to prevent Slack timeout
      const task = (async () => {
        this.store.updateRequestStatus(mac, 'denied');
        logger.info(`MAC ${mac} was denied Wi-Fi access by @${admin}.`);

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
      })();

      (this.app as any).lastActionTask = task;
      task.catch(err => logger.error(`Error in Slack deny action background task: ${err}`));
    });
  }
}
