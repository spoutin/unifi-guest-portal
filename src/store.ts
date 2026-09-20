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
