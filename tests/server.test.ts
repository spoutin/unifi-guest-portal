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
  });

  it('should return 400 if required fields are missing on register', async () => {
    const res = await request(app)
      .post('/api/register')
      .send({ mac: '', name: 'Bob', reason: 'Developer' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('MAC, Name, and Reason are required');
  });

  it('should return 404 if request is not found for status poll', async () => {
    const res = await request(app).get('/api/status/ff:ff:ff:ff:ff:ff');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Request not found');
  });
});
