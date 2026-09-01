"use strict";

/**
 * Provider boundary for iCode's orchestrator. Providers return an intent plan;
 * they never receive direct filesystem, terminal, database, or session access.
 * A hosted model adapter can implement this same contract later.
 */
class AgentProvider {
  plan() { throw new Error("AgentProvider.plan must be implemented."); }
}

class LocalDeterministicProvider extends AgentProvider {
  plan({ instruction, fileCount }) {
    const text = String(instruction).toLowerCase();
    return {
      scaffold: /\b(build|create|make)\b/.test(text) || fileCount <= 4,
      dashboard: /(dashboard|analytics|admin panel|saas)/.test(text),
      darkMode: /dark mode|dark theme/.test(text),
      contactForm: /contact form|contact us|contact section/.test(text),
    };
  }
}

function createProvider() {
  // A model provider may be selected here through configuration in the future.
  // Local deterministic planning keeps the product functional without secrets.
  return new LocalDeterministicProvider();
}

module.exports = { AgentProvider, LocalDeterministicProvider, createProvider };
