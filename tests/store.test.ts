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

  it('should clean up expired requests on cleanup()', () => {
    const store = new Store();
    
    const baseTime = 1600000000000;
    const dateSpy = jest.spyOn(Date, 'now');

    // 1. Create a pending request that will expire (created 61 minutes ago)
    dateSpy.mockReturnValueOnce(baseTime - 61 * 60 * 1000);
    store.createRequest('00:11:22:33:44:01', 'ap-1', 'url', 'PendingExp', 'Test');

    // 2. Create an approved request that will expire (created 25 hours ago)
    dateSpy.mockReturnValueOnce(baseTime - 25 * 60 * 60 * 1000);
    store.createRequest('00:11:22:33:44:02', 'ap-1', 'url', 'ApprovedExp', 'Test');
    store.updateRequestStatus('00:11:22:33:44:02', 'approved');

    // 3. Create a denied request that will expire (created 25 hours ago)
    dateSpy.mockReturnValueOnce(baseTime - 25 * 60 * 60 * 1000);
    store.createRequest('00:11:22:33:44:03', 'ap-1', 'url', 'DeniedExp', 'Test');
    store.updateRequestStatus('00:11:22:33:44:03', 'denied');

    // 4. Create a pending request that should NOT expire (created 30 minutes ago)
    dateSpy.mockReturnValueOnce(baseTime - 30 * 60 * 1000);
    store.createRequest('00:11:22:33:44:04', 'ap-1', 'url', 'PendingKeep', 'Test');

    // 5. Create an approved request that should NOT expire (created 23 hours ago)
    dateSpy.mockReturnValueOnce(baseTime - 23 * 60 * 60 * 1000);
    store.createRequest('00:11:22:33:44:05', 'ap-1', 'url', 'ApprovedKeep', 'Test');
    store.updateRequestStatus('00:11:22:33:44:05', 'approved');

    // Now mock Date.now to return the baseTime during cleanup
    dateSpy.mockReturnValue(baseTime);

    // Run cleanup
    store.cleanup();

    // Verify expired entries are evicted
    expect(store.getRequestByMac('00:11:22:33:44:01')).toBeUndefined();
    expect(store.getRequestByMac('00:11:22:33:44:02')).toBeUndefined();
    expect(store.getRequestByMac('00:11:22:33:44:03')).toBeUndefined();

    // Verify non-expired entries remain
    expect(store.getRequestByMac('00:11:22:33:44:04')).toBeDefined();
    expect(store.getRequestByMac('00:11:22:33:44:05')).toBeDefined();

    dateSpy.mockRestore();
  });
});
