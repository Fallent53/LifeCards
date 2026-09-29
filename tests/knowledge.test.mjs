import test from "node:test";
import assert from "node:assert/strict";

process.env.LIFECARDS_DB_PATH = "/tmp/lifecards-knowledge-test.sqlite";

const dbmod = await import("../src/database.mjs");

function deterministicRng() {
  let i = 0;
  return {
    int(max) {
      const value = i % max;
      i += 1;
      return value;
    },
    float() {
      return 0.5;
    },
  };
}

test("knowledge question can be created and answered", () => {
  dbmod.resetForTests();
  dbmod.ensureUser("learner", "Learner");

  const question = dbmod.createKnowledgeQuestion("learner", deterministicRng());
  assert.ok(question.id);
  assert.ok(question.prompt);
  assert.ok(question.options.length >= 2);

  const row = dbmod.db.prepare("SELECT correct_option FROM quiz_questions WHERE id = ?").get(question.id);
  const result = dbmod.answerKnowledgeQuestion("learner", question.id, row.correct_option);

  assert.equal(result.correct, true);
  assert.ok(result.pointsEarned > 0);
  assert.ok(result.coinReward > 0);
  assert.equal(result.stats.correctAnswers, 1);
  assert.equal(result.stats.totalAnswers, 1);
});

test("profile exposes collection achievements and knowledge stats", () => {
  const state = dbmod.getState("learner");
  assert.ok(state.profile);
  assert.ok(Array.isArray(state.profile.achievements));
  assert.equal(state.profile.knowledge.correctAnswers, 1);
});
