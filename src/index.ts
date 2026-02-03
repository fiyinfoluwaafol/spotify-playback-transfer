/**
 * Main Cloudflare Worker entry point
 * Handles routing and all endpoints
 */

import { Env, readTokens, writeTokens } from './storage';
import {
  checkAutomationKey,
  generateState,
  getStateCookie,
  createStateCookie,
  clearStateCookie,
  validateState,
} from './security';
import {
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  spotifyFetch,
  isPremiumRequiredError,
  getSpotifyErrorMessage,
  getAccessToken,
} from './spotify';

// Spotify API types
interface SpotifyDevice {
  id: string;
  is_active: boolean;
  is_private_session: boolean;
  is_restricted: boolean;
  name: string;
  type: string;
  volume_percent: number | null;
}

interface DevicesResponse {
  devices: SpotifyDevice[];
}

/**
 * Add CORS headers to response
 */
function addCorsHeaders(response: Response): Response {
  const newResponse = new Response(response.body, response);
  newResponse.headers.set('Access-Control-Allow-Origin', '*');
  newResponse.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  newResponse.headers.set('Access-Control-Allow-Headers', 'Content-Type, X-Automation-Key');
  return newResponse;
}

/**
 * Create JSON error response
 */
function jsonError(code: string, message: string, status: number = 400): Response {
  const body = JSON.stringify({
    ok: false,
    error: { code, message },
  });
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Create JSON success response
 */
function jsonSuccess(data: any, status: number = 200): Response {
  const body = JSON.stringify(data);
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const TRANSFER_RETRY_ATTEMPTS = 3;
const TRANSFER_RETRY_BASE_DELAY_MS = 350;
const TRANSFER_RETRY_MAX_DELAY_MS = 2000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldRetryTransfer(response: Response): boolean {
  if (response.status === 404 || response.status === 429) {
    return true;
  }
  return response.status >= 500 && response.status <= 504;
}

function getRetryDelayMs(attempt: number, response?: Response): number {
  if (response?.status === 429) {
    const retryAfter = response.headers.get('Retry-After');
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (!Number.isNaN(seconds)) {
        return Math.min(seconds * 1000, TRANSFER_RETRY_MAX_DELAY_MS);
      }
      const retryDate = Date.parse(retryAfter);
      if (!Number.isNaN(retryDate)) {
        const delta = retryDate - Date.now();
        if (delta > 0) {
          return Math.min(delta, TRANSFER_RETRY_MAX_DELAY_MS);
        }
      }
    }
  }

  const delay = TRANSFER_RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
  return Math.min(delay, TRANSFER_RETRY_MAX_DELAY_MS);
}

async function retryTransfer(makeRequest: () => Promise<Response>): Promise<Response> {
  let lastResponse: Response | null = null;

  for (let attempt = 1; attempt <= TRANSFER_RETRY_ATTEMPTS; attempt++) {
    try {
      const response = await makeRequest();
      lastResponse = response;

      if (response.ok || !shouldRetryTransfer(response) || attempt === TRANSFER_RETRY_ATTEMPTS) {
        return response;
      }

      const delayMs = getRetryDelayMs(attempt, response);
      console.warn(`Transfer failed with ${response.status}. Retrying in ${delayMs}ms...`);
      await sleep(delayMs);
    } catch (error) {
      if (attempt === TRANSFER_RETRY_ATTEMPTS) {
        throw error;
      }
      const delayMs = getRetryDelayMs(attempt);
      console.warn(`Transfer error. Retrying in ${delayMs}ms...`, error);
      await sleep(delayMs);
    }
  }

  return lastResponse ?? new Response('Transfer retry attempts exhausted', { status: 500 });
}

/**
 * Handle OPTIONS preflight requests
 */
function handleOptions(): Response {
  return addCorsHeaders(new Response(null, { status: 204 }));
}

/**
 * GET /health
 */
function handleHealth(): Response {
  return jsonSuccess({ ok: true });
}

/**
 * GET /login
 * Redirects to Spotify authorization URL
 */
function handleLogin(request: Request, env: Env): Response {
  const state = generateState();
  const authUrl = buildAuthorizeUrl(state, env);

  return new Response(null, {
    status: 302,
    headers: {
      Location: authUrl,
      'Set-Cookie': createStateCookie(state),
    },
  });
}

/**
 * GET /callback
 * Handles OAuth callback, exchanges code for tokens, saves them
 */
async function handleCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');

  // Handle OAuth errors
  if (error) {
    return new Response(
      `
      <html>
        <head><title>Authorization Failed</title></head>
        <body>
          <h1>Authorization Failed</h1>
          <p>Error: ${error}</p>
          <p><a href="/login">Try again</a></p>
        </body>
      </html>
      `,
      {
        status: 400,
        headers: { 'Content-Type': 'text/html' },
      }
    );
  }

  // Validate required parameters
  if (!code || !state) {
    return new Response(
      `
      <html>
        <head><title>Authorization Failed</title></head>
        <body>
          <h1>Authorization Failed</h1>
          <p>Missing authorization code or state parameter.</p>
          <p><a href="/login">Try again</a></p>
        </body>
      </html>
      `,
      {
        status: 400,
        headers: { 'Content-Type': 'text/html' },
      }
    );
  }

  // Validate state (CSRF protection)
  const storedState = getStateCookie(request);
  if (!validateState(storedState, state)) {
    return new Response(
      `
      <html>
        <head><title>Authorization Failed</title></head>
        <body>
          <h1>Authorization Failed</h1>
          <p>Invalid state parameter. Please try again.</p>
          <p><a href="/login">Try again</a></p>
        </body>
      </html>
      `,
      {
        status: 400,
        headers: { 'Content-Type': 'text/html' },
      }
    );
  }

  // Exchange code for tokens
  try {
    const tokens = await exchangeCodeForTokens(code, env.SPOTIFY_REDIRECT_URI, env);
    await writeTokens(tokens, env);

    const response = new Response(
      `
      <html>
        <head>
          <title>Success!</title>
          <style>
            body {
              font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
              display: flex;
              align-items: center;
              justify-content: center;
              min-height: 100vh;
              margin: 0;
              background-color: #f5f5f5;
            }
            .container {
              background: white;
              padding: 40px;
              border-radius: 8px;
              box-shadow: 0 2px 8px rgba(0,0,0,0.1);
              text-align: center;
            }
            h1 {
              color: #1db954;
              margin-bottom: 20px;
            }
            p {
              color: #666;
              margin-bottom: 30px;
            }
            .success {
              color: #155724;
              background-color: #d4edda;
              border: 1px solid #c3e6cb;
              padding: 12px;
              border-radius: 4px;
              margin-bottom: 20px;
            }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>✓ Successfully Connected!</h1>
            <div class="success">
              Your Spotify account has been connected successfully.
            </div>
            <p>You can now use the API endpoints to control playback.</p>
            <p><small>You can close this window.</small></p>
          </div>
        </body>
      </html>
      `,
      {
        status: 200,
        headers: {
          'Content-Type': 'text/html',
          'Set-Cookie': clearStateCookie(),
        },
      }
    );

    return response;
  } catch (error) {
    return new Response(
      `
      <html>
        <head><title>Error</title></head>
        <body>
          <h1>Error</h1>
          <p>Failed to exchange authorization code for tokens.</p>
          <p>Error: ${error instanceof Error ? error.message : 'Unknown error'}</p>
          <p><a href="/login">Try again</a></p>
        </body>
      </html>
      `,
      {
        status: 500,
        headers: { 'Content-Type': 'text/html' },
      }
    );
  }
}

