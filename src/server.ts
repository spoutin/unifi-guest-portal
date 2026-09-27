import express from 'express';
import { Store } from './store';
import { UnifiClient } from './unifi';
import { logger } from './logger';

export interface ServerOptions {
  unifi?: UnifiClient;
  onboardDuration?: number;
  onboardUrl?: string;
}

function escapeHtml(str: string): string {
  return str.replace(/[&<>"']/g, (m) => {
    switch (m) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case "'": return '&#039;';
      default: return m;
    }
  });
}

export function createServer(store: Store, options: ServerOptions = {}) {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Captive Portal Splash Landing
  app.get('/guest/s/:site/', (req, res) => {
    const site = escapeHtml(req.params.site || 'default');
    const mac = escapeHtml((req.query.id as string) || '');
    const ap = escapeHtml((req.query.ap as string) || '');
    const url = escapeHtml((req.query.url as string) || '');
    const onboardUrl = escapeHtml(options.onboardUrl || 'http://wifi.int.spoutin.org');
    const onboardDuration = options.onboardDuration || 5;

    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Guest WiFi Access</title>
        <style>
          body { font-family: -apple-system, system-ui, sans-serif; background: #f3f4f6; color: #1f2937; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
          .card { background: white; padding: 2rem; border-radius: 8px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1); width: 100%; max-width: 400px; box-sizing: border-box; }
          h2 { margin-top: 0; text-align: center; color: #1e3a8a; }
          label { display: block; margin: 12px 0 4px; font-weight: 600; font-size: 0.9rem; }
          input { width: 100%; padding: 10px; border: 1px solid #d1d5db; border-radius: 4px; box-sizing: border-box; }
          button { width: 100%; padding: 12px; background: #2563eb; color: white; border: none; border-radius: 4px; font-weight: bold; margin-top: 20px; cursor: pointer; }
          button:hover { background: #1d4ed8; }
          .hidden { display: none; }
          #loader { text-align: center; }
          .spinner { border: 4px solid #f3f3f3; border-top: 4px solid #2563eb; border-radius: 50%; width: 30px; height: 30px; animation: spin 1s linear infinite; margin: 20px auto; }
          @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
          .footer-link { margin-top: 24px; text-align: center; }
          .footer-link a { color: #9ca3af; font-size: 0.8rem; text-decoration: none; }
          .footer-link a:hover { color: #6b7280; text-decoration: underline; }
        </style>
      </head>
      <body>
        <div class="card">
          <div id="form-container">
            <h2>Guest Wi-Fi Registration</h2>
            <form id="reg-form">
              <input type="hidden" id="mac" value="${mac}">
              <input type="hidden" id="ap" value="${ap}">
              <input type="hidden" id="url" value="${url}">
              
              <label for="name">Your Name</label>
              <input type="text" id="name" required placeholder="John Doe">
              
              <label for="reason">Reason for Visit</label>
              <input type="text" id="reason" required placeholder="Meeting with Marketing">
              
              <button type="submit">Request Access</button>
            </form>
          </div>
          
          <div id="status-container" class="hidden">
            <h2 id="status-title">Access Request Sent</h2>
            <div id="loader">
              <p id="loader-msg">Please wait while an admin approves your request...</p>
              <div class="spinner"></div>
            </div>
            <div id="approved-msg" class="hidden">
              <p id="approved-text" style="color: green; text-align: center; font-weight: bold;">Access Approved! Connecting you now...</p>
              <div id="onboard-proceed-container" class="hidden" style="text-align: center; margin-top: 16px;">
                <a id="onboard-proceed-btn" href="${onboardUrl}" style="display: block; width: 100%; box-sizing: border-box; padding: 12px; background: #2563eb; color: white; border-radius: 4px; font-weight: bold; text-decoration: none; text-align: center;">
                  Open Device Enrollment Portal &rarr;
                </a>
                <div style="font-size: 0.85rem; color: #4b5563; text-align: left; background: #f3f4f6; border-radius: 6px; padding: 12px; margin-top: 14px; line-height: 1.4;">
                  <strong style="color: #111827;">Device Authorized for ${onboardDuration} Minutes</strong><br>
                  If your browser didn't open automatically:
                  <ul style="margin: 6px 0 0; padding-left: 18px;">
                    <li>Tap the button above, or</li>
                    <li>Tap the <strong>&#8942;</strong> menu (top right) &rarr; <strong>Use network as is</strong>, then open Chrome and visit <strong style="word-break: break-all;">${onboardUrl}</strong></li>
                  </ul>
                </div>
              </div>
            </div>
            <div id="denied-msg" class="hidden">
              <p style="color: red; text-align: center; font-weight: bold;">Access Denied. Your request was rejected<span id="denied-admin"> by an administrator</span>.</p>
            </div>
            <div id="onboard-error-msg" class="hidden">
              <p id="onboard-error-text" style="color: red; text-align: center; font-weight: bold;">Failed to authorize device setup.</p>
              <button type="button" id="retry-btn">Back to Form</button>
            </div>
          </div>
          <div class="footer-link">
            <a href="/guest/s/${site}/onboard?id=${mac}" id="onboard-link">Device Onboarding</a>
          </div>
        </div>

        <script>
          const form = document.getElementById('reg-form');
          form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const mac = document.getElementById('mac').value;
            const ap = document.getElementById('ap').value;
            const url = document.getElementById('url').value;
            const name = document.getElementById('name').value;
            const reason = document.getElementById('reason').value;

            const res = await fetch('/api/register', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ mac, ap, url, name, reason })
            });

            if (res.ok) {
              document.getElementById('form-container').classList.add('hidden');
              document.getElementById('status-container').classList.remove('hidden');
              const footerLink = document.querySelector('.footer-link');
              if (footerLink) footerLink.classList.add('hidden');
              pollStatus(mac, url);
            }
          });

          const onboardLink = document.getElementById('onboard-link');
          if (onboardLink) {
            onboardLink.addEventListener('click', async (e) => {
              e.preventDefault();
              let mac = document.getElementById('mac').value;
              if (!mac) {
                mac = prompt("Please enter your device MAC address (e.g. AA:BB:CC:DD:EE:FF):");
                if (!mac) return;
              }

              document.getElementById('form-container').classList.add('hidden');
              document.getElementById('status-container').classList.remove('hidden');
              const footerLink = document.querySelector('.footer-link');
              if (footerLink) footerLink.classList.add('hidden');

              document.getElementById('status-title').textContent = 'Device Onboarding';
              document.getElementById('loader').classList.remove('hidden');
              document.getElementById('loader-msg').textContent = 'Authorizing ${onboardDuration}-minute setup window on network...';
              document.getElementById('approved-msg').classList.add('hidden');
              document.getElementById('denied-msg').classList.add('hidden');
              document.getElementById('onboard-error-msg').classList.add('hidden');

              try {
                const res = await fetch('/api/onboard', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ mac })
                });
                const data = await res.json();
                if (res.ok && data.success) {
                  const targetUrl = data.redirectUrl || "${onboardUrl}";
                  const isAndroid = /Android/i.test(navigator.userAgent);
                  const rawWithoutScheme = targetUrl.replace(/^https?:\/\//i, '');
                  const scheme = targetUrl.startsWith('https:') ? 'https' : 'http';
                  const intentUrl = 'intent://' + rawWithoutScheme + '#Intent;scheme=' + scheme + ';action=android.intent.action.VIEW;category=android.intent.category.BROWSABLE;end';
                  const launchUrl = isAndroid ? intentUrl : targetUrl;

                  document.getElementById('loader').classList.add('hidden');
                  document.getElementById('approved-msg').classList.remove('hidden');
                  document.getElementById('approved-text').textContent = 'Network Authorized for ${onboardDuration} Minutes!';
                  
                  const proceedContainer = document.getElementById('onboard-proceed-container');
                  if (proceedContainer) {
                    proceedContainer.classList.remove('hidden');
                    const proceedBtn = document.getElementById('onboard-proceed-btn');
                    if (proceedBtn) proceedBtn.href = launchUrl;
                  }

                  // Attempt immediate browser launch
                  try {
                    window.location.href = launchUrl;
                  } catch (err) {}
                } else {
                  throw new Error(data.error || 'Failed to authorize device');
                }
              } catch (err) {
                document.getElementById('loader').classList.add('hidden');
                document.getElementById('onboard-error-msg').classList.remove('hidden');
                document.getElementById('onboard-error-text').textContent = err.message || 'Authorization failed. Please try again.';
              }
            });
          }

          const retryBtn = document.getElementById('retry-btn');
          if (retryBtn) {
            retryBtn.addEventListener('click', () => {
              document.getElementById('status-container').classList.add('hidden');
              document.getElementById('form-container').classList.remove('hidden');
              const footerLink = document.querySelector('.footer-link');
              if (footerLink) footerLink.classList.remove('hidden');
              document.getElementById('status-title').textContent = 'Access Request Sent';
              document.getElementById('loader-msg').textContent = 'Please wait while an admin approves your request...';
              document.getElementById('approved-text').textContent = 'Access Approved! Connecting you now...';
              const proceedContainer = document.getElementById('onboard-proceed-container');
              if (proceedContainer) proceedContainer.classList.add('hidden');
            });
          }

          function pollStatus(mac, redirectUrl) {
            const interval = setInterval(async () => {
              const res = await fetch('/api/status/' + mac);
              const data = await res.json();
              if (data.status === 'approved') {
                clearInterval(interval);
                document.getElementById('loader').classList.add('hidden');
                document.getElementById('approved-msg').classList.remove('hidden');
                setTimeout(() => {
                  window.location.href = redirectUrl || "http://www.google.com";
                }, 2000);
              } else if (data.status === 'denied') {
                clearInterval(interval);
                document.getElementById('loader').classList.add('hidden');
                if (data.processedBy) {
                  document.getElementById('denied-admin').textContent = ' by @' + data.processedBy;
                }
                document.getElementById('denied-msg').classList.remove('hidden');
              }
            }, 3000);
          }
        </script>
      </body>
      </html>
    `);
  });

  // API Route: Quick Onboarding for TLS Client Certificates
  app.post('/api/onboard', async (req, res) => {
    const { mac } = req.body;
    if (!mac) {
      return res.status(400).json({ error: 'MAC address is required' });
    }
    const macRegex = /^([0-9a-fA-F]{2}[:-]){5}([0-9a-fA-F]{2})$/;
    if (!macRegex.test(mac)) {
      return res.status(400).json({ error: 'Invalid MAC address format' });
    }

    if (!options.unifi) {
      return res.status(503).json({ error: 'UniFi controller integration not available' });
    }

    const duration = options.onboardDuration || 5;
    const redirectUrl = options.onboardUrl || 'http://wifi.int.spoutin.org';

    try {
      logger.info(`Authorizing temporary ${duration}-minute onboarding access for MAC: ${mac}`);
      const success = await options.unifi.authorizeGuest(mac, duration);
      if (success) {
        return res.json({ success: true, redirectUrl });
      } else {
        logger.error(`UniFi returned failure status authorizing onboarding for MAC: ${mac}`);
        return res.status(500).json({ error: 'UniFi controller failed to authorize device' });
      }
    } catch (err: any) {
      logger.error(`Exception during onboarding authorization for MAC ${mac}: ${err.message || err}`);
      return res.status(500).json({ error: 'Failed to authorize device' });
    }
  });

  // Direct Onboarding Navigation Route (native browser navigation with immediate redirect & fallback button)
  app.get('/guest/s/:site/onboard', async (req, res) => {
    const site = escapeHtml(req.params.site || 'default');
    const mac = (req.query.id as string) || (req.query.mac as string) || '';
    const redirectUrl = options.onboardUrl || 'http://wifi.int.spoutin.org';
    const duration = options.onboardDuration || 5;

    const macRegex = /^([0-9a-fA-F]{2}[:-]){5}([0-9a-fA-F]{2})$/;
    if (!mac || !macRegex.test(mac)) {
      return res.status(400).send(`
        <!DOCTYPE html>
        <html><body>
          <p style="color:red;font-family:sans-serif;">Missing or invalid MAC address.</p>
          <p><a href="/guest/s/${site}/">Return to Portal</a></p>
        </body></html>
      `);
    }

    if (!options.unifi) {
      return res.status(503).send(`
        <!DOCTYPE html>
        <html><body>
          <p style="color:red;font-family:sans-serif;">UniFi controller integration not available.</p>
          <p><a href="/guest/s/${site}/">Return to Portal</a></p>
        </body></html>
      `);
    }

    try {
      logger.info(`Authorizing temporary ${duration}-minute onboarding access for MAC: ${mac} via direct route`);
      const success = await options.unifi.authorizeGuest(mac, duration);
      if (success) {
        return res.send(`
          <!DOCTYPE html>
          <html>
          <head>
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Device Authorized</title>
            <style>
              body { font-family: -apple-system, system-ui, sans-serif; background: #f3f4f6; color: #1f2937; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
              .card { background: white; padding: 2rem; border-radius: 8px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1); width: 100%; max-width: 420px; box-sizing: border-box; }
              .btn { display: block; width: 100%; padding: 12px; background: #2563eb; color: white; border-radius: 4px; font-weight: bold; text-decoration: none; margin-top: 15px; box-sizing: border-box; text-align: center; }
            </style>
            <script>
              var targetUrl = "${redirectUrl}";
              var isAndroid = /Android/i.test(navigator.userAgent);
              var raw = targetUrl.replace(/^https?:\\/\\//i, '');
              var scheme = targetUrl.indexOf('https:') === 0 ? 'https' : 'http';
              var launchUrl = isAndroid ? ('intent://' + raw + '#Intent;scheme=' + scheme + ';action=android.intent.action.VIEW;category=android.intent.category.BROWSABLE;end') : targetUrl;
              window.onload = function() {
                var btn = document.getElementById('launch-btn');
                if (btn) btn.href = launchUrl;
                try { window.location.href = launchUrl; } catch(e){}
              };
            </script>
          </head>
          <body>
            <div class="card">
              <h2 style="color: #1e3a8a; margin-top: 0; text-align: center;">Device Authorized!</h2>
              <p style="text-align: center;">Your device has been granted <strong>${duration} minutes</strong> of access to complete certificate enrollment.</p>
              <a id="launch-btn" href="${escapeHtml(redirectUrl)}" class="btn">Open Enrollment Portal &rarr;</a>
              <div style="font-size: 0.85rem; color: #4b5563; text-align: left; background: #f3f4f6; border-radius: 6px; padding: 12px; margin-top: 15px; line-height: 1.4;">
                <strong style="color: #111827;">If your browser did not open:</strong>
                <ul style="margin: 6px 0 0; padding-left: 18px;">
                  <li>Tap the button above, or</li>
                  <li>Tap <strong>&#8942;</strong> (top right) &rarr; <strong>Use network as is</strong>, then open Chrome and visit <strong style="word-break: break-all;">${escapeHtml(redirectUrl)}</strong></li>
                </ul>
              </div>
            </div>
          </body>
          </html>
        `);
      } else {
        return res.status(500).send(`
          <!DOCTYPE html>
          <html><body>
            <p style="color:red;font-family:sans-serif;">UniFi controller failed to authorize device.</p>
            <p><a href="/guest/s/${site}/">Return to Portal</a></p>
          </body></html>
        `);
      }
    } catch (err: any) {
      logger.error(`Exception during direct onboarding for MAC ${mac}: ${err.message || err}`);
      return res.status(500).send(`
        <!DOCTYPE html>
        <html><body>
          <p style="color:red;font-family:sans-serif;">Failed to authorize device.</p>
          <p><a href="/guest/s/${site}/">Return to Portal</a></p>
        </body></html>
      `);
    }
  });

  // API Route: Register
  app.post('/api/register', (req, res) => {
    const { mac, ap, url, name, reason } = req.body;
    if (!mac || !name || !reason) {
      return res.status(400).json({ error: 'MAC, Name, and Reason are required' });
    }
    const macRegex = /^([0-9a-fA-F]{2}[:-]){5}([0-9a-fA-F]{2})$/;
    if (!macRegex.test(mac)) {
      return res.status(400).json({ error: 'Invalid MAC address format' });
    }
    if (name.length > 100) {
      return res.status(400).json({ error: 'Name must be 100 characters or less' });
    }
    if (reason.length > 250) {
      return res.status(400).json({ error: 'Reason must be 250 characters or less' });
    }
    const request = store.createRequest(mac, ap, url, name, reason);
    app.emit('guest_registered', request); // Emit event for Slack integration
    res.json(request);
  });

  // API Route: Status check
  app.get('/api/status/:mac', (req, res) => {
    const request = store.getRequestByMac(req.params.mac);
    if (!request) {
      return res.status(404).json({ error: 'Request not found' });
    }
    res.json({ 
      status: request.status,
      processedBy: request.processedBy
    });
  });

  return app;
}
