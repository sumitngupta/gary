// Unit tests run against a minimal valid configuration, like a real boot.
// Individual tests override variables as needed.
process.env.SEERR_URL ??= 'http://seerr.test';
process.env.SEERR_API_KEY ??= 'test-seerr-key';
process.env.LLM_API_KEY ??= 'test-llm-key';
