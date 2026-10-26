# Migrating UniFi Guest Portal to Dedicated Guest VLAN LXC

This document provides a comprehensive runbook and architecture guide for migrating `unifi-guest-portal` off the trusted `secrets` / PKI container and onto a dedicated LXC container located directly on the **Guest VLAN (VLAN 5)**.

---

## 1. Architectural Overview & Security Rationale

### Current State (Shared Container)
* **Container:** `secrets` (`wifi.int.spoutin.org`)
* **Hosted Services:**
  - OpenBao Server (Root Secrets, Unseal Keys, Infrastructure Vault)
  - `spoutin-pki` (Core Certificate Authority, SSH CA, 802.1X Internal Wi-Fi PKI, Admin Dashboard)
  - `unifi-guest-portal` (Untrusted Guest Captive Portal, Slack Socket Mode)
* **Risk:** The captive portal is directly exposed to unauthenticated guest devices. If compromised via a web or dependency vulnerability, an attacker gains local shell access on the exact machine hosting the root Certificate Authorities and vault storage files.

### Target State (Network & Security Isolation)
```
┌─────────────────────────────────────────────────────────────┐
│                 Guest Wi-Fi Subnet (VLAN 5)                 │
│                      192.168.111.0/24                       │
│                                                             │
│  [ Guest Phone / Laptop ]                                   │
│            │ (HTTP 80 / HTTPS 443)                          │
│            ▼                                                │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ New LXC: `guest-portal` (192.168.111.x)               │  │
│  │                                                       │  │
│  │ - Caddy (Port 80 -> 443 redirect, TLS termination)    │  │
│  │ - unifi-guest-portal (Bound strictly to 127.0.0.1:3000)│  │
│  │ - OpenBao Agent (Renders tmpfs /run/.../secret.env)   │  │
│  └───────┬───────────────────────────┬───────────────────┘  │
└──────────┼───────────────────────────┼──────────────────────┘
           │ (Outbound HTTPS only)     │ (Outbound HTTPS only)
           ▼                           ▼
┌───────────────────────────┐  ┌──────────────────────────────┐
│ UniFi Controller          │  │ Trusted Secrets LXC          │
│ 10.0.0.11:443             │  │ secrets.int.spoutin.org      │
│                           │  │                              │
│ - Authorizes guest MACs   │  │ - OpenBao Server (Port 8200) │
│   via API                 │  │ - spoutin-pki CA (Port 8000) │
└───────────────────────────┘  │ - Caddy TLS Gateway (443)    │
                               └──────────────────────────────┘
```

#### Key Isolation Boundaries:
1. **Network Placement:** The captive portal lives on the Guest VLAN (`192.168.111.0/24`), allowing guest clients to access it natively on-link.
2. **Loopback Binding:** Node.js listens exclusively on `127.0.0.1:3000`. Port 3000 is never exposed on the network.
3. **TLS Termination:** Local Caddy handles port 80 redirects and terminates HTTPS on 443 for `captive-portal.int.spoutin.org`.
4. **Least Privilege Secret Access:** The new container uses a dedicated OpenBao AppRole with read-only permissions strictly limited to `secret/data/guest-portal`. It has zero access to SSH CA keys, Wi-Fi CA keys, or other infrastructure secrets.

---

## 2. Network Specifications

