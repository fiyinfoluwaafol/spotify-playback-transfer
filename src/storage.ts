/**
 * KV Storage helpers for Spotify tokens
 */

export interface Tokens {
  access_token: string;
  refresh_token: string;
  expires_at: number; // Unix timestamp in seconds
}

export interface Env {
  TOKENS_KV: KVNamespace;
  SPOTIFY_CLIENT_ID: string;
  SPOTIFY_CLIENT_SECRET: string;
  SPOTIFY_REDIRECT_URI: string;
  AUTOMATION_KEY: string;
  BASE_URL: string;
}

const TOKENS_KEY = "spotify_tokens";

/**
 * Read tokens from KV storage
 */
export async function readTokens(env: Env): Promise<Tokens | null> {
  try {
    const data = await env.TOKENS_KV.get(TOKENS_KEY);
    
    if (!data) {
      return null;
    }

    const tokens = JSON.parse(data) as Tokens;

    // Validate token structure
    if (!tokens.access_token || !tokens.refresh_token || !tokens.expires_at) {
      return null;
    }

    return tokens;
  } catch (error) {
    console.error('Error reading tokens from KV:', error);
    return null;
  }
}

/**
 * Write tokens to KV storage
 */
export async function writeTokens(tokens: Tokens, env: Env): Promise<void> {
  try {
    // Validate token structure before writing
    if (!tokens.access_token || !tokens.refresh_token || !tokens.expires_at) {
      throw new Error('Invalid token structure');
    }

    const data = JSON.stringify(tokens);
    await env.TOKENS_KV.put(TOKENS_KEY, data);
  } catch (error) {
    console.error('Error writing tokens to KV:', error);
    throw new Error('Failed to save tokens');
  }
}

