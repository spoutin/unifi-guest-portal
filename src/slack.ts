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

import axios from 'axios';

export interface SlackConfig {
  botToken: string;
  appToken: string;
  channelId: string;
  guestAuthDuration?: number;
  pkiInternalUrl?: string;
  internalApiSecret?: string;
}

function formatDuration(minutes: number): string {
  if (minutes % 1440 === 0) {
    const days = minutes / 1440;
    return `${days} ${days === 1 ? 'day' : 'days'}`;
  }
  const hours = Math.round(minutes / 60);
  return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
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
    const durationMinutes = request.durationMinutes || this.config.guestAuthDuration || 1440;
    const durationLabel = formatDuration(durationMinutes);

    logger.info(`Posting guest Wi-Fi approval request to Slack for MAC: ${request.mac}`);
    const res = await this.app.client.chat.postMessage({
      channel: this.config.channelId,
      text: `New WiFi Guest Request from ${escapedName}`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*New WiFi Access Request*\n*Name:* ${escapedName}\n*Reason:* ${escapedReason}\n*MAC Address:* \`${request.mac}\`\n*Requested Duration:* ${durationLabel}`
          }
        },
        {
          type: 'actions',
          block_id: `approve_actions_${request.mac}`,
          elements: [
            {
              type: 'static_select',
              action_id: 'duration_select',
              placeholder: { type: 'plain_text', text: 'Duration' },
              initial_option: {
                text: { type: 'plain_text', text: durationLabel },
                value: durationMinutes.toString()
              },
              options: [1, 2, 3, 4, 5, 6, 7].map(d => ({
                text: { type: 'plain_text', text: `${d} ${d === 1 ? 'day' : 'days'}` },
                value: (d * 1440).toString()
              }))
            },
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
    if (res && res.ts) {
      (request as any).slackMessageTs = res.ts;
    }
  }

  public async updateRemoteResolution(mac: string, status: 'approved' | 'denied', admin: string, durationMinutes?: number): Promise<void> {
    const guestReq = this.store.getRequestByMac(mac);
    const ts = (guestReq as any)?.slackMessageTs;
    if (!ts) return;

    const nameLine = guestReq ? `\n*Name:* ${escapeSlack(guestReq.name)}` : '';
    const reasonLine = guestReq ? `\n*Reason:* ${escapeSlack(guestReq.reason)}` : '';
    const duration = durationMinutes || guestReq?.durationMinutes || this.config.guestAuthDuration || 1440;
    const durationLine = `\n*Duration:* ${formatDuration(duration)}`;

    try {
      if (status === 'approved') {
        await this.app.client.chat.update({
          channel: this.config.channelId,
          ts,
          text: `Approved guest ${mac}`,
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `✅ *WiFi Request Approved*${nameLine}${reasonLine}${durationLine}\n*MAC Address:* \`${mac}\`\n*Approved By:* @${admin} (Web Dashboard)\n*UniFi Status:* Authorized successfully`
              }
            }
          ]
        });
      } else {
        await this.app.client.chat.update({
          channel: this.config.channelId,
          ts,
          text: `Denied guest ${mac}`,
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `❌ *WiFi Request Denied*${nameLine}${reasonLine}\n*MAC Address:* \`${mac}\`\n*Denied By:* @${admin} (Web Dashboard)`
              }
            }
          ]
        });
      }
    } catch (err: any) {
      logger.warn(`Could not update Slack message for remotely resolved MAC ${mac}: ${err.message || err}`);
    }
  }

  private registerActions(): void {
    // Duration Select Action Handler (Slack override before approval)
    this.app.action('duration_select', async ({ ack, action }: any) => {
      await ack();
      const selectedValue = action?.selected_option?.value;
      const blockId = action?.block_id || '';
      const macMatch = blockId.match(/^approve_actions_(.+)$/);
      if (selectedValue && macMatch) {
        const mac = macMatch[1];
        const newMinutes = parseInt(selectedValue, 10);
        if (!isNaN(newMinutes)) {
          this.store.updateRequestDuration(mac, newMinutes);
          logger.info(`Updated requested duration for MAC: ${mac} to ${newMinutes} minutes via Slack select`);
        }
      }
    });

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
        const guestReq = this.store.getRequestByMac(mac);
        const nameLine = guestReq ? `\n*Name:* ${escapeSlack(guestReq.name)}` : '';
        const reasonLine = guestReq ? `\n*Reason:* ${escapeSlack(guestReq.reason)}` : '';

        // Authorize on UniFi (using request's durationMinutes or config fallback)
        const duration = (guestReq && guestReq.durationMinutes !== undefined) ? guestReq.durationMinutes : (this.config.guestAuthDuration || 1440);
        const durationLine = `\n*Duration:* ${formatDuration(duration)}`;
        const success = await this.unifi.authorizeGuest(mac, duration);

        if (success) {
          this.store.updateRequestStatus(mac, 'approved', admin);
          logger.info(`MAC ${mac} successfully approved by @${admin} for ${duration}m and authorized on the UniFi Controller.`);

          // Notify PKI internal backend if configured
          if (this.config.pkiInternalUrl) {
            const endpoint = `${this.config.pkiInternalUrl.replace(/\/+$/, '')}/api/internal/guest-authorized`;
            const now = Math.floor(Date.now() / 1000);
            const headers: Record<string, string> = { 'Content-Type': 'application/json' };
            if (this.config.internalApiSecret) {
              headers['X-Internal-Secret'] = this.config.internalApiSecret;
            }
            axios.post(endpoint, {
              mac,
              name: guestReq?.name || 'Unknown',
              reason: guestReq?.reason || 'Guest Access',
              duration_minutes: duration,
              approved_by: admin,
              approved_at: now,
              expires_at: now + duration * 60
            }, { headers, timeout: 5000 }).catch(err => {
              logger.warn(`Failed to notify PKI internal endpoint: ${err.message || err}`);
            });
          }

          await respond({
            text: `Approved guest ${mac}`,
            blocks: [
              {
                type: 'section',
                text: {
                  type: 'mrkdwn',
                  text: `✅ *WiFi Request Approved*${nameLine}${reasonLine}${durationLine}\n*MAC Address:* \`${mac}\`\n*Approved By:* @${admin}\n*UniFi Status:* Authorized successfully`
                }
              }
            ]
          });
        } else {
          this.store.updateRequestStatus(mac, 'denied', admin);
          logger.warn(`MAC ${mac} authorization FAILED on the UniFi Controller. Reverting state to denied.`);
          await respond({
            text: `WiFi Approval Failed for ${mac}`,
            blocks: [
              {
                type: 'section',
                text: {
                  type: 'mrkdwn',
                  text: `⚠️ *WiFi Approval Failed*${nameLine}${reasonLine}\n*MAC Address:* \`${mac}\`\n*Attempted By:* @${admin}\n*Error:* Could not authorize client on the UniFi Controller. Check the container's logs (\`journalctl -u unifi-guest-portal\`) for timing details.`
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
        const guestReq = this.store.getRequestByMac(mac);
        const nameLine = guestReq ? `\n*Name:* ${escapeSlack(guestReq.name)}` : '';
        const reasonLine = guestReq ? `\n*Reason:* ${escapeSlack(guestReq.reason)}` : '';

        this.store.updateRequestStatus(mac, 'denied', admin);
        logger.info(`MAC ${mac} was denied Wi-Fi access by @${admin}.`);

        await respond({
          text: `Denied guest ${mac}`,
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `❌ *WiFi Request Denied*${nameLine}${reasonLine}\n*MAC Address:* \`${mac}\`\n*Denied By:* @${admin}`
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
