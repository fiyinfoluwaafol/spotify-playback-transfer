/**
 * Security helpers: automation key validation, OAuth state management, cookie helpers
 */

import { Env } from './storage';

/**
 * Check if the request has a valid automation key
 */
export function checkAutomationKey(request: Request, env: Env): boolean {
  const providedKey = request.headers.get('X-Automation-Key');
  return providedKey === env.AUTOMATION_KEY;
}

/**
 * Generate a random state string for OAuth CSRF protection
 * Uses Web Crypto API to generate 32 random bytes, encoded as base64url
 */
export function generateState(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  
  // Convert to base64url (base64 but URL-safe)
  let base64 = '';
  for (let i = 0; i < array.length; i++) {
    base64 += String.fromCharCode(array[i]);
  }
  const base64url = btoa(base64)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
  
  return base64url;
}

/**
 * Parse cookies from Cookie header
 */
function parseCookies(cookieHeader: string | null): Record<string, string> {
  const cookies: Record<string, string> = {};
  
  if (!cookieHeader) {
    return cookies;
  }

  cookieHeader.split(';').forEach(cookie => {
    const [name, ...valueParts] = cookie.trim().split('=');
    if (name && valueParts.length > 0) {
      cookies[name] = decodeURIComponent(valueParts.join('='));
    }
  });

  return cookies;
}

/**
 * Get the OAuth state from the request cookie
 */
export function getStateCookie(request: Request): string | null {
  const cookieHeader = request.headers.get('Cookie');
  const cookies = parseCookies(cookieHeader);
  return cookies.oauth_state || null;
}

/**
 * Create a Set-Cookie header value for the OAuth state
 */
export function createStateCookie(state: string): string {
  const maxAge = 600; // 10 minutes in seconds
  return `oauth_state=${state}; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}; Path=/`;
}

/**
 * Create a Set-Cookie header to clear the OAuth state cookie
 */
export function clearStateCookie(): string {
  return `oauth_state=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=/`;
}

/**
 * Validate that the stored state matches the received state
 */
export function validateState(stored: string | null, received: string): boolean {
  return stored !== null && stored === received;
}

