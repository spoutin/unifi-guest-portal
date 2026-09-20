export interface GuestRequest {
  mac: string;
  ap: string;
  originalUrl: string;
  name: string;
  reason: string;
  status: 'pending' | 'approved' | 'denied';
  createdAt: number;
}

export class Store {
  private requests: Map<string, GuestRequest> = new Map();

  constructor() {
    setInterval(() => this.cleanup(), 15 * 60 * 1000).unref();
  }

  public cleanup(): void {
    const now = Date.now();
    const oneHour = 60 * 60 * 1000;
    const twentyFourHours = 24 * 60 * 60 * 1000;

    for (const [mac, req] of this.requests.entries()) {
      const age = now - req.createdAt;
      if (req.status === 'pending' && age > oneHour) {
        this.requests.delete(mac);
      } else if ((req.status === 'approved' || req.status === 'denied') && age > twentyFourHours) {
        this.requests.delete(mac);
      }
    }
  }

  public createRequest(mac: string, ap: string, url: string, name: string, reason: string): GuestRequest {
    const formattedMac = mac.toLowerCase();
    const request: GuestRequest = {
      mac: formattedMac,
      ap,
      originalUrl: url,
      name,
      reason,
      status: 'pending',
      createdAt: Date.now()
    };
    this.requests.set(formattedMac, request);
    return request;
  }

  public getRequestByMac(mac: string): GuestRequest | undefined {
    return this.requests.get(mac.toLowerCase());
  }

  public updateRequestStatus(mac: string, status: 'approved' | 'denied'): boolean {
    const formattedMac = mac.toLowerCase();
    const req = this.requests.get(formattedMac);
    if (!req) return false;
    req.status = status;
    return true;
  }
}

export const store = new Store();
