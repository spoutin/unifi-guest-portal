jest.mock('@slack/bolt', () => {
  return {
    App: jest.fn().mockImplementation(() => {
      return {
        start: jest.fn(),
        action: jest.fn(),
        client: {
          chat: {
            postMessage: jest.fn()
          }
        }
      };
    })
  };
});

import { appVersion } from '../src/index';

describe('App Scaffolding', () => {
  it('should export the correct version', () => {
    expect(appVersion).toBe('1.0.0-alpha.2');
  });
});
