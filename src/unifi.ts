import axios, { AxiosInstance } from 'axios';
import * as https from 'https';

export interface UnifiConfig {
  url: string;
  username: string;
  password: string;
  site: string;
}

export class UnifiClient {
  private client: AxiosInstance;
  private config: UnifiConfig;

  constructor(config: UnifiConfig) {
    this.config = config;
    this.client = axios.create({
      baseURL: config.url,
      httpsAgent: new https.Agent({ rejectUnauthorized: false }), // Self-signed cert support
      withCredentials: true
    });
  }

  private async login(): Promise<void> {
    const res = await this.client.post('/api/auth/login', {
      username: this.config.username,
      password: this.config.password
    });
    const cookies = res.headers['set-cookie'];
    if (cookies) {
      this.client.defaults.headers.common['Cookie'] = cookies.join('; ');
    }
  }

  public async authorizeGuest(mac: string, minutes: number): Promise<boolean> {
    try {
      await this.login();
      const endpoint = `/api/s/${this.config.site}/cmd/stamgr`;
      const response = await this.client.post(endpoint, {
        cmd: 'authorize-guest',
        mac: mac.toLowerCase(),
        minutes: minutes
      });
      return response.data?.meta?.rc === 'ok';
    } catch (err) {
      console.error('UniFi authorization failed:', err);
      return false;
    }
  }
}
