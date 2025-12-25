/**
 * Spotify API client: OAuth URL building, token exchange, refresh, and API fetching
 */

import { Env, Tokens, readTokens, writeTokens } from './storage';

const SPOTIFY_API_BASE = 'https://api.spotify.com/v1';
const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token';
const SPOTIFY_AUTH_URL = 'https://accounts.spotify.com/authorize';

/**
 * Build Spotify OAuth authorization URL
 */
export function buildAuthorizeUrl(state: string, env: Env): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: env.SPOTIFY_CLIENT_ID,
    redirect_uri: env.SPOTIFY_REDIRECT_URI,
    scope: 'user-read-playback-state user-modify-playback-state',
    state: state,
  });

  return `${SPOTIFY_AUTH_URL}?${params.toString()}`;
}

/**
 * Exchange authorization code for access and refresh tokens
 */
export async function exchangeCodeForTokens(
  code: string,
  redirectUri: string,
  env: Env
): Promise<Tokens> {
  const clientId = env.SPOTIFY_CLIENT_ID;
  const clientSecret = env.SPOTIFY_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('Spotify client credentials not configured');
  }

  // Create Basic Auth header using btoa (Web API equivalent of Buffer.from().toString('base64'))
  const credentials = btoa(`${clientId}:${clientSecret}`);

  const response = await fetch(SPOTIFY_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${credentials}`,
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: code,
      redirect_uri: redirectUri,
    }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(`Token exchange failed: ${response.status} ${JSON.stringify(error)}`);
  }

  const data = await response.json();

  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Math.floor(Date.now() / 1000) + (data.expires_in || 3600),
  };
}

/**
 * Refresh access token using refresh token
 */
export async function refreshAccessToken(
  refreshToken: string,
  env: Env
): Promise<Tokens> {
  const clientId = env.SPOTIFY_CLIENT_ID;
  const clientSecret = env.SPOTIFY_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('Spotify client credentials not configured');
  }

  const credentials = btoa(`${clientId}:${clientSecret}`);

  const response = await fetch(SPOTIFY_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${credentials}`,
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(`Token refresh failed: ${response.status} ${JSON.stringify(error)}`);
  }

  const data = await response.json();

  // Spotify may or may not return a new refresh_token
  // If not provided, we need to keep the old one
  // But we need to read the current tokens to get the refresh_token
  const currentTokens = await readTokens(env);

  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token || currentTokens?.refresh_token || refreshToken,
    expires_at: Math.floor(Date.now() / 1000) + (data.expires_in || 3600),
  };
}

/**
 * Get access token, refreshing if needed
 * Checks if token is expired or expiring within 60 seconds
 */
export async function getAccessToken(env: Env): Promise<string | null> {
  const tokens = await readTokens(env);

  if (!tokens) {
    return null;
  }

  // Check if token is expired or expiring within 60 seconds
  const now = Math.floor(Date.now() / 1000);
  const expiresIn = tokens.expires_at - now;

  if (tokens.expires_at > now + 60) {
    // Token is still valid
    return tokens.access_token;
  }

  // Token needs refresh
  try {
    const newTokens = await refreshAccessToken(tokens.refresh_token, env);
    await writeTokens(newTokens, env);
    return newTokens.access_token;
  } catch (error) {
    console.error('Error refreshing token:', error);
    return null;
  }
}

/**
 * Fetch from Spotify API with automatic token management
 * Handles 401 errors by refreshing token and retrying once
 */
export async function spotifyFetch(
  path: string,
  options: RequestInit,
  env: Env
): Promise<Response> {
  // Ensure we have a valid access token
  let accessToken = await getAccessToken(env);

  if (!accessToken) {
    throw new Error('No access token available');
  }

  const url = path.startsWith('http') ? path : `${SPOTIFY_API_BASE}${path}`;

  // Make the request with Authorization header
  const response = await fetch(url, {
    ...options,
    headers: {
      ...options.headers,
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  });

  // If 401, try refreshing token and retry once
  if (response.status === 401) {
    const tokens = await readTokens(env);
    if (!tokens) {
      return response;
    }

    try {
      const newTokens = await refreshAccessToken(tokens.refresh_token, env);
      await writeTokens(newTokens, env);
      const refreshedToken = newTokens.access_token;

      // Retry with new token
      return fetch(url, {
        ...options,
        headers: {
          ...options.headers,
          Authorization: `Bearer ${refreshedToken}`,
          'Content-Type': 'application/json',
        },
      });
    } catch (error) {
      // Refresh failed, return original response
      return response;
    }
  }

  return response;
}

/**
 * Check if error response indicates Premium is required
 */
export function isPremiumRequiredError(response: Response): boolean {
  return response.status === 403;
}

/**
 * Extract error message from Spotify API response
 */
export async function getSpotifyErrorMessage(response: Response): Promise<string> {
  try {
    const data = await response.json();
    if (data.error?.message) {
      return data.error.message;
    }
    if (data.error?.status === 403) {
      return 'Spotify Premium is required for playback control';
    }
  } catch {
    // Ignore JSON parse errors
  }

  return `Spotify API error: ${response.status} ${response.statusText}`;
}