/**
 * GET /api/devices
 * Returns list of available Spotify Connect devices
 */
async function handleGetDevices(env: Env): Promise<Response> {
  try {
    const response = await spotifyFetch('/me/player/devices', { method: 'GET' }, env);

    if (!response.ok) {
      if (isPremiumRequiredError(response)) {
        return addCorsHeaders(
          jsonError('PREMIUM_REQUIRED', 'Spotify Premium is required for playback control.', 403)
        );
      }

      const errorMessage = await getSpotifyErrorMessage(response);
      return addCorsHeaders(jsonError('SPOTIFY_ERROR', errorMessage, response.status));
    }

    const data: DevicesResponse = await response.json();
    return addCorsHeaders(jsonSuccess({ devices: data.devices || [] }));
  } catch (error) {
    console.error('Error fetching devices:', error);
    return addCorsHeaders(jsonError('INTERNAL_ERROR', 'Failed to fetch devices', 500));
  }
}

/**
 * POST /api/transfer
 * Transfers playback to a specified device
 * Body: { deviceId: string, play?: boolean }
 */
async function handleTransfer(request: Request, env: Env): Promise<Response> {
  try {
    const body = await request.json().catch(() => ({}));
    const { deviceId, play } = body;

    if (!deviceId || typeof deviceId !== 'string') {
      return addCorsHeaders(jsonError('INVALID_REQUEST', 'deviceId is required', 400));
    }

    const response = await retryTransfer(() =>
      spotifyFetch(
        '/me/player',
        {
          method: 'PUT',
          body: JSON.stringify({
            device_ids: [deviceId],
            play: play !== undefined ? play : true,
          }),
        },
        env
      )
    );

    if (!response.ok) {
      if (isPremiumRequiredError(response)) {
        return addCorsHeaders(
          jsonError('PREMIUM_REQUIRED', 'Spotify Premium is required for playback control.', 403)
        );
      }

      if (response.status === 404) {
        return addCorsHeaders(
          jsonError(
            'NO_ACTIVE_DEVICE',
            'No active device found. Please start playing something on Spotify first.',
            404
          )
        );
      }

      const errorMessage = await getSpotifyErrorMessage(response);
      return addCorsHeaders(jsonError('SPOTIFY_ERROR', errorMessage, response.status));
    }

    return addCorsHeaders(
      jsonSuccess({ success: true, message: 'Playback transferred successfully' })
    );
  } catch (error) {
    console.error('Error transferring playback:', error);
    if (error instanceof SyntaxError) {
      return addCorsHeaders(jsonError('INVALID_REQUEST', 'Invalid request body', 400));
    }
    return addCorsHeaders(jsonError('INTERNAL_ERROR', 'Failed to transfer playback', 500));
  }
}

