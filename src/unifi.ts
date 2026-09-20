import axios, { AxiosInstance } from 'axios';
import * as https from 'https';
import { performance } from 'perf_hooks';
import { logger } from './logger';

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
    const startTime = performance.now();
    logger.info(`Starting guest authorization process for MAC: ${mac}`);
    
    try {
      const loginStart = performance.now();
      await this.login();
      if (!this.config.apiKey) {
        logger.debug(`UniFi cookie login session established in ${(performance.now() - loginStart).toFixed(2)}ms`);
      }

      // Try with modern UniFi OS /proxy/network prefix first
      let endpoint = `/proxy/network/api/s/${this.config.site}/cmd/stamgr`;
      const apiStart = performance.now();
      
      try {
        logger.debug(`POST request sent to: ${endpoint}`);
        const response = await this.client.post(endpoint, {
          cmd: 'authorize-guest',
          mac: mac.toLowerCase(),
          minutes: minutes
        });
        
        const success = response.data?.meta?.rc === 'ok';
        logger.info(`Authorization command completed in ${(performance.now() - apiStart).toFixed(2)}ms (Success: ${success})`);
        logger.info(`Total UniFi authorization completed in ${(performance.now() - startTime).toFixed(2)}ms`);
        return success;
      } catch (err: any) {
        // If modern prefix is Not Found, fallback to standard standalone api path
        if (err.response?.status === 404) {
          logger.warn(`UniFi OS proxy endpoint returned 404. Falling back to standalone controller path...`);
          endpoint = `/api/s/${this.config.site}/cmd/stamgr`;
          const fallbackStart = performance.now();
          const response = await this.client.post(endpoint, {
            cmd: 'authorize-guest',
            mac: mac.toLowerCase(),
            minutes: minutes
          });
          const success = response.data?.meta?.rc === 'ok';
          logger.info(`Fallback authorization completed in ${(performance.now() - fallbackStart).toFixed(2)}ms (Success: ${success})`);
          logger.info(`Total UniFi authorization (with 404 fallback) completed in ${(performance.now() - startTime).toFixed(2)}ms`);
          return success;
        }
        throw err;
      }
    } catch (err: any) {
      logger.error(`UniFi authorization failed after ${(performance.now() - startTime).toFixed(2)}ms: ${err.message || err}`);
      return false;
    }
  }
}
