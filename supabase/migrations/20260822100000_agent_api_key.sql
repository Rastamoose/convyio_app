-- Encrypted OpenAI API key for hosted agents that skip local pairing
-- entirely. Nullable: only set for provider = 'openai' agents created
-- through the "paste a key" flow. Ciphertext only — encryption/decryption
-- happens in packages/server/src/crypto/secretBox.ts using AGENT_SECRET_KEY.
alter table agent_invites add column api_key_ciphertext text;