/**
 * POST /api/transfer/echo
 * Transfers playback to Echo Dot device (auto-resolves by name)
 * No body required
 */
async function handleTransferEcho(env: Env): Promise<Response> {
  try {
    // First, get list of devices
    const devicesResponse = await spotifyFetch('/me/player/devices', { method: 'GET' }, env);

    if (!devicesResponse.ok) {
      if (isPremiumRequiredError(devicesResponse)) {
        return addCorsHeaders(
          jsonError('PREMIUM_REQUIRED', 'Spotify Premium is required for playback control.', 403)
        );
      }

      const errorMessage = await getSpotifyErrorMessage(devicesResponse);
      return addCorsHeaders(
        jsonError('SPOTIFY_ERROR', errorMessage, devicesResponse.status)
      );
    }

    const devicesData: DevicesResponse = await devicesResponse.json();
    const devices = devicesData.devices || [];

    // Find devices with "echo" or "dot" in the name (case-insensitive)
    const echoDevices = devices.filter(
      (device) =>
        device.name.toLowerCase().includes('echo') || device.name.toLowerCase().includes('dot')
    );

    if (echoDevices.length === 0) {
      return addCorsHeaders(
        jsonError(
          'NO_ECHO_DEVICE',
          'Wake your Echo, open Spotify, start playback once.',
          404
        )
      );
    }

    // If multiple Echo devices, return 409 with list
    if (echoDevices.length > 1) {
      return addCorsHeaders(
        new Response(
          JSON.stringify({
            ok: false,
            error: {
              code: 'MULTIPLE_ECHO_DEVICES',
              message: 'Multiple Echo devices found. Please specify which device to use.',
            },
            devices: echoDevices.map((d) => ({ id: d.id, name: d.name })),
          }),
          {
            status: 409,
            headers: { 'Content-Type': 'application/json' },
          }
        )
      );
    }

    // Single Echo device found
    const targetDevice = echoDevices[0];

    // Transfer playback to the Echo device
    const transferResponse = await retryTransfer(() =>
      spotifyFetch(
        '/me/player',
        {
          method: 'PUT',
          body: JSON.stringify({
            device_ids: [targetDevice.id],
            play: true,
          }),
        },
        env
      )
    );

    if (!transferResponse.ok) {
      if (isPremiumRequiredError(transferResponse)) {
        return addCorsHeaders(
          jsonError('PREMIUM_REQUIRED', 'Spotify Premium is required for playback control.', 403)
        );
      }

      if (transferResponse.status === 404) {
        return addCorsHeaders(
          jsonError(
            'NO_ACTIVE_DEVICE',
            'No active device found. Please start playing something on Spotify first.',
            404
          )
        );
      }

      const errorMessage = await getSpotifyErrorMessage(transferResponse);
      return addCorsHeaders(
        jsonError('SPOTIFY_ERROR', errorMessage, transferResponse.status)
      );
    }

    return addCorsHeaders(
      jsonSuccess({
        success: true,
        message: `Playback transferred to ${targetDevice.name}`,
        device: {
          id: targetDevice.id,
          name: targetDevice.name,
        },
      })
    );
  } catch (error) {
    console.error('Error transferring to Echo:', error);
    return addCorsHeaders(
      jsonError('INTERNAL_ERROR', 'Failed to transfer playback to Echo Dot', 500)
    );
  }
}

