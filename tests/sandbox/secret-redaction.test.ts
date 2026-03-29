/**
 * Tests for expanded secret pattern detection and deep recursive redaction.
 *
 * Covers: SECRET_PATTERNS in constants.ts, sanitizeSecrets() and redactSecretsDeep() in sanitize.ts
 *
 * NOTE: Test tokens are constructed at runtime to avoid triggering GitHub push protection.
 * None of these are real credentials — they are synthetic patterns that match our regex.
 */

import { describe, expect, it } from "bun:test";

import { SECRET_PATTERNS } from "../../cli/selftune/constants.js";
import { redactSecretsDeep, sanitizeSecrets } from "../../cli/selftune/contribute/sanitize.js";

// ---------------------------------------------------------------------------
// Runtime token builders — avoids literal secrets in source code
// ---------------------------------------------------------------------------
const fake = {
  openai: `sk-${"abc123def456ghi789jkl012mno"}`,
  ghPat: `ghp_${"A".repeat(36)}`,
  ghOauth: `gho_${"A".repeat(36)}`,
  ghFine: `github_pat_${"A".repeat(22)}`,
  awsAkia: `AKIA${"IOSFODNN7EXAMPLE"}`,
  awsAsia: `ASIA${"IOSFODNN7EXAMPLE"}`,
  slackBot: ["xoxb", "000000000000", "0000000000000", "abcdefghijklmnopqrstuvwx"].join("-"),
  jwt: ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"].join("."),
  npm: `npm_${"A".repeat(36)}`,
  pypi: `pypi-${"A".repeat(40)}`,
  gcp: `AIzaSyB${"x".repeat(35)}`,
  stripeLive: `sk_live_${"a1b2c3d4e5f6g7h8i9j0klmn"}`,
  stripeTest: `sk_test_${"a1b2c3d4e5f6g7h8i9j0klmn"}`,
  stripePub: `pk_live_${"a1b2c3d4e5f6g7h8i9j0klmn"}`,
  twilio: `SK${"0123456789abcdef".repeat(2)}`,
  sendgrid: `SG.${"a".repeat(22)}.${"A".repeat(43)}`,
  mailgun: `key-${"0123456789abcdef".repeat(2)}`,
  discord: `https://discord.com/api/webhooks/123456789012345678/${"abcdefABCDEF_-".repeat(2)}`,
  slackHook: `https://hooks.slack.com/services/T${"0".repeat(8)}/B${"0".repeat(8)}/${"X".repeat(24)}`,
  anthropic: `sk-ant-api03-${"abcdefghijklmnopqrstuvwx"}`,
  azure: `DefaultEndpointsProtocol=https;AccountName=testaccount;AccountKey=abc123+def456/ghi=`,
  sshRsa: `ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQC0g${"ABCDEFx".repeat(8)} user@host`,
  sshEd: `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA${"ABCDEFGHIJKLMNOP".repeat(3)} user@host`,
  bearer: `Bearer ${"a1b2c3d4e5f6g7h8i9j0k1l2"}`,
  basicAuth: `https://admin:s3cret@api.example.com/v1/data`,
  postgres: `postgresql://user:p4ssw0rd@db.example.com:5432/mydb`,
  mongo: `mongodb+srv://admin:secret@cluster0.abc123.mongodb.net/test`,
  redis: `redis://default:mysecretpassword@redis.example.com:6379/0`,
  mysql: `mysql://root:password123@localhost:3306/myapp`,
  amqp: `amqp://user:pass@broker.example.com:5672/vhost`,
};

// ---------------------------------------------------------------------------
// Helper: apply all SECRET_PATTERNS to a string (mirrors sanitizeSecrets)
// ---------------------------------------------------------------------------
function applyPatterns(text: string): string {
  let result = text;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(new RegExp(pattern.source, pattern.flags), "[SECRET]");
  }
  return result;
}

