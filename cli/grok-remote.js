#!/usr/bin/env node

/**
 * Grok Remote CLI
 * 
 * This is a proof-of-concept CLI that demonstrates how Grok Build
 * could automatically spin up the remote control backend.
 * 
 * In a real implementation, this would be integrated directly into
 * the Grok Build CLI (e.g. `grok remote` or `grok --mobile`).
 */

const { execSync, spawn } = require('child_process');
const QRCode = require('qrcode-terminal');
const path = require('path');
const fs = require('fs');

const PROJECT_ROOT = path.join(__dirname, '..');
const DOCKER_COMPOSE = path.join(PROJECT_ROOT, 'docker-compose.yml');

console.log('\n🚀 Grok Remote - Starting mobile remote control...\n');

async function startRemote() {
  try {
    // Check if Docker is available
    try {
      execSync('docker --version', { stdio: 'ignore' });
    } catch (e) {
      console.log('❌ Docker is not installed or not running.');
      console.log('   Please install Docker Desktop and try again.');
      process.exit(1);
    }

    console.log('📦 Starting Grok Remote backend (Docker)...\n');

    // Start Docker in detached mode
    execSync('docker-compose up -d --build', {
      cwd: PROJECT_ROOT,
      stdio: 'inherit'
    });

    // Wait a moment for the server to start
    await new Promise(resolve => setTimeout(resolve, 2500));

    // Get the local IP
    let localIP = 'localhost';
    try {
      const ifconfig = execSync('ipconfig getifaddr en0 || ipconfig getifaddr en1 || hostname -I', { encoding: 'utf8' }).trim();
      if (ifconfig) localIP = ifconfig.split('\n')[0].trim();
    } catch (e) {
      // Fallback to localhost
    }

    const url = `http://${localIP}:3000`;
    const apiKey = 'demo-key-2026'; // In real version this would be a secure token

    console.log('\n✅ Grok Remote is running!\n');
    console.log(`   Backend: ${url}`);
    console.log(`   API Key: ${apiKey}\n`);

    // Generate and display QR code in terminal
    const qrPayload = JSON.stringify({
      url: url,
      key: apiKey,
      token: 'grok-remote-demo-2026'
    });

    console.log('📱 Scan this QR code with your phone:\n');

    QRCode.generate(qrPayload, { small: true }, (qr) => {
      console.log(qr);
    });

    console.log('\n💡 Instructions:');
    console.log('   1. Open the Grok Remote PWA on your phone (install from browser if needed)');
    console.log('   2. Tap "Scan QR" and point your camera at the code above');
    console.log('   3. You\'re now remotely controlling Grok from your phone!\n');

    console.log('🛑 To stop: docker-compose down\n');

    // Keep the process alive so user can see the QR
    console.log('Press Ctrl+C to exit (backend keeps running in background)\n');

    // Optional: Open browser automatically
    const open = process.platform === 'darwin' ? 'open' : 
                 process.platform === 'win32' ? 'start' : 'xdg-open';
    
    try {
      execSync(`${open} ${url}`, { stdio: 'ignore' });
    } catch (e) {
      // Browser open failed, no big deal
    }

  } catch (error) {
    console.error('\n❌ Failed to start Grok Remote:');
    console.error(error.message);
    process.exit(1);
  }
}

startRemote();