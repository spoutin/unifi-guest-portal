import { appVersion } from '../src/index';

describe('App Scaffolding', () => {
  it('should export the correct version', () => {
    expect(appVersion).toBe('1.0.0-alpha');
  });
});
