import { execFileSync } from 'node:child_process';

const apiUrl = process.env.GITHUB_API_URL ?? 'https://api.github.com';
const token = process.env.GITHUB_TOKEN;
const repository = process.env.GITHUB_REPOSITORY;
const targetSha = process.env.TARGET_SHA;
const waitLimitMs = 30 * 60 * 1000;
const pollIntervalMs = 15 * 1000;

if (!token || !repository || !targetSha) {
  throw new Error('GITHUB_TOKEN, GITHUB_REPOSITORY, and TARGET_SHA are required.');
}
if (!/^[0-9a-f]{40}$/i.test(targetSha)) {
  throw new Error(`TARGET_SHA is not a full commit SHA: ${targetSha}`);
}

// Keep this list aligned with windows-private-files.yml's push path filter.
const windowsPathMatchers = [
  /^src\//,
  /^test\//,
  /^scripts\//,
  /^tsconfig.*\.json$/,
  /^\.github\/workflows\/windows-private-files\.yml$/,
  /^package\.json$/,
  /^bun\.lock$/,
];

function changedPaths() {
  try {
    return execFileSync('git', ['diff', '--name-only', `${targetSha}^`, targetSha], {
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean);
  } catch (error) {
    throw new Error(
      `Could not inspect the tagged commit's changes against its parent: ${error.message}`,
    );
  }
}

const changedWindowsPaths = changedPaths().filter((path) =>
  windowsPathMatchers.some((matcher) => matcher.test(path)),
);
const windowsRequired = changedWindowsPaths.length > 0;
console.log(`Tagged commit: ${targetSha}`);
if (windowsRequired) {
  console.log(`Windows checks required for: ${changedWindowsPaths.join(', ')}`);
} else {
  console.log('No Windows-filtered paths changed; Windows checks are not required.');
}

const [owner, repo] = repository.split('/');
if (!owner || !repo) {
  throw new Error(`GITHUB_REPOSITORY is not owner/repository: ${repository}`);
}

// A GitHub API error that may clear on its own (a 5xx, a rate limit or a
// dropped connection). The wait loop retries these until its deadline instead
// of failing the release on one bad answer; anything else still fails at once.
class TransientApiError extends Error {}

async function getJson(path) {
  let response;
  try {
    response = await fetch(`${apiUrl}/repos/${owner}/${repo}${path}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
  } catch (error) {
    throw new TransientApiError(`GitHub API ${path} failed: ${error.message}`);
  }
  if (response.status >= 500 || response.status === 429) {
    throw new TransientApiError(
      `GitHub API ${path} returned HTTP ${response.status}`,
    );
  }
  if (!response.ok) {
    const body = (await response.text()).slice(0, 1000);
    throw new Error(`GitHub API ${path} returned HTTP ${response.status}: ${body}`);
  }
  return response.json();
}

// A push run on main, or on a release-* branch (a patch release cut off main,
// which gets the same full catalogue and Windows checks), counts.
async function latestMainPushRun(workflowFile) {
  const query = new URLSearchParams({ head_sha: targetSha, per_page: '100' });
  const result = await getJson(
    `/actions/workflows/${workflowFile}/runs?${query.toString()}`,
  );
  return result.workflow_runs
    .filter(
      (run) =>
        run.head_sha === targetSha &&
        run.event === 'push' &&
        (run.head_branch === 'main' ||
          run.head_branch?.startsWith('release-') === true),
    )
    .sort((left, right) => right.run_number - left.run_number)[0];
}

async function verifyCiJobs(run) {
  const result = await getJson(`/actions/runs/${run.id}/jobs?per_page=100`);
  const jobs = result.jobs;
  const requiredNames = ['check', 'opencode2-placement'];
  const requiredMutationNames = [1, 2, 3, 4].map(
    (shard) => `mutations-main (${shard})`,
  );
  const required = [...requiredNames, ...requiredMutationNames];
  const missing = required.filter((name) => !jobs.some((job) => job.name === name));
  if (missing.length) {
    throw new Error(
      `CI run ${run.id} concluded success but is missing required jobs: ${missing.join(', ')}. Release blocked.`,
    );
  }

  const unsuccessful = jobs.filter(
    (job) => required.includes(job.name) && job.conclusion !== 'success',
  );
  if (unsuccessful.length) {
    const details = unsuccessful
      .map((job) => `${job.name}=${job.conclusion ?? job.status}`)
      .join(', ');
    throw new Error(
      `Required jobs in CI run ${run.id} did not succeed: ${details}. Release blocked.`,
    );
  }
  console.log(`CI run ${run.id}: check, opencode2-placement, and all 4 mutation shards succeeded.`);
}

const deadline = Date.now() + waitLimitMs;
let ciVerified = false;
let windowsVerified = !windowsRequired;
let lastCiState = 'no main-push CI run found for the tagged commit';
let lastWindowsState = windowsRequired
  ? 'no main-push Windows run found for the tagged commit'
  : 'not required';

while (Date.now() < deadline) {
  try {
    await pollOnce();
  } catch (error) {
    if (!(error instanceof TransientApiError)) throw error;
    console.log(`${error.message}; retrying.`);
  }
  if (ciVerified && windowsVerified) {
    console.log('All required checks already passed on the tagged commit.');
    process.exit(0);
  }
  const remaining = deadline - Date.now();
  if (remaining > 0) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollIntervalMs, remaining)));
  }
}

async function pollOnce() {
  if (!ciVerified) {
    const run = await latestMainPushRun('ci.yml');
    if (run) {
      if (run.status === 'completed') {
        if (run.conclusion !== 'success') {
          throw new Error(
            `CI run ${run.id} for ${targetSha} concluded ${run.conclusion ?? 'without a conclusion'}. Release blocked; CI will not be rerun automatically.`,
          );
        }
        await verifyCiJobs(run);
        ciVerified = true;
        lastCiState = `CI run ${run.id} succeeded`;
      } else {
        lastCiState = `CI run ${run.id} is ${run.status}`;
      }
    }
  }

  if (windowsRequired && !windowsVerified) {
    const run = await latestMainPushRun('windows-private-files.yml');
    if (run) {
      if (run.status === 'completed') {
        if (run.conclusion !== 'success') {
          throw new Error(
            `Windows workflow run ${run.id} for ${targetSha} concluded ${run.conclusion ?? 'without a conclusion'}. Release blocked; Windows checks will not be rerun automatically.`,
          );
        }
        windowsVerified = true;
        lastWindowsState = `Windows run ${run.id} succeeded`;
        console.log(lastWindowsState);
      } else {
        lastWindowsState = `Windows run ${run.id} is ${run.status}`;
      }
    }
  }
}

const waitingFor = [
  !ciVerified && `CI (${lastCiState})`,
  !windowsVerified && `Windows checks (${lastWindowsState})`,
]
  .filter(Boolean)
  .join('; ');
throw new Error(
  `Timed out after 30 minutes waiting for required checks on ${targetSha}: ${waitingFor}. Release blocked; no checks were rerun.`,
);