| Parameter | Value |
| :--- | :--- |
| **VLAN ID** | `5` |
| **Subnet** | `192.168.111.0/24` |
| **Gateway** | `192.168.111.1` (or your router's VLAN 5 interface IP) |
| **Portal LXC IP** | e.g., `192.168.111.10` (Static) |
| **FQDN** | `captive-portal.int.spoutin.org` |
| **TLS Certificate** | Managed by Caddy via internal ACME CA or DNS provider |

---

## 3. Firewall Rules Matrix

The Guest VLAN should drop all inter-VLAN traffic by default. Configure explicit allow rules for the `guest-portal` LXC IP (`192.168.111.10`):

### Outbound from `guest-portal` LXC (`192.168.111.10`):
| Destination | Port | Protocol | Purpose |
| :--- | :--- | :--- | :--- |
| **UniFi Controller** (`10.0.0.11`) | `443` | TCP | UniFi API authorization (`authorize-guest`, `stat/sta`) |
| **Secrets / PKI Host** (`secrets.int.spoutin.org` / `wifi.int.spoutin.org`) | `443` | TCP | OpenBao Agent (`https://secrets.int.spoutin.org`) & PKI webhooks (`https://wifi.int.spoutin.org`) via Caddy |
| **WAN / Internet** | `443` | TCP | Slack Socket Mode (`wss://wss-primary.slack.com`) & Slack Web APIs |
| **Local Gateway / DNS** | `53` | UDP/TCP | DNS resolution |

### Inbound to `guest-portal` LXC (`192.168.111.10`):
| Source | Port | Protocol | Purpose |
| :--- | :--- | :--- | :--- |
| **Guest VLAN** (`192.168.111.0/24`) | `80`, `443` | TCP | Splash page loading and client registration polling |
| **Secrets / PKI Host** | `443` | TCP | Webhook callbacks from PKI admin dashboard approvals (`POST /api/internal/guest/:mac/status`) |
| **Management Subnet / Bastion** | `22` | TCP | SSH administration (restricted to admins) |

---

## 4. Step-by-Step Migration Runbook

### Phase 1: OpenBao Scoped AppRole Configuration (on `secrets`)

Log into the `secrets` container and configure a locked-down AppRole for the new guest portal host:

1. **Create the Policy (`/tmp/guest-portal-reader.hcl`):**
   ```hcl
   path "secret/data/guest-portal" {
     capabilities = ["read"]
   }
   path "secret/data/guest-portal/*" {
     capabilities = ["read"]
   }
   ```

2. **Apply Policy and Create AppRole:**
   ```bash
   export BAO_ADDR="https://127.0.0.1:8200"
   export BAO_SKIP_VERIFY="true"
   # Source root token if needed from /etc/openbao/openbao.env

   bao policy write guest-portal-reader /tmp/guest-portal-reader.hcl
   rm /tmp/guest-portal-reader.hcl

   # Enable approle auth if not already enabled
   bao auth enable approle 2>/dev/null || true

   # Create dedicated AppRole
   bao write auth/approle/role/guest-portal-host \
     token_policies="guest-portal-reader" \
     token_ttl=1h \
     token_max_ttl=4h
   ```

3. **Generate Credentials for the New Container:**
   ```bash
   # Read Role ID
   ROLE_ID=$(bao read -field=role_id auth/approle/role/guest-portal-host/role-id)
   echo "Role ID: $ROLE_ID"

   # Generate Secret ID
   SECRET_ID=$(bao write -f -field=secret_id auth/approle/role/guest-portal-host/secret-id)
   echo "Secret ID: $SECRET_ID"
   ```
   *(Keep these two values handy for Phase 2).*

---

### Phase 2: Provision & Configure the New `guest-portal` LXC

1. **Create Container in Proxmox VE:**
   * **Template:** Debian 12 Standard
   * **Network:** Bridge with **VLAN Tag `5`**
   * **IPv4:** Static `192.168.111.10/24`, Gateway `192.168.111.1`
   * **Resources:** 1 vCPU, 512 MB RAM, 4 GB Disk

2. **Install Prerequisites on the Container:**
   ```bash
   apt-get update && apt-get install -y curl debian-keyring debian-archive-keyring apt-transport-https gpg jq

   # Install Node.js 20
   curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
   apt-get install -y nodejs

   # Install Caddy
   curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
   curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
   apt-get update && apt-get install -y caddy

   # Install OpenBao
   curl -fsSL https://openbao.org/gpg.key | gpg --dearmor -o /usr/share/keyrings/openbao-archive-keyring.gpg
   echo "deb [signed-by=/usr/share/keyrings/openbao-archive-keyring.gpg] https://openbao.org/debian generic main" | tee /etc/apt/sources.list.d/openbao.list
   apt-get update && apt-get install -y openbao
   ```

3. **Install `unifi-guest-portal` Package:**
   ```bash
   curl -sL https://github.com/spoutin/unifi-guest-portal/releases/download/v1.0.10/unifi-guest-portal_1.0.10_all.deb -o /tmp/unifi-guest-portal.deb
   dpkg -i /tmp/unifi-guest-portal.deb
   ```

---

### Phase 3: Configure In-Memory Secrets via OpenBao Agent

1. **Place AppRole Credentials:**
   ```bash
   mkdir -p /etc/openbao
   chmod 0700 /etc/openbao

   echo "<ROLE_ID_FROM_PHASE_1>" > /etc/openbao/guest_role_id
   echo "<SECRET_ID_FROM_PHASE_1>" > /etc/openbao/guest_secret_id

   chmod 0600 /etc/openbao/guest_*
   ```

2. **Configure OpenBao Agent Template (`/etc/openbao/secret-env.ctmpl`):**
   ```hcl
   {{ with secret "secret/data/guest-portal" }}
   SLACK_BOT_TOKEN="{{ .Data.data.slack_bot_token }}"
   SLACK_APP_TOKEN="{{ .Data.data.slack_app_token }}"
   UNIFI_APP_TOKEN="{{ .Data.data.unifi_app_token }}"
   INTERNAL_API_SECRET="{{ .Data.data.wifi_api_token }}"
   {{ end }}
   ```

3. **Configure `/etc/openbao/agent.hcl`:**
   ```hcl
   pid_file = "/run/openbao-agent.pid"

   vault {
     address = "https://secrets.int.spoutin.org"
     # If using internal private CA for TLS:
     # ca_cert = "/etc/ssl/certs/spoutin-ca.crt"
   }

   auto_auth {
     method {
       type = "approle"
       config = {
         role_id_file_path   = "/etc/openbao/guest_role_id"
         secret_id_file_path = "/etc/openbao/guest_secret_id"
         remove_secret_id_file_after_reading = false
       }
     }

     sink {
       type = "file"
       config = {
         path = "/run/openbao-agent.token"
         mode = 0600
       }
     }
   }

   template {
     source      = "/etc/openbao/secret-env.ctmpl"
     destination = "/run/unifi-guest-portal/secret.env"
     perms       = "0640"
     command     = "systemctl restart unifi-guest-portal || true"
   }
   ```

4. **Enable and Start OpenBao Agent:**
   ```bash
   systemctl enable openbao-agent
   systemctl start openbao-agent

   # Verify secret.env rendered into tmpfs
   ls -la /run/unifi-guest-portal/secret.env
   ```

---

### Phase 4: Configure `unifi-guest-portal`

Edit `/etc/unifi-guest-portal/config.env`:
```ini
# Network binding - strictly loopback
PORTAL_HOST=127.0.0.1
PORT=3000

# UniFi Network Controller API
UNIFI_CONTROLLER_URL=https://10.0.0.11
UNIFI_SITE=default

# Slack Notifications
SLACK_CHANNEL_ID=C0C2SA22YFR

# Internal PKI Service for Web Dashboard Sync
PKI_INTERNAL_URL=https://wifi.int.spoutin.org

# Default Duration (in minutes)
GUEST_AUTH_DURATION=1440
```

Start the service:
```bash
systemctl daemon-reload
systemctl enable unifi-guest-portal
systemctl restart unifi-guest-portal

# Check status
systemctl status unifi-guest-portal --no-pager
```

---

### Phase 5: Configure Caddy Reverse Proxy & TLS

Edit `/etc/caddy/Caddyfile`:
```caddyfile
captive-portal.int.spoutin.org {
    # HTTP requests on port 80 are automatically redirected to HTTPS 443 by Caddy
    
    # Reverse proxy to loopback only
    reverse_proxy 127.0.0.1:3000

    log {
        output file /var/log/caddy/captive-portal.log
    }
}
```

Reload Caddy:
```bash
systemctl enable caddy
systemctl restart caddy
systemctl status caddy --no-pager
```

---

### Phase 6: UniFi Controller & DNS Configuration

1. **DNS Update:**
   - In your internal DNS server (Pi-hole, AdGuard, CoreDNS, or router):
   - Update `captive-portal.int.spoutin.org` `A` record from the old IP to the new IP: `192.168.111.10`.

2. **UniFi Network Controller Settings:**
   - Go to **UniFi Network** > **Settings** > **Wi-Fi** > **Guest Hotspot**.
   - Under **Guest Portal**:
     - Verify **Portal URL** points to `https://captive-portal.int.spoutin.org`.
   - Under **Pre-Authorization Allow List**:
     - Add `192.168.111.10/32` (or `192.168.111.0/24`) to ensure guest devices are allowed to reach the portal before being authorized.

---

### Phase 7: Verification & Validation Checklist

- [ ] **Splash Screen Load:** Connect an unauthenticated device to Guest Wi-Fi; verify `https://captive-portal.int.spoutin.org` loads with valid TLS.
- [ ] **Port Isolation Test:** Verify from the Guest VLAN that `http://192.168.111.10:3000` is **unreachable** (connection refused / timeout) and only ports `80` and `443` respond.
- [ ] **Registration & Slack Card:** Submit a guest access request; confirm approval card appears in Slack channel `#C0C2SA22YFR`.
- [ ] **PKI Dashboard Webhook:** Check `https://wifi.int.spoutin.org/admin`; verify the pending request appears under **⏳ Pending Access Requests**.
- [ ] **Approval Action:** Approve the request in the web dashboard with a chosen duration and speed profile; verify the guest device gets authorized and redirects to the internet.

---

### Phase 8: Decommission Old Portal on `secrets` LXC

Once verification is complete, clean up the `secrets` container:

```bash
# On secrets (wifi.int.spoutin.org):
sudo systemctl stop unifi-guest-portal
sudo systemctl disable unifi-guest-portal

# Remove package
sudo apt-get remove --purge unifi-guest-portal

# Clean up systemd runtime directories and configs
sudo rm -rf /etc/unifi-guest-portal /usr/share/unifi-guest-portal /run/unifi-guest-portal

# If Caddy was reverse-proxying captive-portal on secrets, remove that block from /etc/caddy/Caddyfile and reload:
sudo systemctl reload caddy
```
