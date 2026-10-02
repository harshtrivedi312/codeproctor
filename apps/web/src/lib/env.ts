// NEXT_PUBLIC_* values must be read with static property access so Next.js can inline them.
export const apiBaseUrl: string = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
export const mockingEnabled: boolean = process.env.NEXT_PUBLIC_API_MOCKING === 'enabled';
