/**
 * PINNED reference-design entries (`status: reference`). A reference entry is part of the starter's
 * code: it never expires and takes no approver or approval digest. So that this cannot become a
 * way around those controls, only the entries listed here may be reference entries, each with
 * the SHA-256 of its exact content (`entryDigest` of the entry as written in the YAML, the same
 * digest as `approval-digests`). A reference entry that is not listed, or whose content no longer
 * matches (a wider resource, another environment, any edit), fails with UNPINNED_REFERENCE_ENTRY at
 * synth and in `check-exceptions`.
 *
 * Changing this list is a change to the policy source code, reviewed like any other. A project adds
 * its own deviations as dated project entries (no `status`) instead: they expire, need an approver
 * for critical rules and can be approved by digest (docs/policy-as-code.md).
 */
import { entryDigest } from './digest.js';

export const REFERENCE_ENTRY_DIGESTS: Readonly<Record<string, string>> = {
  'EXC-0005': '735c8dcdc825271fb640f4419236dd299af7b42c46767154b68f2cc36dddebda',
  'SUP-0001': '61c7a7908b1f054fad5829a99fcc2ddcd2ef8430085ea1b56872cc411cf22a50',
  'SUP-0002': '4235e19d50814e0633a69802ddeccdeeb2a28b78a841ddcbc9f46f64d5db325f',
  'SUP-0003': '910adf7a7240b523b018cc24db62efb15b748b43a74173bdc43f2cf2e51cb803',
  'SUP-0004': '3865969dc376e30a1684803d245a521e36c373b821af75b20bb1d318ac63c675',
  'SUP-0200': '9ea7765b1a2ac595104e30e53a5152d3ac12c062835e031f886aec4bd93213e2',
  'SUP-0201': '526b76c9af282f8ac19349b0ed0613b2469b43abc69e44bbe98d0f27ac53f3af',
  'SUP-0202': '1df63861a73bbc2e1a458ebb4d9e7454f2e82f79b7c6198fea9788936c9bc21e',
  'SUP-0203': '2e76140ef45d2102546dfad67505d8f977a2bdd6880e4f425dbdc0144436fd76',
  'SUP-0005': '8688eb8d6da796d9f825eab99b793d899492484e2177f38339f3108b42f65568',
  'SUP-0006': '35a0fa6f35e9ce1643bee61997a8ce1d2c38b180aeb89a6d1a1b95f723504c60',
  'SUP-0007': 'f3db595b7a6576e45d1044878a447d5b905c6697d089b97dc726de6c5f70ad1d',
  'SUP-0008': 'bb03f66e97520098f0b50032f64bb3e6590ee255a945bffd1218f69a3f02d460',
  'SUP-0009': 'bf70a2fab71e11f6708cec83ee351d3afca5245177aab9b45ad2ad521fc98708',
  'SUP-0010': '7331a8abd7bda9d757d71c6d1990166bc7f83a3a8be311aec61613639cf4ae18',
  'SUP-0012': 'f09a017a4dedca355a971053bf003783031fdf99d32c1af2065969fb0ee3ff72',
  'SUP-0013': 'dce7888390d1e8928c4fc606053b40a29c2367625abf48cbcc14fd2852c7cd9a',
  'SUP-0014': 'ef01851e8e5f7251c3b99867fad60e4c17e286e8861d340459dde11ce4a6b162',
  'SUP-0015': '5cf9949059b7fa812e1061ff75f2e232f5af3acfc26f091de528368aa2d3b86a',
  'SUP-0016': 'cc25279a798012601a7a4faacd15f5b8fbb48a1f143574b8df6e3f5390181cc9',
  'SUP-0017': 'f7b9aad74dc4dab016b87787c8727089e5e148168940a824fa13557f66831ea0',
  'SUP-0300': '6f291ee6119e0b20ccddffdebbace814f6101f9cd013a97d17256e44da900fa1',
  'SUP-0301': 'b4d3733117ec26e1b1f9fda44b01775728d542af72fca14981ba451ce4094e92',
};

/**
 * Why a `status: reference` entry may not be used, or `undefined` when it is pinned with exactly
 * this content. `raw` is the entry as written in the YAML (the digest input).
 */
export function unpinnedReferenceMessage(
  id: string,
  raw: unknown,
  criticalRule: boolean,
): string | undefined {
  const digest = entryDigest(raw);
  const pinned = REFERENCE_ENTRY_DIGESTS[id];
  if (pinned === digest) return undefined;
  const instead =
    'add your own deviation as a dated project entry (no `status`) instead (docs/policy-as-code.md)';
  return pinned
    ? `reference entry differs from its pinned content (sha256 ${digest}): a reference entry is changed only together with policies/src/exceptions/reference-pins.ts; ${instead}`
    : `is not a pinned reference entry${criticalRule ? ' (critical rule: only a pinned reference entry may waive it without an approver)' : ''}; ${instead}`;
}
