import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../../service/storage/store.js";

const TEST_DB_DIR = join(import.meta.dir, "../../.test-data");
const TEST_DB_PATH = join(TEST_DB_DIR, "test-store.db");

describe("Store", () => {
  let store: Store;

  beforeAll(() => {
    if (existsSync(TEST_DB_PATH)) rmSync(TEST_DB_PATH);
    store = new Store(TEST_DB_PATH);
  });

  afterAll(() => {
    store.close();
    if (existsSync(TEST_DB_PATH)) rmSync(TEST_DB_PATH);
    if (existsSync(TEST_DB_PATH + "-wal")) rmSync(TEST_DB_PATH + "-wal");
    if (existsSync(TEST_DB_PATH + "-shm")) rmSync(TEST_DB_PATH + "-shm");
  });

  describe("submissions", () => {
    it("inserts and retrieves a submission", () => {
      const id = store.insertSubmission("test-skill", "contrib-1", '{"test": true}', "hash1");
      expect(id).toBeGreaterThan(0);

      const submissions = store.getSubmissionsBySkill("test-skill");
      expect(submissions.length).toBeGreaterThanOrEqual(1);
      expect(submissions[0].skill_name).toBe("test-skill");
      expect(submissions[0].contributor_id).toBe("contrib-1");
    });

    it("counts recent submissions by IP hash", () => {
      store.insertSubmission("skill-2", "contrib-2", '{}', "rate-test-hash");
      const count = store.countRecentSubmissions("rate-test-hash");
      expect(count).toBeGreaterThanOrEqual(1);
    });

    it("returns all unique skill names", () => {
      store.insertSubmission("another-skill", "contrib-3", '{}', "hash3");
      const names = store.getAllSkillNames();
      expect(names).toContain("test-skill");
      expect(names).toContain("another-skill");
    });
  });

  describe("aggregations", () => {
    it("upserts and retrieves aggregation data", () => {
      store.upsertAggregation({
        skill_name: "test-skill",
        weighted_pass_rate: 0.85,
        trend: "up",
        status: "HEALTHY",
        contributor_count: 5,
        session_count: 42,
        last_updated: new Date().toISOString(),
      });

      const agg = store.getAggregation("test-skill");
      expect(agg).not.toBeNull();
      expect(agg!.weighted_pass_rate).toBe(0.85);
      expect(agg!.trend).toBe("up");
      expect(agg!.status).toBe("HEALTHY");
      expect(agg!.contributor_count).toBe(5);
    });

    it("updates existing aggregation on conflict", () => {
      store.upsertAggregation({
        skill_name: "test-skill",
        weighted_pass_rate: 0.90,
        trend: "stable",
        status: "HEALTHY",
        contributor_count: 6,
        session_count: 50,
        last_updated: new Date().toISOString(),
      });

      const agg = store.getAggregation("test-skill");
      expect(agg!.weighted_pass_rate).toBe(0.90);
      expect(agg!.contributor_count).toBe(6);
    });

    it("returns null for unknown skill", () => {
      const agg = store.getAggregation("nonexistent");
      expect(agg).toBeNull();
    });
  });

  describe("audit log", () => {
    it("logs and retrieves audit entries", () => {
      store.logAudit("submission", "New submission from contrib-1");
      const entries = store.getAuditLog(10);
      expect(entries.length).toBeGreaterThanOrEqual(1);
      expect(entries[0].action).toBe("submission");
    });
  });
});
