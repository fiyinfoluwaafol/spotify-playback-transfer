# Spotify Echo Dot Transfer - Cloudflare Worker

A Cloudflare Worker that provides Spotify OAuth authentication and playback transfer functionality, specifically designed to transfer playback to Echo Dot devices. This Worker can be triggered from iPhone Shortcuts using an Automation Key header.

## Features

- **Spotify OAuth Flow**: Authorization Code Flow with automatic token refresh
- **Device Transfer**: Transfer playback to any Spotify Connect device
- **Echo Dot Auto-Detection**: Automatically find and transfer to Echo Dot devices
- **iPhone Shortcuts Integration**: Secure API access via Automation Key header
- **Token Storage**: Persistent token storage using Cloudflare KV
- **CORS Support**: Ready for web and mobile app integration

## Prerequisites

- Node.js 18+ and npm
- Cloudflare account (free tier works)
- Wrangler CLI installed globally: `npm install -g wrangler`
- Spotify Developer account with a registered app

## Setup Instructions

### 1. Install Dependencies

```bash
npm install
```

### 2. Create KV Namespace

Create a KV namespace for storing Spotify tokens:

```bash
wrangler kv namespace create "TOKENS_KV"
```

This will output something like:
```
🌀  Creating namespace with title "spotify-echo-worker-TOKENS_KV"
✨  Success!
Add the following to your configuration file in your kv_namespaces array:
{ binding = "TOKENS_KV", id = "abc123def456..." }
```

Copy the `id` value and update `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "TOKENS_KV"
id = "abc123def456..."  # Replace with your actual namespace ID
```

### 3. Set Wrangler Secrets

Set all required secrets using Wrangler:

```bash
# Spotify OAuth credentials
wrangler secret put SPOTIFY_CLIENT_ID
wrangler secret put SPOTIFY_CLIENT_SECRET
wrangler secret put SPOTIFY_REDIRECT_URI
wrangler secret put AUTOMATION_KEY
wrangler secret put BASE_URL
```