// ---------------------------------------------------------------------------
// Pattern coverage tests
// ---------------------------------------------------------------------------
describe("SECRET_PATTERNS coverage", () => {
  it("should have at least 25 patterns (expanded from 11)", () => {
    expect(SECRET_PATTERNS.length).toBeGreaterThanOrEqual(25);
  });

  // -- Original patterns (regression) --

  it("redacts OpenAI API key", () => {
    expect(applyPatterns(`key: ${fake.openai}`)).toContain("[SECRET]");
  });

  it("redacts GitHub personal access token", () => {
    expect(applyPatterns(`token: ${fake.ghPat}`)).toContain("[SECRET]");
  });

  it("redacts GitHub OAuth token", () => {
    expect(applyPatterns(`token: ${fake.ghOauth}`)).toContain("[SECRET]");
  });

  it("redacts GitHub fine-grained PAT", () => {
    expect(applyPatterns(`token: ${fake.ghFine}`)).toContain("[SECRET]");
  });

  it("redacts AWS access key ID (AKIA)", () => {
    expect(applyPatterns(`aws_key: ${fake.awsAkia}`)).toContain("[SECRET]");
  });

  it("redacts Slack bot token", () => {
    expect(applyPatterns(`token: ${fake.slackBot}`)).toContain("[SECRET]");
  });

  it("redacts JWT", () => {
    expect(applyPatterns(`auth: ${fake.jwt}`)).toContain("[SECRET]");
  });

  it("redacts npm token", () => {
    expect(applyPatterns(`token: ${fake.npm}`)).toContain("[SECRET]");
  });

  it("redacts PyPI token", () => {
    expect(applyPatterns(`token: ${fake.pypi}`)).toContain("[SECRET]");
  });

  // -- New patterns --

  it("redacts private key block (RSA)", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...";
    expect(applyPatterns(pem)).toContain("[SECRET]");
  });

  it("redacts private key block (generic)", () => {
    const pem = "-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBg...";
    expect(applyPatterns(pem)).toContain("[SECRET]");
  });

  it("redacts private key block (EC)", () => {
    const pem = "-----BEGIN EC PRIVATE KEY-----\nMHQCAQEE...";
    expect(applyPatterns(pem)).toContain("[SECRET]");
  });

  it("redacts private key block (OPENSSH)", () => {
    const pem = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNz...";
    expect(applyPatterns(pem)).toContain("[SECRET]");
  });

  it("redacts PostgreSQL connection URI", () => {
    expect(applyPatterns(fake.postgres)).toContain("[SECRET]");
  });

  it("redacts MongoDB connection URI", () => {
    expect(applyPatterns(fake.mongo)).toContain("[SECRET]");
  });

  it("redacts Redis connection URI", () => {
    expect(applyPatterns(fake.redis)).toContain("[SECRET]");
  });

  it("redacts MySQL connection URI", () => {
    expect(applyPatterns(fake.mysql)).toContain("[SECRET]");
  });

  it("redacts AWS temporary credentials (ASIA prefix)", () => {
    expect(applyPatterns(`aws_key: ${fake.awsAsia}`)).toContain("[SECRET]");
  });

  it("redacts Google API key", () => {
    expect(applyPatterns(`key: ${fake.gcp}`)).toContain("[SECRET]");
  });

  it("redacts Stripe secret key (live)", () => {
    expect(applyPatterns(`key: ${fake.stripeLive}`)).toContain("[SECRET]");
  });

  it("redacts Stripe secret key (test)", () => {
    expect(applyPatterns(`key: ${fake.stripeTest}`)).toContain("[SECRET]");
  });

  it("redacts Stripe publishable key", () => {
    expect(applyPatterns(`key: ${fake.stripePub}`)).toContain("[SECRET]");
  });

  it("redacts Twilio API key", () => {
    expect(applyPatterns(`key: ${fake.twilio}`)).toContain("[SECRET]");
  });

  it("redacts SendGrid API key", () => {
    expect(applyPatterns(`key: ${fake.sendgrid}`)).toContain("[SECRET]");
  });

  it("redacts Mailgun API key", () => {
    expect(applyPatterns(`key: ${fake.mailgun}`)).toContain("[SECRET]");
  });

  it("redacts Discord webhook URL", () => {
    expect(applyPatterns(fake.discord)).toContain("[SECRET]");
  });

  it("redacts Slack webhook URL", () => {
    expect(applyPatterns(fake.slackHook)).toContain("[SECRET]");
  });

  it("redacts Anthropic API key", () => {
    expect(applyPatterns(`key: ${fake.anthropic}`)).toContain("[SECRET]");
  });

  it("redacts Azure connection string", () => {
    expect(applyPatterns(fake.azure)).toContain("[SECRET]");
  });

  it("redacts SSH RSA public key", () => {
    expect(applyPatterns(fake.sshRsa)).toContain("[SECRET]");
  });

  it("redacts SSH ed25519 key", () => {
    expect(applyPatterns(fake.sshEd)).toContain("[SECRET]");
  });

  it("redacts Bearer token in header", () => {
    expect(applyPatterns(`Authorization: ${fake.bearer}`)).toContain("[SECRET]");
  });

  it("redacts basic auth in URL", () => {
    expect(applyPatterns(fake.basicAuth)).toContain("[SECRET]");
  });

  it("redacts long hex strings (64+ chars, likely secrets)", () => {
    const hex = "a".repeat(64);
    expect(applyPatterns(`secret: ${hex}`)).toContain("[SECRET]");
  });

  it("redacts AMQP connection URI", () => {
    expect(applyPatterns(fake.amqp)).toContain("[SECRET]");
  });

  // -- False positive tests --

  it("does NOT redact normal code text", () => {
    const code = "const result = await fetch('/api/users');\nconsole.log(result.status);";
    expect(applyPatterns(code)).toBe(code);
  });

  it("does NOT redact short hex strings", () => {
    const text = "commit abc123def";
    expect(applyPatterns(text)).toBe(text);
  });

  it("does NOT redact UUIDs (handled separately by UUID pattern)", () => {
    const text = "session: 550e8400-e29b-41d4-a716-446655440000";
    // UUID should NOT be caught by SECRET_PATTERNS (it's a separate concern)
    expect(applyPatterns(text)).toBe(text);
  });

  it("does NOT redact normal function names", () => {
    const text = "function handleUserLogin() { return true; }";
    expect(applyPatterns(text)).toBe(text);
  });
});

