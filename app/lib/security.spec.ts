import { describe, expect, it, vi } from 'vitest';
import {
  checkRateLimit,
  createSecurityHeaders,
  validateApiKeyFormat,
  sanitizeErrorMessage,
  withSecurity,
} from './security';

describe('security', () => {
  describe('checkRateLimit', () => {
    it('should allow first request', () => {
      const request = new Request('http://localhost/api/test', {
        headers: { 'x-forwarded-for': '192.168.1.100' },
      });
      const result = checkRateLimit(request, '/api/test');
      expect(result.allowed).toBe(true);
    });

    it('should allow requests within general API rate limit', () => {
      const request = new Request('http://localhost/api/test', {
        headers: { 'x-forwarded-for': '10.0.0.1' },
      });

      // General API limit is 100 per 15 min
      for (let i = 0; i < 50; i++) {
        const result = checkRateLimit(request, '/api/some-endpoint');
        expect(result.allowed).toBe(true);
      }
    });

    it('should use specific LLM rate limit over wildcard', () => {
      const request = new Request('http://localhost/api/llmcall', {
        headers: { 'x-forwarded-for': '10.0.0.20' },
      });

      // LLM-specific limit is 10 per minute (more restrictive than /api/* at 100)
      for (let i = 0; i < 10; i++) {
        const result = checkRateLimit(request, '/api/llmcall');
        expect(result.allowed).toBe(true);
      }

      const blockedResult = checkRateLimit(request, '/api/llmcall');
      expect(blockedResult.allowed).toBe(false);
      expect(blockedResult.resetTime).toBeDefined();
    });

    it('should allow requests for unknown endpoints (no rate limit rule)', () => {
      const request = new Request('http://localhost/unknown', {
        headers: { 'x-forwarded-for': '10.0.0.3' },
      });
      const result = checkRateLimit(request, '/unknown');
      expect(result.allowed).toBe(true);
    });

    it('should track rate limits per IP', () => {
      const request1 = new Request('http://localhost/api/llmcall', {
        headers: { 'x-forwarded-for': '10.0.0.4' },
      });
      const request2 = new Request('http://localhost/api/llmcall', {
        headers: { 'x-forwarded-for': '10.0.0.5' },
      });

      // Exhaust IP 1's LLM limit (10)
      for (let i = 0; i < 10; i++) {
        checkRateLimit(request1, '/api/llmcall');
      }

      expect(checkRateLimit(request1, '/api/llmcall').allowed).toBe(false);

      // IP 2 should still be allowed
      const result = checkRateLimit(request2, '/api/llmcall');
      expect(result.allowed).toBe(true);
    });

    it('should use cf-connecting-ip header when available', () => {
      const request = new Request('http://localhost/api/test', {
        headers: {
          'cf-connecting-ip': '1.2.3.4',
          'x-forwarded-for': '5.6.7.8',
          'x-real-ip': '9.10.11.12',
        },
      });

      // Should use cf-connecting-ip (1.2.3.4) as the key
      const result = checkRateLimit(request, '/api/test');
      expect(result.allowed).toBe(true);
    });

    it('should match prefix patterns like /api/github-*', () => {
      const request = new Request('http://localhost/api/github-repos', {
        headers: { 'x-forwarded-for': '10.0.0.60' },
      });

      // /api/github-* has 30 requests per minute limit
      for (let i = 0; i < 30; i++) {
        const result = checkRateLimit(request, '/api/github-repos');
        expect(result.allowed).toBe(true);
      }

      const blockedResult = checkRateLimit(request, '/api/github-repos');
      expect(blockedResult.allowed).toBe(false);
    });

    it('should apply general wildcard when no specific match', () => {
      const request = new Request('http://localhost/api/random-thing', {
        headers: { 'x-forwarded-for': '10.0.0.70' },
      });

      // /api/* has 100 requests per 15 min
      for (let i = 0; i < 100; i++) {
        const result = checkRateLimit(request, '/api/random-thing');
        expect(result.allowed).toBe(true);
      }

      const blockedResult = checkRateLimit(request, '/api/random-thing');
      expect(blockedResult.allowed).toBe(false);
    });
  });

  describe('createSecurityHeaders', () => {
    it('should return all required security headers', () => {
      const headers = createSecurityHeaders();

      expect(headers['X-Frame-Options']).toBe('DENY');
      expect(headers['X-Content-Type-Options']).toBe('nosniff');
      expect(headers['X-XSS-Protection']).toBe('1; mode=block');
      expect(headers['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
    });

    it('should include Content-Security-Policy', () => {
      const headers = createSecurityHeaders();
      const csp = headers['Content-Security-Policy'];

      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("script-src 'self'");
      expect(csp).toContain("style-src 'self'");
      expect(csp).toContain("frame-src 'self' http://localhost:*");
      expect(csp).toContain("object-src 'none'");
    });

    it('should include LLM provider connect sources in CSP', () => {
      const headers = createSecurityHeaders();
      const csp = headers['Content-Security-Policy'];

      expect(csp).toContain('https://api.openai.com');
      expect(csp).toContain('https://api.anthropic.com');
      expect(csp).toContain('https://generativelanguage.googleapis.com');
      expect(csp).toContain('https://api.groq.com');
    });

    it('should include Permissions-Policy', () => {
      const headers = createSecurityHeaders();

      expect(headers['Permissions-Policy']).toContain('camera=()');
      expect(headers['Permissions-Policy']).toContain('microphone=()');
      expect(headers['Permissions-Policy']).toContain('geolocation=()');
    });

    it('should not include HSTS in development', () => {
      const headers = createSecurityHeaders();

      // In test environment (not production), HSTS should not be present
      if (process.env.NODE_ENV !== 'production') {
        expect(headers).not.toHaveProperty('Strict-Transport-Security');
      }
    });
  });

  describe('validateApiKeyFormat', () => {
    it('should reject empty string', () => {
      expect(validateApiKeyFormat('', 'openai')).toBe(false);
    });

    it('should reject null/undefined', () => {
      expect(validateApiKeyFormat(null as unknown as string, 'openai')).toBe(false);
      expect(validateApiKeyFormat(undefined as unknown as string, 'openai')).toBe(false);
    });

    it('should reject non-string values', () => {
      expect(validateApiKeyFormat(123 as unknown as string, 'openai')).toBe(false);
    });

    it('should reject placeholder keys', () => {
      expect(validateApiKeyFormat('your_api_key_here', 'openai')).toBe(false);
      expect(validateApiKeyFormat('sk-your_key_here_please_replace', 'openai')).toBe(false);
    });

    it('should reject keys shorter than minimum length', () => {
      // Anthropic requires 50+ chars
      expect(validateApiKeyFormat('short-key', 'anthropic')).toBe(false);
    });

    it('should accept valid-length API keys', () => {
      const validKey = 'sk-' + 'a'.repeat(100);
      expect(validateApiKeyFormat(validKey, 'openai')).toBe(true);
    });

    it('should use lower minimum for unknown providers', () => {
      const key = 'a'.repeat(25);
      expect(validateApiKeyFormat(key, 'unknown-provider')).toBe(true);
    });

    it('should use provider-specific minimum lengths', () => {
      // Google has min 30
      expect(validateApiKeyFormat('a'.repeat(29), 'google')).toBe(false);
      expect(validateApiKeyFormat('a'.repeat(30), 'google')).toBe(true);

      // Anthropic has min 50
      expect(validateApiKeyFormat('a'.repeat(49), 'anthropic')).toBe(false);
      expect(validateApiKeyFormat('a'.repeat(50), 'anthropic')).toBe(true);
    });
  });

  describe('sanitizeErrorMessage', () => {
    it('should return full message in development mode', () => {
      const error = new Error('API key sk-12345 is invalid');
      const result = sanitizeErrorMessage(error, true);
      expect(result).toBe('API key sk-12345 is invalid');
    });

    it('should hide API key references in production', () => {
      const error = new Error('API key sk-12345 is invalid');
      const result = sanitizeErrorMessage(error, false);
      expect(result).toBe('Authentication failed');
    });

    it('should hide token references in production', () => {
      const error = new Error('token expired');
      const result = sanitizeErrorMessage(error, false);
      expect(result).toBe('Authentication failed');
    });

    it('should handle rate limit errors', () => {
      const error = new Error('rate limit exceeded');
      const result = sanitizeErrorMessage(error, false);
      expect(result).toBe('Rate limit exceeded. Please try again later.');
    });

    it('should handle 429 errors', () => {
      const error = new Error('HTTP 429 Too Many Requests');
      const result = sanitizeErrorMessage(error, false);
      expect(result).toBe('Rate limit exceeded. Please try again later.');
    });

    it('should return generic message for unknown errors in production', () => {
      const error = new Error('Something went wrong');
      const result = sanitizeErrorMessage(error, false);
      expect(result).toBe('An unexpected error occurred');
    });

    it('should handle non-Error objects', () => {
      const result = sanitizeErrorMessage('string error', true);
      expect(result).toBe('string error');
    });

    it('should handle non-Error objects in production', () => {
      const result = sanitizeErrorMessage('string error', false);
      expect(result).toBe('An unexpected error occurred');
    });
  });

  describe('withSecurity', () => {
    it('should reject disallowed HTTP methods', async () => {
      const handler = vi.fn().mockResolvedValue(new Response('OK'));
      const secured = withSecurity(handler, {
        allowedMethods: ['GET'],
        rateLimit: false,
      });

      const response = await secured({
        request: new Request('http://localhost/api/test', { method: 'POST' }),
        params: {},
        context: {},
      } as any);

      expect(response.status).toBe(405);
      expect(handler).not.toHaveBeenCalled();
    });

    it('should allow permitted HTTP methods', async () => {
      const handler = vi.fn().mockResolvedValue(new Response('OK'));
      const secured = withSecurity(handler, {
        allowedMethods: ['GET', 'POST'],
        rateLimit: false,
      });

      const response = await secured({
        request: new Request('http://localhost/api/test', { method: 'GET' }),
        params: {},
        context: {},
      } as any);

      expect(response.status).toBe(200);
      expect(handler).toHaveBeenCalled();
    });

    it('should add security headers to response', async () => {
      const handler = vi.fn().mockResolvedValue(new Response('OK'));
      const secured = withSecurity(handler, { rateLimit: false });

      const response = await secured({
        request: new Request('http://localhost/api/test'),
        params: {},
        context: {},
      } as any);

      expect(response.headers.get('X-Frame-Options')).toBe('DENY');
      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    });

    it('should handle handler errors gracefully', async () => {
      const handler = vi.fn().mockRejectedValue(new Error('Internal failure'));
      const secured = withSecurity(handler, { rateLimit: false });

      const response = await secured({
        request: new Request('http://localhost/api/test'),
        params: {},
        context: {},
      } as any);

      expect(response.status).toBe(500);

      const body = await response.json();
      expect(body.error).toBe(true);
    });

    it('should apply rate limiting by default', async () => {
      const handler = vi.fn().mockResolvedValue(new Response('OK'));
      const secured = withSecurity(handler);

      // Use a unique IP to avoid collisions with other tests
      const request = new Request('http://localhost/api/llmcall', {
        headers: { 'x-forwarded-for': '99.99.99.99' },
      });

      // LLM specific rate limit is 10 per minute
      for (let i = 0; i < 10; i++) {
        await secured({ request, params: {}, context: {} } as any);
      }

      const response = await secured({ request, params: {}, context: {} } as any);
      expect(response.status).toBe(429);
    });
  });
});
