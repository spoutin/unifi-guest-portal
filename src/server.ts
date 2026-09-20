import express from 'express';
import { Store } from './store';

export function createServer(store: Store) {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Captive Portal Splash Landing
  app.get('/guest/s/:site/', (req, res) => {
    const mac = (req.query.id as string) || '';
    const ap = (req.query.ap as string) || '';
    const url = (req.query.url as string) || '';

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
            <h2>Access Request Sent</h2>
            <div id="loader">
              <p>Please wait while an admin approves your request...</p>
              <div class="spinner"></div>
            </div>
            <div id="approved-msg" class="hidden">
              <p style="color: green; text-align: center; font-weight: bold;">Access Approved! Connecting you now...</p>
            </div>
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
              pollStatus(mac, url);
            }
          });

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
              }
            }, 3000);
          }
        </script>
      </body>
      </html>
    `);
  });

  // API Route: Register
  app.post('/api/register', (req, res) => {
    const { mac, ap, url, name, reason } = req.body;
    if (!mac || !name || !reason) {
      return res.status(400).json({ error: 'MAC, Name, and Reason are required' });
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
    res.json({ status: request.status });
  });

  return app;
}
