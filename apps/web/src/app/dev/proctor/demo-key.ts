/**
 * Demo HMAC key shared by the page and the mock server. It protects nothing: it only lets the mock
 * server show accept/duplicate/bad-signature. Never reuse it, never put a real key in the bundle.
 */
export const DEMO_HMAC_KEY_B64 = btoa('demo-key-demo-key-demo-key-12345');
export const DEMO_API_BASE = '/dev/proctor/api';
export const DEMO_MODEL_BASE = '/dev-proctor-models';
