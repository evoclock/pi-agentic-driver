import { fixtureAuthority } from './workflow_runner_authority_fixture.mjs';
const authority = fixtureAuthority(process.env.PAD_TEST_AUTHORITY_REPO, process.env.PAD_TEST_AUTHORITY_STORE);
// The child CLI has no network transport: all routes terminate in this fixture.
globalThis.fetch = async (url, init) => {
  if (new URL(url).origin !== 'https://authority.invalid') throw new Error('unexpected synthetic origin');
  const op = new URL(url).pathname.split('/').at(-1);
  const method = { cancel: 'commitCancel', admit: 'casAdmitEffect', epoch: 'readEpoch', status: 'status' }[op];
  if (!method) return new Response(null, { status: 404 });
  const result = authority[method](init.body ? JSON.parse(init.body) : undefined);
  return new Response(JSON.stringify(result), { status: result.ok ? 200 : 409, headers: { 'Content-Type': 'application/json' } });
};