When prompted, enter the values:
- **SPOTIFY_CLIENT_ID**: Your Spotify app's Client ID
- **SPOTIFY_CLIENT_SECRET**: Your Spotify app's Client Secret
- **SPOTIFY_REDIRECT_URI**: `https://<your-worker-subdomain>.workers.dev/callback` (you'll get the subdomain after first deploy)
- **AUTOMATION_KEY**: A secure random string for API authentication (e.g., generate with `openssl rand -hex 32`)
- **BASE_URL**: `https://<your-worker-subdomain>.workers.dev`

### 4. Configure Spotify App Redirect URI

1. Go to [Spotify Developer Dashboard](https://developer.spotify.com/dashboard)
2. Select your app
3. Click "Edit Settings"
4. Add your redirect URI: `https://<your-worker-subdomain>.workers.dev/callback`
5. Save changes

**Note**: You'll need to deploy the worker first to get the subdomain, then update the redirect URI in Spotify.

### 5. Deploy the Worker

```bash
npm run deploy
```

After deployment, Wrangler will output your worker URL:
```
✨  Successfully published your Worker to the following routes:
   https://spotify-echo-worker.<your-subdomain>.workers.dev
```

### 6. Update Redirect URI (if needed)

If you deployed before setting the redirect URI secret, update it:

```bash
wrangler secret put SPOTIFY_REDIRECT_URI
# Enter: https://spotify-echo-worker.<your-subdomain>.workers.dev/callback
```

Then update your Spotify app settings with the same redirect URI.

## Local Development

### Setup Local Environment Variables

Wrangler uses a `.dev.vars` file for local development secrets. This is much easier than setting secrets one by one!

1. Copy the example file:
   ```bash
   cp .dev.vars.example .dev.vars
   ```

2. Edit `.dev.vars` and fill in your values:
   ```env
   SPOTIFY_CLIENT_ID=your_spotify_client_id_here
   SPOTIFY_CLIENT_SECRET=your_spotify_client_secret_here
   SPOTIFY_REDIRECT_URI=http://127.0.0.1:8787/callback
   AUTOMATION_KEY=your_automation_key_here
   BASE_URL=http://127.0.0.1:8787
   ```

   **Local Development Values:**
   - **SPOTIFY_REDIRECT_URI**: `http://127.0.0.1:8787/callback` (Spotify requires `127.0.0.1`, not `localhost`)
   - **BASE_URL**: `http://127.0.0.1:8787`
   - **SPOTIFY_CLIENT_ID** and **SPOTIFY_CLIENT_SECRET**: Your Spotify app credentials
   - **AUTOMATION_KEY**: Any secure random string (e.g., generate with `openssl rand -hex 32`)

3. **Important**: Add `http://127.0.0.1:8787/callback` as a redirect URI in your Spotify app settings:
   - Go to [Spotify Developer Dashboard](https://developer.spotify.com/dashboard)
   - Select your app
   - Click "Edit Settings"
   - Add `http://127.0.0.1:8787/callback` to Redirect URIs
   - Save changes

### Run Local Development Server

```bash
npm run dev
```

This starts Wrangler's local development server. You can access it at `http://localhost:8787` or `http://127.0.0.1:8787`.

**Note**: The `.dev.vars` file is automatically loaded by Wrangler and is gitignored (secrets won't be committed).

## API Endpoints

### `GET /health`

Health check endpoint. No authentication required.

**Response:**
```json
{ "ok": true }
```

### `GET /login`

Initiates Spotify OAuth flow. Redirects to Spotify authorization page.

**No authentication required.**

### `GET /callback`

OAuth callback handler. Exchanges authorization code for tokens and stores them in KV.

**No authentication required.**

**Query Parameters:**
- `code`: Authorization code from Spotify
- `state`: OAuth state parameter (validated against cookie)

### `GET /api/devices`

Returns list of available Spotify Connect devices.

**Requires:**
- `X-Automation-Key` header matching `AUTOMATION_KEY` secret
- Valid Spotify tokens in KV (visit `/login` first)

**Response:**
```json
{
  "devices": [
    {
      "id": "device_id",
      "name": "Device Name",
      "type": "Speaker",
      "is_active": true,
      "is_private_session": false,
      "is_restricted": false,
      "volume_percent": 50
    }
  ]
}
```

### `POST /api/transfer`

Transfers playback to a specified device.

**Requires:**
- `X-Automation-Key` header matching `AUTOMATION_KEY` secret
- Valid Spotify tokens in KV

**Request Body:**
```json
{
  "deviceId": "device_id_here",
  "play": true  // optional, defaults to true
}
```

**Response:**
```json
{
  "success": true,
  "message": "Playback transferred successfully"
}
```

### `POST /api/transfer/echo`

Automatically finds and transfers playback to an Echo Dot device.

**Requires:**
- `X-Automation-Key` header matching `AUTOMATION_KEY` secret
- Valid Spotify tokens in KV

**No request body required.**

**Response (Success):**
```json
{
  "success": true,
  "message": "Playback transferred to Echo Dot",
  "device": {
    "id": "device_id",
    "name": "Echo Dot"
  }
}
```

**Response (Multiple Echo Devices - 409):**
```json
{
  "ok": false,
  "error": {
    "code": "MULTIPLE_ECHO_DEVICES",
    "message": "Multiple Echo devices found. Please specify which device to use."
  },
  "devices": [
    { "id": "device1_id", "name": "Echo Dot Kitchen" },
    { "id": "device2_id", "name": "Echo Dot Bedroom" }
  ]
}
```

**Response (No Echo Device - 404):**
```json
{
  "ok": false,
  "error": {
    "code": "NO_ECHO_DEVICE",
    "message": "Wake your Echo, open Spotify, start playback once."
  }
}
```

## Testing

### Test with cURL

**Health Check:**
```bash
curl https://your-worker.workers.dev/health
```

**Get Devices:**
```bash
curl -H "X-Automation-Key: your-automation-key" \
  https://your-worker.workers.dev/api/devices
```

**Transfer to Echo:**
```bash
curl -X POST \
  -H "X-Automation-Key: your-automation-key" \
  -H "Content-Type: application/json" \
  https://your-worker.workers.dev/api/transfer/echo
```

**Transfer to Specific Device:**
```bash
curl -X POST \
  -H "X-Automation-Key: your-automation-key" \
  -H "Content-Type: application/json" \
  -d '{"deviceId": "device_id_here", "play": true}' \
  https://your-worker.workers.dev/api/transfer
```

### Test with iPhone Shortcuts

1. Open Shortcuts app
2. Create a new shortcut
3. Add "Get Contents of URL" action
4. Configure:
   - **URL**: `https://your-worker.workers.dev/api/transfer/echo`
   - **Method**: POST
   - **Headers**: 
     - Key: `X-Automation-Key`
     - Value: `your-automation-key`
5. Add "Get Text from Input" to see the response
6. Test the shortcut

**Example Shortcut Configuration:**
- **URL**: `https://spotify-echo-worker.your-subdomain.workers.dev/api/transfer/echo`
- **Method**: POST
- **Headers**:
  ```
  X-Automation-Key: your-secret-key-here
  ```

## Error Responses

All API errors follow this format:

```json
{
  "ok": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable error message"
  }
}
```

**Common Error Codes:**
- `NOT_AUTHENTICATED`: No tokens found, visit `/login`
- `INVALID_AUTOMATION_KEY`: Missing or incorrect `X-Automation-Key` header
- `PREMIUM_REQUIRED`: Spotify Premium is required for playback control
- `NO_ACTIVE_DEVICE`: No active Spotify device found
- `NO_ECHO_DEVICE`: No Echo Dot device found
- `MULTIPLE_ECHO_DEVICES`: Multiple Echo devices found (409)
- `SPOTIFY_ERROR`: Generic Spotify API error
- `INTERNAL_ERROR`: Server error

## Architecture

- **Runtime**: Cloudflare Workers (V8 isolate)
- **Storage**: Cloudflare KV for token persistence
- **Routing**: Manual routing using `URL` API (no Express)
- **OAuth**: Authorization Code Flow (server-side secret)
- **Token Refresh**: Automatic refresh when expired or expiring within 60 seconds

## File Structure

```
apps/worker/
├── src/
│   ├── index.ts      # Main router and request handlers
│   ├── spotify.ts    # Spotify API client (OAuth, refresh, fetch)
│   ├── storage.ts    # KV read/write helpers
│   └── security.ts   # Automation key, cookies, state validation
├── wrangler.toml     # Wrangler configuration
├── package.json      # Dependencies and scripts
└── tsconfig.json     # TypeScript configuration
```

## Security Notes

- **Automation Key**: All `/api/*` endpoints require the `X-Automation-Key` header. Keep this secret secure.
- **OAuth State**: CSRF protection via state parameter stored in HttpOnly cookie
- **Token Storage**: Tokens stored securely in Cloudflare KV (encrypted at rest)
- **HTTPS Only**: Worker runs over HTTPS by default

## Troubleshooting

### "Not connected. Visit /login"
- Visit `https://your-worker.workers.dev/login` to authenticate
- Make sure redirect URI matches in Spotify app settings

### "Invalid or missing X-Automation-Key header"
- Check that you're sending the `X-Automation-Key` header
- Verify the value matches your `AUTOMATION_KEY` secret

### "No Echo Dot found"
- Make sure your Echo device is powered on
- Open Spotify on the Echo and start playback once
- The device should appear in `/api/devices`

### Token Refresh Issues
- KV is eventually consistent; if refresh fails, try again
- If persistent, visit `/login` to re-authenticate

## License

ISC

