import { Store } from '../src/store';

describe('Store', () => {
  it('should create, retrieve and update a guest request', () => {
    const store = new Store();
    const req = store.createRequest('00:aa:bb:cc:dd:ee', 'ap-1', 'http://example.com', 'Alice', 'Meeting');
    expect(req.status).toBe('pending');

    const retrieved = store.getRequestByMac('00:aa:bb:cc:dd:ee');
    expect(retrieved?.name).toBe('Alice');

    const updated = store.updateRequestStatus('00:aa:bb:cc:dd:ee', 'approved');
    expect(updated).toBe(true);
    expect(store.getRequestByMac('00:aa:bb:cc:dd:ee')?.status).toBe('approved');
  });
});
