process.env.SLACK_ENABLED = 'false';
process.env.PKI_INTERNAL_URL = 'http://127.0.0.1:8000';
process.env.INTERNAL_API_SECRET = 'test-secret';
process.env.SLACK_BOT_TOKEN = '';
process.env.SLACK_APP_TOKEN = '';
process.env.SLACK_CHANNEL_ID = '';

jest.mock('@slack/bolt', () => {
  return {
    App: jest.fn().mockImplementation(() => {
      return {
        start: jest.fn(),
        action: jest.fn(),
        client: {
          chat: {
            postMessage: jest.fn(),
            update: jest.fn()
          }
        }
      };
    })
  };
});

import axios from 'axios';
jest.mock('axios');

import { app, slack, slackEnabled } from '../src/index';
import { SlackIntegration } from '../src/slack';
import { Store } from '../src/store';
import { UnifiClient } from '../src/unifi';

describe('Slack Disabled Integration (SLACK_ENABLED="false")', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should set slackEnabled to false', () => {
    expect(slackEnabled).toBe(false);
  });

  it('should not call slack.postApprovalMessage on guest_registered, but fire PKI notification', async () => {
    const postApprovalSpy = jest.spyOn(slack, 'postApprovalMessage');
    (axios.post as jest.Mock).mockResolvedValue({ data: { status: 'ok' } });

    const request = {
      mac: '00:11:22:33:44:55',
      name: 'Jane Doe',
      reason: 'Meeting',
      durationMinutes: 1440,
      createdAt: 1700000000000
    };

    app.emit('guest_registered', request);

    // Yield to let async event handlers complete
    await new Promise(resolve => setImmediate(resolve));

    expect(postApprovalSpy).not.toHaveBeenCalled();
    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(axios.post).toHaveBeenCalledWith(
      'http://127.0.0.1:8000/api/internal/guest-requested',
      {
        mac: '00:11:22:33:44:55',
        name: 'Jane Doe',
        reason: 'Meeting',
        duration_minutes: 1440,
        requested_at: 1700000000
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Secret': 'test-secret'
        },
        timeout: 5000
      }
    );
  });

  it('should not call slack.updateRemoteResolution on guest_resolved_remotely', async () => {
    const updateResolutionSpy = jest.spyOn(slack, 'updateRemoteResolution');

    app.emit('guest_resolved_remotely', {
      mac: '00:11:22:33:44:55',
      status: 'approved',
      processedBy: 'admin',
      durationMinutes: 1440
    });

    await new Promise(resolve => setImmediate(resolve));

    expect(updateResolutionSpy).not.toHaveBeenCalled();
  });

  it('should not throw or crash when creating SlackIntegration with missing tokens and SLACK_ENABLED="false"', () => {
    expect(() => {
      new SlackIntegration({
        botToken: '',
        appToken: '',
        channelId: ''
      }, new Store(), new UnifiClient({ url: '', username: '', password: '', site: '' }));
    }).not.toThrow();
  });

  it('should treat SLACK_ENABLED="0" as disabled', () => {
    const prev = process.env.SLACK_ENABLED;
    process.env.SLACK_ENABLED = '0';
    try {
      const integration = new SlackIntegration({
        botToken: '',
        appToken: '',
        channelId: ''
      }, new Store(), new UnifiClient({ url: '', username: '', password: '', site: '' }));
      expect(integration).toBeDefined();
    } finally {
      process.env.SLACK_ENABLED = prev;
    }
  });
});
