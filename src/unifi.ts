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

  public async setClientName(mac: string, name: string): Promise<boolean> {
    const normMac = mac.toLowerCase().trim();
    const cleanedName = name.trim();
    if (!cleanedName) return false;

    const endpoints = [
      `/proxy/network/api/s/${this.config.site}`,
      `/api/s/${this.config.site}`
    ];

    try {
      await this.login();

      for (const base of endpoints) {
        try {
          // 1. Check active stations first
          const staResp = await this.client.get(`${base}/stat/sta`);
          const stations: any[] = staResp.data?.data || [];
          const staMatch = stations.find((s: any) => s.mac?.toLowerCase() === normMac);
          if (staMatch?._id) {
            const userId = staMatch._id;
            await this.client.post(`${base}/upd/user/${userId}`, { name: cleanedName });
            try {
              await this.client.put(`${base}/rest/user/${userId}`, { name: cleanedName });
            } catch (_) {}
            return true;
          }

          // 2. Check user list
          const userResp = await this.client.get(`${base}/rest/user`);
          const users: any[] = userResp.data?.data || [];
          const userMatch = users.find((u: any) => u.mac?.toLowerCase() === normMac);
          if (userMatch?._id) {
            const userId = userMatch._id;
            await this.client.put(`${base}/rest/user/${userId}`, { name: cleanedName });
            try {
              await this.client.post(`${base}/upd/user/${userId}`, { name: cleanedName });
            } catch (_) {}
            return true;
          }

          // 3. Create user
          const createResp = await this.client.post(`${base}/rest/user`, { mac: normMac, name: cleanedName });
          if (createResp.status === 200 || createResp.status === 201) return true;
        } catch (err: any) {
          if (err?.response?.status === 404 && base === endpoints[0]) {
            continue;
          }
          throw err;
        }
      }
      return false;
    } catch (err: any) {
      logger.warn(`Failed to set UniFi client name for ${normMac}: ${err.message || err}`);
      return false;
    }
  }
}
