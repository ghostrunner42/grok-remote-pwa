const express = require('express');
const cors = require('cors');
const QRCode = require('qrcode');
const fs = require('fs').promises;
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors()); // Allow requests from your phone on the same network
app.use(express.json());

// Simple in-memory chat history (per session - we can expand later)
let chatHistory = [];

// Health check
app.get('/api/status', (req, res) => {
  res.json({ 
    status: 'online', 
    message: 'Grok Remote backend is running smooth on your PC',
    timestamp: new Date().toISOString()
  });
});

// === NEW: QR Code pairing endpoint ===
app.get('/api/qr', async (req, res) => {
  try {
    // Get the actual host the request came from (works great on local network)
    const host = req.get('host') || `localhost:${PORT}`;
    const backendUrl = `http://${host}`;
    
    // Encode a simple JSON payload the PWA can parse
    const qrPayload = JSON.stringify({
      url: backendUrl,
      token: 'grok-remote-demo-2026'  // In real version this would be a secure short-lived token
    });
    
    const qrDataUrl = await QRCode.toDataURL(qrPayload, {
      width: 300,
      margin: 2,
      color: {
        dark: '#ff1a1a',
        light: '#000000'
      }
    });
    
    res.json({
      qr: qrDataUrl,
      url: backendUrl,
      instructions: 'Scan this with the Grok Remote PWA on your phone'
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate QR code' });
  }
});

// Simple beautiful QR page (open this on your PC browser)
app.get('/qr', async (req, res) => {
  try {
    const host = req.get('host') || `localhost:${PORT}`;
    const backendUrl = `http://${host}`;
    const qrPayload = JSON.stringify({ url: backendUrl, token: 'grok-remote-demo-2026' });
    const qrDataUrl = await QRCode.toDataURL(qrPayload, { width: 400, margin: 2 });
    
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Grok Remote • Pair</title>
        <style>
          body { background: #0a0a0a; color: white; font-family: system-ui; text-align: center; padding: 40px; }
          .qr-container { background: #111; padding: 30px; border-radius: 20px; display: inline-block; margin: 20px 0; }
          h1 { color: #ff1a1a; }
        </style>
      </head>
      <body>
        <h1>🔥 Grok Remote Pairing</h1>
        <p>Open the Grok Remote PWA on your phone and tap <strong>"Scan QR"</strong></p>
        <div class="qr-container">
          <img src="${qrDataUrl}" alt="QR Code" style="max-width: 100%;">
        </div>
        <p style="color:#888; font-size:14px;">${backendUrl}</p>
        <p style="margin-top:30px; font-size:13px; color:#555;">This QR expires when you restart the server</p>
      </body>
      </html>
    `);
  } catch (err) {
    res.status(500).send('QR generation failed');
  }
});

// === NEW: Remote File Browser (IDE-like view) ===
// Safe base directory - only allow access inside /projects
const PROJECTS_DIR = path.join(__dirname, 'projects');

// Ensure projects folder exists
fs.mkdir(PROJECTS_DIR, { recursive: true }).catch(() => {});

app.get('/api/files', async (req, res) => {
  try {
    const requestedPath = req.query.path || '';
    const safePath = path.join(PROJECTS_DIR, requestedPath);
    
    // Security: prevent path traversal
    if (!safePath.startsWith(PROJECTS_DIR)) {
      return res.status(403).json({ error: 'Access denied' });
    }
    
    const stats = await fs.stat(safePath);
    if (!stats.isDirectory()) {
      return res.status(400).json({ error: 'Not a directory' });
    }
    
    const files = await fs.readdir(safePath, { withFileTypes: true });
    const result = files.map(file => ({
      name: file.name,
      isDirectory: file.isDirectory(),
      path: path.join(requestedPath, file.name)
    }));
    
    res.json({ 
      currentPath: requestedPath || '/',
      files: result 
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list files' });
  }
});

app.get('/api/read-file', async (req, res) => {
  try {
    const filePath = req.query.path;
    if (!filePath) return res.status(400).json({ error: 'Path required' });
    
    const safePath = path.join(PROJECTS_DIR, filePath);
    if (!safePath.startsWith(PROJECTS_DIR)) {
      return res.status(403).json({ error: 'Access denied' });
    }
    
    const content = await fs.readFile(safePath, 'utf8');
    res.json({ path: filePath, content });
  } catch (err) {
    res.status(500).json({ error: 'Failed to read file' });
  }
});

app.post('/api/write-file', async (req, res) => {
  try {
    const { path: filePath, content } = req.body;
    if (!filePath || content === undefined) {
      return res.status(400).json({ error: 'Path and content required' });
    }
    
    const safePath = path.join(PROJECTS_DIR, filePath);
    if (!safePath.startsWith(PROJECTS_DIR)) {
      return res.status(403).json({ error: 'Access denied' });
    }
    
    await fs.writeFile(safePath, content, 'utf8');
    res.json({ success: true, path: filePath });
  } catch (err) {
    res.status(500).json({ error: 'Failed to write file' });
  }
});

// Main chat endpoint - this is where the magic happens
app.post('/api/chat', async (req, res) => {
  const { prompt, sessionId = 'default' } = req.body;

  if (!prompt || prompt.trim() === '') {
    return res.status(400).json({ error: 'Prompt is required, bro' });
  }

  console.log(`📱 Phone sent prompt: "${prompt}"`);

  // TODO: Real xAI Grok API integration
  // 1. Get your API key from https://console.x.ai
  // 2. Uncomment the fetch block below and add your key
  // 3. The API is OpenAI-compatible: https://api.x.ai/v1/chat/completions
  //
  // Example real integration:
  /*
  try {
    const xaiResponse = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.XAI_API_KEY || 'YOUR_KEY_HERE'}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'grok-2-1212',  // or 'grok-beta' / whatever the current model is
        messages: [
          { role: 'system', content: 'You are Grok, built by xAI. Be helpful, maximally truthful, and a bit based. The user is controlling you remotely from their phone via this PWA.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.7,
        max_tokens: 2000
      })
    });

    const data = await xaiResponse.json();
    if (!xaiResponse.ok) throw new Error(data.error?.message || 'API error');
    
    const grokReply = data.choices[0].message.content;
    chatHistory.push({ role: 'user', content: prompt });
    chatHistory.push({ role: 'assistant', content: grokReply });
    
    return res.json({ 
      response: grokReply,
      sessionId 
    });
  } catch (error) {
    console.error('xAI API error:', error);
    return res.status(500).json({ 
      error: 'Grok API call failed. Check your key and internet.',
      fallback: true 
    });
  }
  */

  // === MOCK MODE (for testing without API key) ===
  // Simulate Grok thinking...
  await new Promise(resolve => setTimeout(resolve, 800));

  let mockReply = `🔥 Grok here from your PC! Got your prompt: "${prompt}"\n\n`;

  if (prompt.toLowerCase().includes('build') || prompt.toLowerCase().includes('create')) {
    mockReply += `Hell yeah, let's build that! In the real version I'd generate the full code and drop it into a /projects folder on this computer. What tech stack you want? React? Next.js? Plain HTML?`;
  } else if (prompt.toLowerCase().includes('hello') || prompt.toLowerCase().includes('hi')) {
    mockReply += `What's good? Your phone is now wirelessly controlling me on this rig. Feels like the future, right?`;
  } else {
    mockReply += `Solid prompt. In a full build I'd hit the real xAI API and give you a fire response. For now, imagine I just wrote you some killer code or ran a build command. What's next on the agenda?`;
  }

  chatHistory.push({ role: 'user', content: prompt });
  chatHistory.push({ role: 'assistant', content: mockReply });

  res.json({ 
    response: mockReply,
    sessionId,
    note: 'This is mock mode. Add your XAI_API_KEY to use real Grok.'
  });
});

// Bonus: Simple command execution endpoint (whitelisted for safety in POC)
app.post('/api/command', (req, res) => {
  const { command } = req.body;
  
  // Super basic whitelist - expand carefully!
  const safeCommands = ['ls', 'pwd', 'whoami', 'date', 'echo hello from grok remote'];
  
  if (!safeCommands.some(safe => command.includes(safe))) {
    return res.json({ 
      response: `⚠️ Command "${command}" blocked for safety in this POC. Only safe demo commands allowed right now.` 
    });
  }

  // In real version we'd use child_process.execSync here
  const mockOutput = `Executed on PC: ${command}\nOutput: [Simulated] All good, command ran successfully.`;
  
  res.json({ response: mockOutput });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`
⏰ Grok Remote Backend LIVE on port ${PORT}
   Access from phone using your PC's local IP (e.g. http://192.168.1.XXX:${PORT})
   Run: node server.js
  `);
});