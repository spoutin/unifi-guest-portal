import axios from 'axios';
import { UnifiClient } from '../src/unifi';
import { logger } from '../src/logger';

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

    const loggerErrorSpy = jest.spyOn(logger, 'error').mockImplementation(() => logger as any);

    const client = new UnifiClient(config);
    const success = await client.authorizeGuest('00:11:22:33:44:55', 1440);
    expect(success).toBe(false);
    expect(loggerErrorSpy).toHaveBeenCalled();
    loggerErrorSpy.mockRestore();
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

  describe('setClientName', () => {
    it('should update existing user name via rest/user endpoint', async () => {
      mockedAxios.create.mockReturnValue(mockedAxios as any);
      mockedAxios.post.mockResolvedValueOnce({
        headers: { 'set-cookie': ['unifises=xyz'] },
        data: {}
      }); // Login call
      mockedAxios.get.mockResolvedValueOnce({
        data: { data: [] }
      }); // Query stat/sta returns empty
      mockedAxios.get.mockResolvedValueOnce({
        data: { data: [{ _id: 'user123', mac: '00:11:22:33:44:55' }] }
      }); // Query rest/user
      mockedAxios.put.mockResolvedValueOnce({
        status: 200,
        data: {}
      }); // Put rest/user/{id}

      const client = new UnifiClient(config);
      const success = await client.setClientName('00:11:22:33:44:55', 'Alice');
      expect(success).toBe(true);
      expect(mockedAxios.get).toHaveBeenCalledWith('/proxy/network/api/s/default/stat/sta');
      expect(mockedAxios.get).toHaveBeenCalledWith('/proxy/network/api/s/default/rest/user');
      expect(mockedAxios.put).toHaveBeenCalledWith('/proxy/network/api/s/default/rest/user/user123', { name: 'Alice' });
    });

    it('should update active station name via upd/user endpoint if not in rest/user', async () => {
      mockedAxios.create.mockReturnValue(mockedAxios as any);
      mockedAxios.get.mockResolvedValueOnce({
        data: { data: [] }
      }); // Query rest/user returns empty
      mockedAxios.get.mockResolvedValueOnce({
        data: { data: [{ _id: 'sta999', mac: '00:11:22:33:44:55' }] }
      }); // Query stat/sta returns active station
      mockedAxios.post.mockResolvedValueOnce({
        status: 200,
        data: {}
      }); // Post upd/user/{id}

      const client = new UnifiClient({
        url: 'https://192.168.1.10:8443',
        site: 'default',
        apiKey: 'api-key-xyz'
      });
      const success = await client.setClientName('00:11:22:33:44:55', 'Bob');
      expect(success).toBe(true);
      expect(mockedAxios.get).toHaveBeenCalledWith('/proxy/network/api/s/default/stat/sta');
      expect(mockedAxios.post).toHaveBeenCalledWith('/proxy/network/api/s/default/upd/user/sta999', { name: 'Bob' });
    });

    it('should create new user record via rest/user if not found in rest/user or stat/sta', async () => {
      mockedAxios.create.mockReturnValue(mockedAxios as any);
      mockedAxios.get.mockResolvedValueOnce({
        data: { data: [] }
      }); // Query rest/user returns empty
      mockedAxios.get.mockResolvedValueOnce({
        data: { data: [] }
      }); // Query stat/sta returns empty
      mockedAxios.post.mockResolvedValueOnce({
        status: 201,
        data: {}
      }); // Post rest/user

      const client = new UnifiClient({
        url: 'https://192.168.1.10:8443',
        site: 'default',
        apiKey: 'api-key-xyz'
      });
      const success = await client.setClientName('AA:BB:CC:DD:EE:FF', 'Charlie');
      expect(success).toBe(true);
      expect(mockedAxios.post).toHaveBeenCalledWith('/proxy/network/api/s/default/rest/user', {
        mac: 'aa:bb:cc:dd:ee:ff',
        name: 'Charlie'
      });
    });

    it('should return false without throwing when request fails', async () => {
      mockedAxios.create.mockReturnValue(mockedAxios as any);
      mockedAxios.get.mockRejectedValueOnce(new Error('Network error'));

      const loggerWarnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => logger as any);

      const client = new UnifiClient({
        url: 'https://192.168.1.10:8443',
        site: 'default',
        apiKey: 'api-key-xyz'
      });
      const success = await client.setClientName('00:11:22:33:44:55', 'Dave');
      expect(success).toBe(false);
      expect(loggerWarnSpy).toHaveBeenCalled();
      loggerWarnSpy.mockRestore();
    });
  });
});