// ---------------------------------------------------------------------------
// sanitizeSecrets() tests
// ---------------------------------------------------------------------------
describe("sanitizeSecrets", () => {
  it("redacts multiple secrets in one string", () => {
    const input = `AWS key ${fake.awsAkia} with token ${fake.stripeLive}`;
    const result = sanitizeSecrets(input);
    expect(result).not.toContain("IOSFODNN7EXAMPLE");
    expect(result).not.toContain("a1b2c3d4e5f6g7h8i9j0klmn");
    expect(result).toContain("[SECRET]");
  });

  it("returns empty string unchanged", () => {
    expect(sanitizeSecrets("")).toBe("");
  });

  it("returns non-secret text unchanged", () => {
    const text = "This is a normal message about deploying to production.";
    expect(sanitizeSecrets(text)).toBe(text);
  });
});

// ---------------------------------------------------------------------------
// redactSecretsDeep() tests
// ---------------------------------------------------------------------------
describe("redactSecretsDeep", () => {
  it("redacts secrets in nested objects", () => {
    const obj = {
      config: {
        apiKey: fake.stripeLive,
        dbUrl: fake.postgres,
      },
      name: "safe string",
    };
    const result = redactSecretsDeep(obj);
    expect(result.config.apiKey).toContain("[SECRET]");
    expect(result.config.dbUrl).toContain("[SECRET]");
    expect(result.name).toBe("safe string");
  });

  it("redacts secrets in arrays", () => {
    const arr = ["normal text", `key: ${fake.awsAkia}`, "also normal"];
    const result = redactSecretsDeep(arr);
    expect(result[0]).toBe("normal text");
    expect(result[1]).toContain("[SECRET]");
    expect(result[2]).toBe("also normal");
  });

  it("handles deeply nested structures", () => {
    const deep = {
      level1: {
        level2: {
          level3: {
            secret: fake.ghPat,
          },
        },
      },
    };
    const result = redactSecretsDeep(deep);
    expect(result.level1.level2.level3.secret).toContain("[SECRET]");
  });

  it("passes through numbers unchanged", () => {
    expect(redactSecretsDeep(42)).toBe(42);
  });

  it("passes through booleans unchanged", () => {
    expect(redactSecretsDeep(true)).toBe(true);
  });

  it("passes through null unchanged", () => {
    expect(redactSecretsDeep(null)).toBe(null);
  });

  it("passes through undefined unchanged", () => {
    expect(redactSecretsDeep(undefined)).toBe(undefined);
  });

  it("passes through Date unchanged", () => {
    const date = new Date("2026-01-01");
    expect(redactSecretsDeep(date)).toBe(date);
  });

  it("does not mutate the original object", () => {
    const original = { key: fake.stripeLive };
    const result = redactSecretsDeep(original);
    expect(original.key).toBe(fake.stripeLive);
    expect(result.key).toContain("[SECRET]");
  });
});
