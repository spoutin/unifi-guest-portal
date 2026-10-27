import { SlackIntegration } from '../src/slack';
import { Store } from '../src/store';
import { UnifiClient } from '../src/unifi';

const mockActionCallbacks: { [actionId: string]: Function } = {};
const mockPostMessage = jest.fn();

jest.mock('@slack/bolt', () => {
  return {
    App: jest.fn().mockImplementation(() => {
      return {
        start: jest.fn(),
        action: jest.fn().mockImplementation((actionId, callback) => {
          mockActionCallbacks[actionId] = callback;
        }),
        client: {
          chat: {
            postMessage: mockPostMessage
          }
        }
      };
    })
  };
});

describe('SlackIntegration', () => {
  let store: Store;
  let unifi: UnifiClient;
  let slack: SlackIntegration;

  beforeEach(() => {
    jest.clearAllMocks();
    Object.keys(mockActionCallbacks).forEach(key => delete mockActionCallbacks[key]);

    store = new Store();
    unifi = new UnifiClient({ url: 'http://foo', username: 'u', password: 'p', site: 'default' });
    slack = new SlackIntegration({
      botToken: 'xoxb-test',
      appToken: 'xapp-test',
      channelId: 'C123'
    }, store, unifi);
  });

  it('should initialize and register listeners', () => {
    expect(slack).toBeDefined();
    expect(mockActionCallbacks['approve_btn']).toBeDefined();
    expect(mockActionCallbacks['deny_btn']).toBeDefined();
  });

  it('should post an approval message with correct Block Kit blocks including duration and override dropdown', async () => {
    const request = store.createRequest('00:11:22:33:44:55', 'AP-1', 'http://original-url', 'John Doe', 'Business meeting', 4320);
    await slack.postApprovalMessage(request);

    expect(mockPostMessage).toHaveBeenCalledTimes(1);
    const postArgs = mockPostMessage.mock.calls[0][0];
    expect(postArgs.channel).toBe('C123');
    expect(postArgs.text).toBe('New WiFi Guest Request from John Doe');
    expect(postArgs.blocks).toBeDefined();
    expect(postArgs.blocks[0].text.text).toContain('John Doe');
    expect(postArgs.blocks[0].text.text).toContain('Business meeting');
    expect(postArgs.blocks[0].text.text).toContain('00:11:22:33:44:55');
    expect(postArgs.blocks[0].text.text).toContain('*Requested Duration:* 3 days');
    
    const actionsBlock = postArgs.blocks[1];
    expect(actionsBlock.block_id).toBe('approve_actions_00:11:22:33:44:55');
    expect(actionsBlock.elements[0].action_id).toBe('duration_select');
    expect(actionsBlock.elements[0].initial_option.value).toBe('4320');
    expect(actionsBlock.elements[1].action_id).toBe('approve_btn');
    expect(actionsBlock.elements[1].value).toBe('00:11:22:33:44:55');
    expect(actionsBlock.elements[2].action_id).toBe('deny_btn');
    expect(actionsBlock.elements[2].value).toBe('00:11:22:33:44:55');
  });

  it('should allow overriding duration via duration_select action before approving', async () => {
    const mac = '00:11:22:33:44:55';
    store.createRequest(mac, 'AP-1', 'http://original-url', 'John Doe', 'Business meeting', 1440);

    const authorizeSpy = jest.spyOn(unifi, 'authorizeGuest').mockResolvedValue(true);
    const ack = jest.fn();
    const respond = jest.fn();

    // Trigger duration select action
    const durationCallback = mockActionCallbacks['duration_select'];
    expect(durationCallback).toBeDefined();
    await durationCallback({
      ack,
      action: {
        type: 'static_select',
        selected_option: { value: '7200' },
        block_id: `approve_actions_${mac}`
      },
      body: {}
    });

    expect(ack).toHaveBeenCalled();
    expect(store.getRequestByMac(mac)?.durationMinutes).toBe(7200);

    // Now click approve
    const approveCallback = mockActionCallbacks['approve_btn'];
    await approveCallback({
      ack,
      action: { type: 'button', value: mac },
      body: { user: { name: 'admin_user' } },
      respond
    });
    await (slack as any).app.lastActionTask;

    expect(authorizeSpy).toHaveBeenCalledWith(mac, 7200);
    const respondArgs = respond.mock.calls[0][0];
    expect(respondArgs.blocks[0].text.text).toContain('*Duration:* 5 days');
  });

  it('should escape Slack special characters in guest-submitted fields to prevent injection', async () => {
    const maliciousName = '<@U12345> & <!channel>';
    const maliciousReason = 'Need <WiFi> & Fun';
    const request = store.createRequest('00:11:22:33:44:55', 'AP-1', 'http://original-url', maliciousName, maliciousReason);
    await slack.postApprovalMessage(request);

    expect(mockPostMessage).toHaveBeenCalledTimes(1);
    const postArgs = mockPostMessage.mock.calls[0][0];
    expect(postArgs.text).toBe('New WiFi Guest Request from &lt;@U12345&gt; &amp; &lt;!channel&gt;');
    expect(postArgs.blocks[0].text.text).toContain('&lt;@U12345&gt; &amp; &lt;!channel&gt;');
    expect(postArgs.blocks[0].text.text).toContain('Need &lt;WiFi&gt; &amp; Fun');
  });

  it('should handle approve button click, update store status, call Unifi authorization and respond with success message', async () => {
    // Setup request in store
    const mac = '00:11:22:33:44:55';
    store.createRequest(mac, 'AP-1', 'http://original-url', 'John Doe', 'Business meeting');

    // Spy/Mock Unifi authorizeGuest
    const authorizeSpy = jest.spyOn(unifi, 'authorizeGuest').mockResolvedValue(true);

    const ack = jest.fn();
    const respond = jest.fn();
    const action = { type: 'button', value: mac };
    const body = { user: { name: 'admin_user' } };

    // Trigger registered callback
    const approveCallback = mockActionCallbacks['approve_btn'];
    await approveCallback({ ack, action, body, respond });
    await (slack as any).app.lastActionTask;

    expect(ack).toHaveBeenCalledTimes(1);
    expect(store.getRequestByMac(mac)?.status).toBe('approved');
    expect(authorizeSpy).toHaveBeenCalledWith(mac, 1440);
    expect(respond).toHaveBeenCalledTimes(1);
    const respondArgs = respond.mock.calls[0][0];
    expect(respondArgs.text).toContain(`Approved guest ${mac}`);
    expect(respondArgs.blocks[0].text.text).toContain('✅ *WiFi Request Approved*');
    expect(respondArgs.blocks[0].text.text).toContain('*Name:* John Doe');
    expect(respondArgs.blocks[0].text.text).toContain('*Reason:* Business meeting');
    expect(respondArgs.blocks[0].text.text).toContain('@admin_user');
    expect(respondArgs.blocks[0].text.text).toContain('Authorized');
  });

  it('should handle approve button click when UniFi authorization fails', async () => {
    const mac = '00:11:22:33:44:55';
    store.createRequest(mac, 'AP-1', 'http://original-url', 'John Doe', 'Business');
    const authorizeSpy = jest.spyOn(unifi, 'authorizeGuest').mockResolvedValue(false);

    const ack = jest.fn();
    const respond = jest.fn();
    const action = { type: 'button', value: mac };
    const body = { user: { name: 'admin_user' } };

    const approveCallback = mockActionCallbacks['approve_btn'];
    await approveCallback({ ack, action, body, respond });
    await (slack as any).app.lastActionTask;

    expect(ack).toHaveBeenCalledTimes(1);
    expect(store.getRequestByMac(mac)?.status).toBe('denied');
    expect(authorizeSpy).toHaveBeenCalledWith(mac, 1440);
    expect(respond).toHaveBeenCalledTimes(1);
    const respondArgs = respond.mock.calls[0][0];
    expect(respondArgs.blocks[0].text.text).toContain('Failed');
    expect(respondArgs.blocks[0].text.text).toContain('*Name:* John Doe');
    expect(respondArgs.blocks[0].text.text).toContain('*Reason:* Business');
  });

  it('should handle deny button click, update store status and respond with denied message', async () => {
    const mac = '00:11:22:33:44:55';
    store.createRequest(mac, 'AP-1', 'http://original-url', 'John Doe', 'Business meeting');

    const ack = jest.fn();
    const respond = jest.fn();
    const action = { type: 'button', value: mac };
    const body = { user: { name: 'admin_user' } };

    const denyCallback = mockActionCallbacks['deny_btn'];
    await denyCallback({ ack, action, body, respond });
    await (slack as any).app.lastActionTask;

    expect(ack).toHaveBeenCalledTimes(1);
    expect(store.getRequestByMac(mac)?.status).toBe('denied');
    expect(respond).toHaveBeenCalledTimes(1);
    const respondArgs = respond.mock.calls[0][0];
    expect(respondArgs.text).toContain(`Denied guest ${mac}`);
    expect(respondArgs.blocks[0].text.text).toContain('❌ *WiFi Request Denied*');
    expect(respondArgs.blocks[0].text.text).toContain('*Name:* John Doe');
    expect(respondArgs.blocks[0].text.text).toContain('*Reason:* Business meeting');
    expect(respondArgs.blocks[0].text.text).toContain('@admin_user');
  });

  it('should use custom guestAuthDuration if provided in SlackConfig', async () => {
    const customSlack = new SlackIntegration({
      botToken: 'xoxb-test',
      appToken: 'xapp-test',
      channelId: 'C123',
      guestAuthDuration: 480
    }, store, unifi);

    const mac = '00:11:22:33:44:55';
    store.createRequest(mac, 'AP-1', 'http://original-url', 'John Doe', 'Business meeting');

    const authorizeSpy = jest.spyOn(unifi, 'authorizeGuest').mockResolvedValue(true);

    const ack = jest.fn();
    const respond = jest.fn();
    const action = { type: 'button', value: mac };
    const body = { user: { name: 'admin_user' } };

    const approveCallback = mockActionCallbacks['approve_btn'];
    await approveCallback({ ack, action, body, respond });
    await (customSlack as any).app.lastActionTask;

    expect(ack).toHaveBeenCalledTimes(1);
    expect(authorizeSpy).toHaveBeenCalledWith(mac, 480);
  });

  it('should preserve and escape guest name and reason in approval and denial responses', async () => {
    const mac = '00:11:22:33:44:55';
    store.createRequest(mac, 'AP-1', 'http://original-url', '<Alice> & Co', 'Coffee & <Chat>');

    jest.spyOn(unifi, 'authorizeGuest').mockResolvedValue(true);
    const ack = jest.fn();
    const respond = jest.fn();
    const action = { type: 'button', value: mac };
    const body = { user: { name: 'admin_user' } };

    const approveCallback = mockActionCallbacks['approve_btn'];
    await approveCallback({ ack, action, body, respond });
    await (slack as any).app.lastActionTask;

    const approveRespondArgs = respond.mock.calls[0][0];
    expect(approveRespondArgs.blocks[0].text.text).toContain('*Name:* &lt;Alice&gt; &amp; Co');
    expect(approveRespondArgs.blocks[0].text.text).toContain('*Reason:* Coffee &amp; &lt;Chat&gt;');
  });

  it('should notify PKI internal endpoint with auth headers on successful approval if configured', async () => {
    const axios = require('axios');
    const axiosPostSpy = jest.spyOn(axios, 'post').mockResolvedValue({ data: { success: true } });

    const pkiSlack = new SlackIntegration({
      botToken: 'xoxb-test',
      appToken: 'xapp-test',
      channelId: 'C123',
      pkiInternalUrl: 'http://127.0.0.1:8000',
      internalApiSecret: 'super-secret-token'
    }, store, unifi);

    const mac = '00:11:22:33:44:55';
    store.createRequest(mac, 'AP-1', 'http://original-url', 'Alice', 'Visit', 1440);
    jest.spyOn(unifi, 'authorizeGuest').mockResolvedValue(true);

    const ack = jest.fn();
    const respond = jest.fn();
    const action = { type: 'button', value: mac };
    const body = { user: { name: 'admin_user' } };

    const approveCallback = mockActionCallbacks['approve_btn'];
    await approveCallback({ ack, action, body, respond });
    await (pkiSlack as any).app.lastActionTask;

    expect(axiosPostSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:8000/api/internal/guest-authorized',
      expect.objectContaining({
        mac: '00:11:22:33:44:55',
        name: 'Alice',
        reason: 'Visit',
        duration_minutes: 1440,
        approved_by: 'admin_user',
        approved_at: expect.any(Number),
        expires_at: expect.any(Number)
      }),
      expect.objectContaining({
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          'X-Internal-Secret': 'super-secret-token',
          'Authorization': 'Bearer super-secret-token'
        })
      })
    );

    const payload = axiosPostSpy.mock.calls[0][1] as any;
    expect(payload.expires_at).toBe(payload.approved_at + 1440 * 60);
  });

  it('should handle PKI notification error on approval without crashing Slack handler', async () => {
    const axios = require('axios');
    jest.spyOn(axios, 'post').mockRejectedValue(new Error('Network error to PKI'));

    const pkiSlack = new SlackIntegration({
      botToken: 'xoxb-test',
      appToken: 'xapp-test',
      channelId: 'C123',
      pkiInternalUrl: 'http://127.0.0.1:8000',
      internalApiSecret: 'super-secret-token'
    }, store, unifi);

    const mac = '00:11:22:33:44:55';
    store.createRequest(mac, 'AP-1', 'http://original-url', 'Alice', 'Visit', 1440);
    jest.spyOn(unifi, 'authorizeGuest').mockResolvedValue(true);

    const ack = jest.fn();
    const respond = jest.fn();
    const action = { type: 'button', value: mac };
    const body = { user: { name: 'admin_user' } };

    const approveCallback = mockActionCallbacks['approve_btn'];
    await approveCallback({ ack, action, body, respond });
    await (pkiSlack as any).app.lastActionTask;

    expect(respond).toHaveBeenCalledTimes(1);
    const respondArgs = respond.mock.calls[0][0];
    expect(respondArgs.blocks[0].text.text).toContain('✅ *WiFi Request Approved*');
  });

  it('should notify PKI internal status endpoint with auth headers on denial if configured', async () => {
    const axios = require('axios');
    const axiosPostSpy = jest.spyOn(axios, 'post').mockResolvedValue({ data: { success: true } });

    const pkiSlack = new SlackIntegration({
      botToken: 'xoxb-test',
      appToken: 'xapp-test',
      channelId: 'C123',
      pkiInternalUrl: 'http://127.0.0.1:8000',
      internalApiSecret: 'super-secret-token'
    }, store, unifi);

    const mac = '00:11:22:33:44:55';
    store.createRequest(mac, 'AP-1', 'http://original-url', 'Bob', 'Visit', 1440);

    const ack = jest.fn();
    const respond = jest.fn();
    const action = { type: 'button', value: mac };
    const body = { user: { name: 'admin_user' } };

    const denyCallback = mockActionCallbacks['deny_btn'];
    await denyCallback({ ack, action, body, respond });
    await (pkiSlack as any).app.lastActionTask;

    expect(axiosPostSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:8000/api/internal/guest/00:11:22:33:44:55/status',
      {
        status: 'denied',
        processedBy: 'admin_user'
      },
      expect.objectContaining({
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          'X-Internal-Secret': 'super-secret-token',
          'Authorization': 'Bearer super-secret-token'
        })
      })
    );
    expect(respond).toHaveBeenCalledTimes(1);
    expect(respond.mock.calls[0][0].blocks[0].text.text).toContain('❌ *WiFi Request Denied*');
  });

  it('should handle PKI notification error on denial without crashing Slack handler', async () => {
    const axios = require('axios');
    jest.spyOn(axios, 'post').mockRejectedValue(new Error('Connection refused'));

    const pkiSlack = new SlackIntegration({
      botToken: 'xoxb-test',
      appToken: 'xapp-test',
      channelId: 'C123',
      pkiInternalUrl: 'http://127.0.0.1:8000',
      internalApiSecret: 'super-secret-token'
    }, store, unifi);

    const mac = '00:11:22:33:44:55';
    store.createRequest(mac, 'AP-1', 'http://original-url', 'Bob', 'Visit', 1440);

    const ack = jest.fn();
    const respond = jest.fn();
    const action = { type: 'button', value: mac };
    const body = { user: { name: 'admin_user' } };

    const denyCallback = mockActionCallbacks['deny_btn'];
    await denyCallback({ ack, action, body, respond });
    await (pkiSlack as any).app.lastActionTask;

    expect(respond).toHaveBeenCalledTimes(1);
    expect(respond.mock.calls[0][0].blocks[0].text.text).toContain('❌ *WiFi Request Denied*');
  });
});
