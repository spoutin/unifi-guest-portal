import axios, { AxiosInstance } from 'axios';
import * as https from 'https';

export interface UnifiConfig {
  url: string;
  username?: string;
  password?: string;
  site: string;
  apiKey?: string;
}

export class UnifiClient {
  private client: AxiosInstance;
  private config: UnifiConfig;

  constructor(config: UnifiConfig) {
    this.config = config;
    
    const headers: Record<string, string> = {};
    if (config.apiKey) {
      headers['X-API-KEY'] = config.apiKey;
      headers['Authorization'] = `Bearer ${config.apiKey}`;
    }

    this.client = axios.create({
      baseURL: config.url,
      headers: headers,
      httpsAgent: new https.Agent({ rejectUnauthorized: false }), // Self-signed cert support
      withCredentials: true
    });
  }

  private async login(): Promise<void> {
    if (this.config.apiKey) {
      return; // Skip authentication call since we are using API Keys
    }
    const res = await this.client.post('/api/auth/login', {
      username: this.config.username,
      password: this.config.password
    });
    const cookies = res.headers['set-cookie'];
    if (cookies) {
      this.client.defaults.headers.common['Cookie'] = cookies.join('; ');
    }
    const csrfToken = res.headers['x-csrf-token'];
    if (csrfToken) {
      this.client.defaults.headers.common['x-csrf-token'] = csrfToken;
    }
  }

  public async authorizeGuest(mac: string, minutes: number): Promise<boolean> {
    try {
      await this.login();
      
      // Try with modern UniFi OS /proxy/network prefix first
      let endpoint = `/proxy/network/api/s/${this.config.site}/cmd/stamgr`;
      try {
        const response = await this.client.post(endpoint, {
          cmd: 'authorize-guest',
          mac: mac.toLowerCase(),
          minutes: minutes
        });
        return response.data?.meta?.rc === 'ok';
      } catch (err: any) {
        // If modern prefix is Not Found, fallback to standard standalone api path
        if (err.response?.status === 404) {
          endpoint = `/api/s/${this.config.site}/cmd/stamgr`;
          const response = await this.client.post(endpoint, {
            cmd: 'authorize-guest',
            mac: mac.toLowerCase(),
            minutes: minutes
          });
          return response.data?.meta?.rc === 'ok';
        }
        throw err;
      }
    } catch (err) {
      console.error('UniFi authorization failed:', err);
      return false;
    }
  }
}
