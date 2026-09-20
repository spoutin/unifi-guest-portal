import axios from 'axios';
import { UnifiClient } from '../src/unifi';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('UnifiClient', () => {
  const config = {
    url: 'https://192.168.1.10:8443',
    username: 'admin',
    password: 'password',
    site: 'default'
  };

  it('should authenticate and authorize a guest MAC address', async () => {
    mockedAxios.create.mockReturnValue(mockedAxios as any);
    mockedAxios.post.mockResolvedValueOnce({
      headers: { 'set-cookie': ['unifises=xyz'] },
      data: {}
    }); // Login call
    mockedAxios.post.mockResolvedValueOnce({
      data: { meta: { rc: 'ok' } }
    }); // Authorize call

    const client = new UnifiClient(config);
    const success = await client.authorizeGuest('00:11:22:33:44:55', 1440);
    expect(success).toBe(true);
  });

  it('should authorize directly using API key without logging in', async () => {
    mockedAxios.create.mockReturnValue(mockedAxios as any);
    mockedAxios.post.mockResolvedValueOnce({
      data: { meta: { rc: 'ok' } }
    }); // Authorize call directly, no login call beforehand

    const client = new UnifiClient({
      url: 'https://192.168.1.10:8443',
      site: 'default',
      apiKey: 'api-key-xyz'
    });
    const success = await client.authorizeGuest('00:11:22:33:44:55', 1440);
    expect(success).toBe(true);
  });

  it('should return false if login fails', async () => {
    mockedAxios.create.mockReturnValue(mockedAxios as any);
    mockedAxios.post.mockRejectedValueOnce(new Error('Network Error')); // Login call fails

    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const client = new UnifiClient(config);
    const success = await client.authorizeGuest('00:11:22:33:44:55', 1440);
    expect(success).toBe(false);
    expect(consoleErrorSpy).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  it('should return false if authorize call returns status other than ok', async () => {
    mockedAxios.create.mockReturnValue(mockedAxios as any);
    mockedAxios.post.mockResolvedValueOnce({
      headers: { 'set-cookie': ['unifises=xyz'] },
      data: {}
    }); // Login call
    mockedAxios.post.mockResolvedValueOnce({
      data: { meta: { rc: 'error' } }
    }); // Authorize call fails

    const client = new UnifiClient(config);
    const success = await client.authorizeGuest('00:11:22:33:44:55', 1440);
    expect(success).toBe(false);
  });

  it('should fallback to standard path if modern proxy path returns 404', async () => {
    mockedAxios.create.mockReturnValue(mockedAxios as any);
    mockedAxios.post.mockResolvedValueOnce({
      headers: { 'set-cookie': ['unifises=xyz'] },
      data: {}
    }); // Login call
    
    // Simulate 404 on proxy path
    const err404 = new Error('Not Found') as any;
    err404.response = { status: 404 };
    mockedAxios.post.mockRejectedValueOnce(err404);
    
    // Simulate success on standard fallback path
    mockedAxios.post.mockResolvedValueOnce({
      data: { meta: { rc: 'ok' } }
    });

    const client = new UnifiClient(config);
    const success = await client.authorizeGuest('00:11:22:33:44:55', 1440);
    expect(success).toBe(true);
  });
});
