import request from 'supertest';
import { createServer } from '../src/server';
import { Store } from '../src/store';

describe('Web Server API', () => {
  let app: any;
  let store: Store;

  beforeEach(() => {
    store = new Store();
    app = createServer(store);
  });

  it('should register a new request and poll status', async () => {
    const regRes = await request(app)
      .post('/api/register')
      .send({ mac: '11:22:33:44:55:66', ap: 'ap-1', url: 'http://apple.com', name: 'Bob', reason: 'Developer' });
    
    expect(regRes.status).toBe(200);
    expect(regRes.body.status).toBe('pending');

    const statusRes = await request(app).get('/api/status/11:22:33:44:55:66');
    expect(statusRes.body.status).toBe('pending');
  });

  it('should render the captive portal splash landing with query parameters', async () => {
    const res = await request(app)
      .get('/guest/s/default/?id=11:22:33:44:55:66&ap=ap-1&url=http%3A%2F%2Fapple.com');

    expect(res.status).toBe(200);
    expect(res.text).toContain('Guest Wi-Fi Registration');
    expect(res.text).toContain('value="11:22:33:44:55:66"');
    expect(res.text).toContain('value="ap-1"');
    expect(res.text).toContain('value="http://apple.com"');
    expect(res.text).toContain('href="http://wifi.int.spoutin.org"');
    expect(res.text).toContain('Device Onboarding');
  });

  it('should escape HTML special characters to prevent reflected XSS', async () => {
    const maliciousInput = '"><script>alert(1)</script>';
    const res = await request(app)
      .get(`/guest/s/default/?id=${encodeURIComponent(maliciousInput)}&ap=${encodeURIComponent(maliciousInput)}&url=${encodeURIComponent(maliciousInput)}`);

    expect(res.status).toBe(200);
    expect(res.text).not.toContain(maliciousInput);
    expect(res.text).toContain('value="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"');
  });

  it('should return 400 if required fields are missing on register', async () => {
    const res = await request(app)
      .post('/api/register')
      .send({ mac: '', name: 'Bob', reason: 'Developer' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('MAC, Name, and Reason are required');
  });

  it('should return 400 if MAC address format is invalid', async () => {
    const res = await request(app)
      .post('/api/register')
      .send({ mac: 'invalid-mac', name: 'Bob', reason: 'Developer' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid MAC address format');
  });

  it('should return 400 if name exceeds 100 characters', async () => {
    const longName = 'A'.repeat(101);
    const res = await request(app)
      .post('/api/register')
      .send({ mac: '11:22:33:44:55:66', name: longName, reason: 'Developer' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Name must be 100 characters or less');
  });

  it('should return 400 if reason exceeds 250 characters', async () => {
    const longReason = 'B'.repeat(251);
    const res = await request(app)
      .post('/api/register')
      .send({ mac: '11:22:33:44:55:66', name: 'Bob', reason: longReason });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Reason must be 250 characters or less');
  });

  it('should return 404 if request is not found for status poll', async () => {
    const res = await request(app).get('/api/status/ff:ff:ff:ff:ff:ff');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Request not found');
  });

  describe('Device Onboarding API (/api/onboard)', () => {
    it('should return 400 if MAC is missing', async () => {
      const res = await request(app).post('/api/onboard').send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('MAC address is required');
    });

    it('should return 400 if MAC is invalid', async () => {
      const res = await request(app).post('/api/onboard').send({ mac: 'not-a-mac' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Invalid MAC address format');
    });

    it('should return 503 if unifi client is not configured', async () => {
      const res = await request(app).post('/api/onboard').send({ mac: '11:22:33:44:55:66' });
      expect(res.status).toBe(503);
      expect(res.body.error).toBe('UniFi controller integration not available');
    });

    it('should authorize device for onboarding when unifi client is present', async () => {
      const mockUnifi = {
        authorizeGuest: jest.fn().mockResolvedValue(true)
      } as any;
      const customApp = createServer(store, {
        unifi: mockUnifi,
        onboardDuration: 5,
        onboardUrl: 'http://wifi.int.spoutin.org'
      });

      const res = await request(customApp)
        .post('/api/onboard')
        .send({ mac: 'aa:bb:cc:dd:ee:ff' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.redirectUrl).toBe('http://wifi.int.spoutin.org');
      expect(mockUnifi.authorizeGuest).toHaveBeenCalledWith('aa:bb:cc:dd:ee:ff', 5);
    });

    it('should return 500 if unifi controller reports failure', async () => {
      const mockUnifi = {
        authorizeGuest: jest.fn().mockResolvedValue(false)
      } as any;
      const customApp = createServer(store, { unifi: mockUnifi });

      const res = await request(customApp)
        .post('/api/onboard')
        .send({ mac: 'aa:bb:cc:dd:ee:ff' });

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('UniFi controller failed to authorize device');
    });

    it('should return 500 if unifi client throws an exception', async () => {
      const mockUnifi = {
        authorizeGuest: jest.fn().mockRejectedValue(new Error('Network error'))
      } as any;
      const customApp = createServer(store, { unifi: mockUnifi });

      const res = await request(customApp)
        .post('/api/onboard')
        .send({ mac: 'aa:bb:cc:dd:ee:ff' });

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('Failed to authorize device');
    });
  });

  describe('Direct Onboarding Route (GET /guest/s/:site/onboard)', () => {
    it('should return 400 if MAC is missing or invalid', async () => {
      const res1 = await request(app).get('/guest/s/default/onboard');
      expect(res1.status).toBe(400);

      const res2 = await request(app).get('/guest/s/default/onboard?id=bad-mac');
      expect(res2.status).toBe(400);
    });

    it('should return 503 if unifi client is not configured', async () => {
      const res = await request(app).get('/guest/s/default/onboard?id=11:22:33:44:55:66');
      expect(res.status).toBe(503);
    });

    it('should render redirect and button when unifi authorizes successfully', async () => {
      const mockUnifi = {
        authorizeGuest: jest.fn().mockResolvedValue(true)
      } as any;
      const customApp = createServer(store, {
        unifi: mockUnifi,
        onboardDuration: 5,
        onboardUrl: 'http://wifi.int.spoutin.org'
      });

      const res = await request(customApp)
        .get('/guest/s/default/onboard?id=aa:bb:cc:dd:ee:ff');

      expect(res.status).toBe(200);
      expect(res.text).toContain('Device Authorized!');
      expect(res.text).toContain('http://wifi.int.spoutin.org');
      expect(res.text).toContain('Open Enrollment Portal');
      expect(mockUnifi.authorizeGuest).toHaveBeenCalledWith('aa:bb:cc:dd:ee:ff', 5);
    });

    it('should return 500 if unifi fails to authorize', async () => {
      const mockUnifi = {
        authorizeGuest: jest.fn().mockResolvedValue(false)
      } as any;
      const customApp = createServer(store, { unifi: mockUnifi });

      const res = await request(customApp)
        .get('/guest/s/default/onboard?id=aa:bb:cc:dd:ee:ff');

      expect(res.status).toBe(500);
    });
  });
});