/**
 * Check if user is authenticated (has tokens)
 */
async function requireAuth(env: Env): Promise<Response | null> {
  const tokens = await readTokens(env);

  if (!tokens) {
    return addCorsHeaders(
      jsonError('NOT_AUTHENTICATED', 'Not connected. Visit /login to connect your Spotify account.', 401)
    );
  }

  // Ensure we have a valid access token
  const accessToken = await getAccessToken(env);

  if (!accessToken) {
    return addCorsHeaders(
      jsonError(
        'TOKEN_REFRESH_FAILED',
        'Failed to refresh access token. Please visit /login to reconnect.',
        401
      )
    );
  }

  return null; // Auth successful
}

/**
 * Main request handler
 */
async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // Handle CORS preflight
  if (method === 'OPTIONS' && path.startsWith('/api')) {
    return handleOptions();
  }

  // Health check (no auth required)
  if (method === 'GET' && path === '/health') {
    return handleHealth();
  }

  // Auth routes (no automation key required)
  if (method === 'GET' && path === '/login') {
    return handleLogin(request, env);
  }

  if (method === 'GET' && path === '/callback') {
    return handleCallback(request, env);
  }

  // API routes (require automation key and auth)
  if (path.startsWith('/api')) {
    // Check automation key
    if (!checkAutomationKey(request, env)) {
      return addCorsHeaders(
        jsonError(
          'INVALID_AUTOMATION_KEY',
          'Invalid or missing X-Automation-Key header',
          401
        )
      );
    }

    // Check authentication
    const authError = await requireAuth(env);
    if (authError) {
      return authError;
    }

    // Route to appropriate handler
    if (method === 'GET' && path === '/api/devices') {
      return handleGetDevices(env);
    }

    if (method === 'POST' && path === '/api/transfer') {
      return handleTransfer(request, env);
    }

    if (method === 'POST' && path === '/api/transfer/echo') {
      return handleTransferEcho(env);
    }

    // 404 for unknown API routes
    return addCorsHeaders(jsonError('NOT_FOUND', 'Not found', 404));
  }

  // 404 for unknown routes
  return jsonError('NOT_FOUND', 'Not found', 404);
}

/**
 * Cloudflare Worker export
 */
export default {
  fetch: handleRequest,
};
