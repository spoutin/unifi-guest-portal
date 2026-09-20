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

  it('should post an approval message with correct Block Kit blocks', async () => {
    const request = store.createRequest('00:11:22:33:44:55', 'AP-1', 'http://original-url', 'John Doe', 'Business meeting');
    await slack.postApprovalMessage(request);

    expect(mockPostMessage).toHaveBeenCalledTimes(1);
    const postArgs = mockPostMessage.mock.calls[0][0];
    expect(postArgs.channel).toBe('C123');
    expect(postArgs.text).toBe('New WiFi Guest Request from John Doe');
    expect(postArgs.blocks).toBeDefined();
    expect(postArgs.blocks[0].text.text).toContain('John Doe');
    expect(postArgs.blocks[0].text.text).toContain('Business meeting');
    expect(postArgs.blocks[0].text.text).toContain('00:11:22:33:44:55');
    
    const actionsBlock = postArgs.blocks[1];
    expect(actionsBlock.block_id).toBe('approve_actions_00:11:22:33:44:55');
    expect(actionsBlock.elements[0].action_id).toBe('approve_btn');
    expect(actionsBlock.elements[0].value).toBe('00:11:22:33:44:55');
    expect(actionsBlock.elements[1].action_id).toBe('deny_btn');
    expect(actionsBlock.elements[1].value).toBe('00:11:22:33:44:55');
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

    expect(ack).toHaveBeenCalledTimes(1);
    expect(store.getRequestByMac(mac)?.status).toBe('approved');
    expect(authorizeSpy).toHaveBeenCalledWith(mac, 1440);
    expect(respond).toHaveBeenCalledTimes(1);
    const respondArgs = respond.mock.calls[0][0];
    expect(respondArgs.text).toContain(`Approved guest ${mac}`);
    expect(respondArgs.blocks[0].text.text).toContain('✅ *WiFi Request Approved*');
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

    expect(ack).toHaveBeenCalledTimes(1);
    expect(store.getRequestByMac(mac)?.status).toBe('approved');
    expect(authorizeSpy).toHaveBeenCalledWith(mac, 1440);
    expect(respond).toHaveBeenCalledTimes(1);
    const respondArgs = respond.mock.calls[0][0];
    expect(respondArgs.blocks[0].text.text).toContain('Failed to Auth');
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

    expect(ack).toHaveBeenCalledTimes(1);
    expect(store.getRequestByMac(mac)?.status).toBe('denied');
    expect(respond).toHaveBeenCalledTimes(1);
    const respondArgs = respond.mock.calls[0][0];
    expect(respondArgs.text).toContain(`Denied guest ${mac}`);
    expect(respondArgs.blocks[0].text.text).toContain('❌ *WiFi Request Denied*');
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

    expect(ack).toHaveBeenCalledTimes(1);
    expect(authorizeSpy).toHaveBeenCalledWith(mac, 480);
  });
});
