// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const skillUsageModelsPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'skill_usage_models.local.json');

function configuredOpenAiModel() {
  if (process.env.PAD_SKILL_USAGE_OPENAI_MODEL) return process.env.PAD_SKILL_USAGE_OPENAI_MODEL;
  if (existsSync(skillUsageModelsPath)) {
    const parsed = JSON.parse(readFileSync(skillUsageModelsPath, 'utf8'));
    if (typeof parsed.openaiModel === 'string' && parsed.openaiModel) return parsed.openaiModel;
  }
  throw new Error('OpenAI skill-usage model is not configured');
}

export function createAsker(provider, { fetcher = fetch, openaiKey = process.env.OPENAI_API_KEY,
  jevKey = process.env.TYPESAFE_API_KEY } = {}) {
  if (!['openai', 'jev'].includes(provider)) throw new Error('Unknown decisions provider');
  const key = provider === 'openai' ? openaiKey : jevKey;
  if (!key) throw new Error(`${provider} credential unavailable`);
  return {
    async ask(state, questions) {
      const openai = provider === 'openai';
      const evidence = JSON.parse(state);
      const body = openai ? { model: configuredOpenAiModel(), input: [{ role: 'user', content: [
        { type: 'input_json', data: evidence },
      ] }], questions } : {
        model: 'jev-latest', state: evidence,
        questions: Object.fromEntries(questions.map(({ name, instructions }) => [name, { type: 'noul', instructions }])) };
      const response = await fetcher(openai ? 'https://api.openai.com/v1/decisions' :
        'https://api.typesafe.ai/v1/systemone', { method: 'POST', headers: {
          authorization: `Bearer ${key}`, 'content-type': 'application/json',
        }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error(`${provider} decisions HTTP ${response.status}`);
      const data = await response.json();
      const answers = new Map();
      if (openai) {
        if (!Array.isArray(data.answers) || data.answers.length !== questions.length) throw new Error('Incomplete OpenAI answers');
        for (const answer of data.answers) {
          if (answer.type !== 'predicate' || typeof answer.name !== 'string' ||
              !Number.isFinite(answer.probability) || answer.probability < 0 || answer.probability > 1) {
            throw new Error(`Invalid OpenAI predicate answer ${String(answer.name).slice(0, 30)}`);
          }
          if (answers.has(answer.name)) throw new Error('Duplicate OpenAI answer');
          answers.set(answer.name, answer.probability);
        }
      } else {
        if (!data.answers || typeof data.answers !== 'object') throw new Error('Missing Jev answers');
        for (const [name, answer] of Object.entries(data.answers)) answers.set(name, answer.noul);
      }
      if (questions.some((question) => !answers.has(question.name))) throw new Error('Missing question answer');
      return answers;
    },
  };
}
