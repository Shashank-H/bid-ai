import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const PREBID_REFERENCE_VERSION = '11.41.0';
export const PREBID_REFERENCE_SHA256 =
  '19ad77badcbd79c45aed15751139f089059e0d4d6606db89590a306eb0e28ad3';
export const PREBID_REFERENCE_URL =
  'https://unpkg.com/prebid.js@11.41.0/dist/not-for-prod/prebid.js';
export const PREBID_REFERENCE_PATH = join(tmpdir(), 'bid-intelligence-prebid-11.41.0.js');

export function verifyPrebidReference(bytes) {
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    PREBID_REFERENCE_SHA256,
    'Prebid reference bytes do not match the pinned artifact',
  );
}

export async function fetchPrebidReference(path = PREBID_REFERENCE_PATH) {
  try {
    const bytes = await readFile(path);
    verifyPrebidReference(bytes);
    return path;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const response = await fetch(PREBID_REFERENCE_URL, { signal: AbortSignal.timeout(30_000) });
  assert.equal(response.status, 200, 'Could not fetch pinned Prebid browser artifact');
  const bytes = Buffer.from(await response.arrayBuffer());
  verifyPrebidReference(bytes);
  await writeFile(path, bytes, { flag: 'wx' });
  return path;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(await fetchPrebidReference(process.env.PREBID_REFERENCE_PATH));
}
